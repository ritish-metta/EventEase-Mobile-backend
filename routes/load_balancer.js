const express = require('express');
const mongoose = require('mongoose');
const pm2 = require('pm2');
const router = express.Router();

// ═════════════════════════════════════════════════════════════
// WHY THIS FILE CHANGED
//
// In PM2 cluster mode, every worker is a SEPARATE OS process. Each one
// loads this module independently, so plain JS variables like
// `isPaused`, `stats`, `requestWindow`, `currentWorkers`, `scalingLog`
// are NOT shared across workers — each process has its own copy.
//
// That caused two concrete bugs in the previous version:
//   1. POST /pause only set isPaused=true on whichever ONE worker
//      happened to receive that request (PM2 round-robins). Every
//      other worker never saw it and kept serving GET /notes.
//   2. Scale-down required `total >= MIN_SAMPLES` before the low-error
//      streak could increment — but when load actually drops (the
//      exact moment you want to scale down), `total` drops below
//      MIN_SAMPLES too, so the streak got reset to 0 every tick and
//      could never reach the threshold. Workers never spun down.
//
// Fix: MongoDB (already a dependency here) is used as the single
// shared source of truth for pause state, per-worker heartbeats, and
// the scaling log. A lightweight leader-election lease ensures only
// ONE worker process ever calls pm2.scale() at a time, so scaling
// decisions can't race each other.
// ═════════════════════════════════════════════════════════════

// ── Identify this process within the cluster ───────────────────
const workerId = process.env.NODE_APP_INSTANCE || '0'; // PM2 sets this in cluster mode
const pid = process.pid;

// ─────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────
const loadBalancerNoteSchema = new mongoose.Schema({
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});
const LoadBalancerNote =
  mongoose.models.LoadBalancerNote ||
  mongoose.model('LoadBalancerNote', loadBalancerNoteSchema);

// Single shared document all workers read/write for cluster-wide state.
const clusterStateSchema = new mongoose.Schema({
  _id: { type: String, default: 'singleton' },
  isPaused: { type: Boolean, default: false },
  currentWorkers: { type: Number, default: 1 },
  leaderId: { type: String, default: null },
  leaderExpiresAt: { type: Date, default: null },
  forceScaleDown: { type: Boolean, default: false }, // set on Stop — bypasses the streak wait entirely
  scalingLog: [{ time: Date, message: String, workers: Number }],
});
const ClusterState =
  mongoose.models.LbClusterState ||
  mongoose.model('LbClusterState', clusterStateSchema);

// One doc per worker process — this is what powers the per-worker
// boxes on the dashboard (how many requests THIS worker is handling).
const workerHeartbeatSchema = new mongoose.Schema({
  workerId: { type: String, required: true, unique: true },
  pid: Number,
  totalHandled: { type: Number, default: 0 },
  totalErrors: { type: Number, default: 0 },
  rps: { type: Number, default: 0 },
  errorRatePct: { type: Number, default: 0 },
  lastSeen: { type: Date, default: Date.now },
});
const WorkerHeartbeat =
  mongoose.models.LbWorkerHeartbeat ||
  mongoose.model('LbWorkerHeartbeat', workerHeartbeatSchema);

// ─────────────────────────────────────────────
// Local (per-process) state — used only to compute THIS worker's
// own rps/error-rate before publishing a heartbeat to Mongo.
// ─────────────────────────────────────────────
let stats = { totalRequests: 0, postCount: 0, getCount: 0, errorCount: 0, startedAt: null, lastRequestAt: null };
let localRequestWindow = []; // [{ time, ok }]
let isPaused = false;        // refreshed from Mongo every REFRESH_MS — fast local read on hot path
let isLeader = false;        // only the elected leader calls pm2.scale()

const WINDOW_MS = 5000;
const ERROR_RATE_HIGH = 0.2;
const ERROR_RATE_LOW = 0.05;
const STREAK_NEEDED = 5;
const MIN_SAMPLES = 10;
const RPS_HIGH = 50;
const RPS_LOW = 10;
const MIN_WORKERS = 1;
const MAX_WORKERS = 8;
const HEARTBEAT_STALE_MS = 4000; // a worker not heard from in 4s is treated as gone

// leader-only streak counters (only meaningful on whichever process is currently leader)
let highErrorStreak = 0, lowErrorStreak = 0, highRpsStreak = 0, lowRpsStreak = 0;
let isScaling = false;
let scalingStartedAt = null; // watchdog: if a scale op never completes, don't stay stuck forever
const SCALE_WATCHDOG_MS = 8000;

const touchStats = () => {
  stats.totalRequests += 1;
  stats.lastRequestAt = new Date();
  if (!stats.startedAt) stats.startedAt = new Date();
};

const recordRequest = (ok) => {
  localRequestWindow.push({ time: Date.now(), ok });
};

// ─────────────────────────────────────────────
// PM2 process resolution (kept from original — this part was fine)
// ─────────────────────────────────────────────
const PM2_APP_NAME_CONFIGURED = process.env.PM2_APP_NAME || 'eventease_backend';
let resolvedAppName = PM2_APP_NAME_CONFIGURED;
let appNameResolved = false;

function resolvePm2Process(list) {
  const mainFile = require.main && require.main.filename;
  let match = list.find(p => p.name === PM2_APP_NAME_CONFIGURED);
  if (match) return match;
  if (mainFile) {
    match = list.find(p => p.pm2_env && p.pm2_env.pm_exec_path === mainFile);
    if (match) return match;
  }
  match = list.find(p => p.pm2_env && p.pm2_env.exec_mode === 'cluster_mode');
  return match || null;
}

function logPm2Diagnostics() {
  pm2.connect((err) => {
    if (err) {
      console.log(`⚠️  [worker ${workerId}] PM2 diagnostic check failed to connect: ${err.message}`);
      console.log('⚠️  Is this app actually running under `pm2 start`? If launched with plain `node` or `nodemon`, scaling cannot work.');
      return;
    }
    pm2.list((listErr, list) => {
      pm2.disconnect();
      if (listErr) {
        console.log(`⚠️  [worker ${workerId}] PM2 diagnostic list failed: ${listErr.message}`);
        return;
      }
      const names = list.map(p => `${p.name} (${p.pm2_env.exec_mode})`);
      console.log(`🔎 [worker ${workerId}/pid ${pid}] PM2 processes visible: ${names.length ? names.join(', ') : 'none'}`);

      const match = resolvePm2Process(list);
      if (!match) {
        console.log('❌ No usable PM2 process found — is this running under `pm2 start -i <n>`? Auto-scaling will do nothing until it is.');
        return;
      }
      if (match.pm2_env.exec_mode !== 'cluster_mode') {
        console.log(`❌ Process "${match.name}" is in "${match.pm2_env.exec_mode}" mode, not cluster mode — pm2.scale() only works in cluster mode. Restart with: pm2 start app.js -i 1 --name ${PM2_APP_NAME_CONFIGURED}`);
        return;
      }
      resolvedAppName = match.name;
      appNameResolved = true;
      if (match.name !== PM2_APP_NAME_CONFIGURED) {
        console.log(`⚠️  Configured name "${PM2_APP_NAME_CONFIGURED}" didn't match — auto-corrected to "${match.name}".`);
      }
      console.log(`✅ [worker ${workerId}] Using PM2 process "${resolvedAppName}" in cluster mode — auto-scaling ready.`);
    });
  });
}
logPm2Diagnostics();

function scaleTo(targetWorkers) {
  targetWorkers = Math.max(MIN_WORKERS, Math.min(MAX_WORKERS, targetWorkers));
  if (isScaling) {
    // Watchdog: a scale operation that's been "in progress" longer than
    // SCALE_WATCHDOG_MS is almost certainly a hung pm2 IPC call, not a
    // real in-flight scale. Don't let that wedge the cluster forever.
    if (scalingStartedAt && Date.now() - scalingStartedAt > SCALE_WATCHDOG_MS) {
      console.log('⚠️  Scaling watchdog fired — previous scale op never completed, resetting lock.');
      isScaling = false;
    } else {
      return;
    }
  }
  isScaling = true;
  scalingStartedAt = Date.now();
  const direction = targetWorkers > MAX_WORKERS ? 'UP' : (targetWorkers < MIN_WORKERS ? 'DOWN' : (targetWorkers > 0 ? 'UP' : 'DOWN'));

  pm2.connect((err) => {
    if (err) {
      console.log('❌ PM2 connect failed: ' + err.message);
      isScaling = false;
      scalingStartedAt = null;
      return;
    }
    pm2.scale(resolvedAppName, targetWorkers, async (scaleErr) => {
      if (scaleErr && /not found/i.test(scaleErr.message)) {
        pm2.list(async (listErr, list) => {
          if (listErr || !list) {
            pm2.disconnect();
            isScaling = false;
            scalingStartedAt = null;
            console.log('❌ PM2 re-check failed: ' + (listErr ? listErr.message : 'no list'));
            return;
          }
          const match = resolvePm2Process(list);
          if (!match) {
            pm2.disconnect();
            isScaling = false;
            scalingStartedAt = null;
            console.log('❌ Still no matching PM2 process — cannot scale.');
            await pushScalingLog(`Scale ${direction} to ${targetWorkers} FAILED: app not found`, targetWorkers);
            return;
          }
          resolvedAppName = match.name;
          pm2.scale(resolvedAppName, targetWorkers, async (retryErr) => {
            pm2.disconnect();
            isScaling = false;
            scalingStartedAt = null;
            if (retryErr) {
              console.log('❌ PM2 scale retry failed: ' + retryErr.message);
              await pushScalingLog(`Scale ${direction} to ${targetWorkers} FAILED: ${retryErr.message}`, targetWorkers);
              return;
            }
            console.log(`${direction === 'UP' ? '📈' : '📉'} Scaled ${direction} to ${targetWorkers} workers (after name correction)`);
            await pushScalingLog(`Scaled ${direction} to ${targetWorkers} workers`, targetWorkers);
            await ClusterState.updateOne({ _id: 'singleton' }, { $set: { currentWorkers: targetWorkers } });
          });
        });
        return;
      }

      pm2.disconnect();
      isScaling = false;
      scalingStartedAt = null;
      if (scaleErr) {
        console.log('❌ PM2 scale failed: ' + scaleErr.message);
        await pushScalingLog(`Scale ${direction} to ${targetWorkers} FAILED: ${scaleErr.message}`, targetWorkers);
        return;
      }
      console.log(`${direction === 'UP' ? '📈' : '📉'} Scaled ${direction} to ${targetWorkers} workers`);
      await pushScalingLog(`Scaled ${direction} to ${targetWorkers} workers`, targetWorkers);
      await ClusterState.updateOne({ _id: 'singleton' }, { $set: { currentWorkers: targetWorkers } });
    });
  });
}

async function pushScalingLog(message, workers) {
  try {
    await ClusterState.updateOne(
      { _id: 'singleton' },
      { $push: { scalingLog: { $each: [{ time: new Date(), message, workers }], $position: 0, $slice: 20 } } },
      { upsert: true }
    );
  } catch (e) {
    console.log('⚠️  Failed to write scaling log: ' + e.message);
  }
}

// ─────────────────────────────────────────────
// Leader election — a short-lived lease in Mongo. Whichever worker
// holds an unexpired lease is the only one allowed to call
// pm2.scale(). If the leader process dies, its lease simply expires
// and another worker picks it up within ~2-4s. No single point of
// failure, no extra infra beyond Mongo.
// ─────────────────────────────────────────────
async function tryBecomeLeader() {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 4000);
  try {
    const result = await ClusterState.findOneAndUpdate(
      {
        _id: 'singleton',
        $or: [
          { leaderId: null },
          { leaderExpiresAt: { $lt: now } },
          { leaderId: workerId },
        ],
      },
      { $set: { leaderId: workerId, leaderExpiresAt: expiresAt }, $setOnInsert: { isPaused: false, currentWorkers: MIN_WORKERS, scalingLog: [] } },
      { new: true, upsert: true }
    );
    isLeader = !!(result && result.leaderId === workerId);
  } catch (e) {
    console.log(`⚠️  [worker ${workerId}] leader election check failed: ${e.message}`);
    isLeader = false;
  }
}
setInterval(tryBecomeLeader, 2000);
tryBecomeLeader();

// ─────────────────────────────────────────────
// Refresh local isPaused from the shared Mongo doc. Reading Mongo on
// every single GET /notes would add latency, so instead we poll the
// shared flag every 300ms into a local variable and read THAT on the
// hot path. Worst case, a Stop takes ~300ms to reach every worker —
// vastly better than "never" (the old bug).
// ─────────────────────────────────────────────
async function refreshPauseFlag() {
  try {
    const doc = await ClusterState.findById('singleton').select('isPaused').lean();
    isPaused = !!(doc && doc.isPaused);
  } catch (e) {
    // If Mongo hiccups, fail safe by keeping the last known value.
  }
}
setInterval(refreshPauseFlag, 300);
refreshPauseFlag();

// ─────────────────────────────────────────────
// Publish this worker's own heartbeat every second: its own rps,
// error rate, and totals. This is what the dashboard renders as one
// box per worker.
// ─────────────────────────────────────────────
let heartbeatInFlight = false;
async function publishHeartbeat() {
  if (heartbeatInFlight) return;
  heartbeatInFlight = true;
  const now = Date.now();
  localRequestWindow = localRequestWindow.filter(e => now - e.time <= WINDOW_MS);
  const total = localRequestWindow.length;
  const errors = localRequestWindow.filter(e => !e.ok).length;
  const errorRatePct = total > 0 ? Number(((errors / total) * 100).toFixed(1)) : 0;
  const rps = Number((total / (WINDOW_MS / 1000)).toFixed(1));

  try {
    await WorkerHeartbeat.findOneAndUpdate(
      { workerId },
      {
        $set: {
          pid,
          totalHandled: stats.totalRequests,
          totalErrors: stats.errorCount,
          rps,
          errorRatePct,
          lastSeen: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (e) {
    console.log(`⚠️  [worker ${workerId}] heartbeat publish failed: ${e.message}`);
  } finally {
    heartbeatInFlight = false;
  }
}
setInterval(publishHeartbeat, 1000);

// ─────────────────────────────────────────────
// Cluster-wide scaling decision — runs in every worker, but only the
// elected leader is allowed to actually call scaleTo(). It aggregates
// ALL workers' live heartbeats (not just its own) so the decision
// reflects true cluster load, not one process's slice of it.
//
// FIX (scale-down deadlock): scale-down previously required BOTH a
// low error-rate streak AND a low-rps streak, and the error-rate
// streak was gated behind MIN_SAMPLES — which is never satisfied once
// traffic actually drops. Scale-down now only depends on sustained low
// traffic (lowRpsStreak). Scale-up still considers both error rate and
// raw traffic, since either can indicate overload.
// ─────────────────────────────────────────────
let scalingTickInFlight = false; // reentrancy guard — don't let a slow Mongo round-trip cause overlapping ticks

setInterval(async () => {
  if (!isLeader || scalingTickInFlight) return;
  scalingTickInFlight = true;
  try {

  // ── Immediate hard stop: Stop was pressed, snap straight to MIN_WORKERS
  // instead of waiting for the usual sustained-low-traffic streak. ──
  let clusterDoc;
  try {
    clusterDoc = await ClusterState.findById('singleton').select('currentWorkers forceScaleDown').lean();
  } catch (e) { clusterDoc = null; }

  if (clusterDoc && clusterDoc.forceScaleDown && clusterDoc.currentWorkers > MIN_WORKERS && !isScaling) {
    console.log(`🛑 [leader ${workerId}] Force scale-down requested (Stop pressed) — snapping to ${MIN_WORKERS} worker(s) immediately`);
    scaleTo(MIN_WORKERS);
    highErrorStreak = 0; lowErrorStreak = 0; highRpsStreak = 0; lowRpsStreak = 0;
    await ClusterState.updateOne({ _id: 'singleton' }, { $set: { forceScaleDown: false } });
    return;
  }

  let heartbeats;
  try {
    const staleCutoff = new Date(Date.now() - HEARTBEAT_STALE_MS);
    heartbeats = await WorkerHeartbeat.find({ lastSeen: { $gte: staleCutoff } }).lean();
  } catch (e) {
    console.log('⚠️  Leader failed to read heartbeats: ' + e.message);
    return;
  }
  if (!heartbeats || heartbeats.length === 0) return;

  const totalRps = heartbeats.reduce((sum, h) => sum + (h.rps || 0), 0);
  const totalHandled = heartbeats.reduce((sum, h) => sum + (h.totalHandled || 0), 0);
  const weightedErrorSum = heartbeats.reduce((sum, h) => sum + (h.errorRatePct || 0) * (h.rps || 0), 0);
  const clusterErrorRate = totalRps > 0 ? weightedErrorSum / totalRps / 100 : 0;
  const approxSamples = Math.round(totalRps * (WINDOW_MS / 1000));

  if (approxSamples >= MIN_SAMPLES && clusterErrorRate >= ERROR_RATE_HIGH) highErrorStreak++; else highErrorStreak = 0;
  if (totalRps >= RPS_HIGH) highRpsStreak++; else highRpsStreak = 0;
  if (totalRps <= RPS_LOW) lowRpsStreak++; else lowRpsStreak = 0;
  if (approxSamples >= MIN_SAMPLES && clusterErrorRate <= ERROR_RATE_LOW) lowErrorStreak++; else lowErrorStreak = 0;

  let currentWorkers = MIN_WORKERS;
  try {
    const cs = await ClusterState.findById('singleton').select('currentWorkers').lean();
    if (cs && cs.currentWorkers) currentWorkers = cs.currentWorkers;
  } catch (e) { /* keep default */ }

  const shouldScaleUp =
    (highErrorStreak >= STREAK_NEEDED || highRpsStreak >= STREAK_NEEDED) &&
    currentWorkers < MAX_WORKERS && !isScaling;

  // scale-down now depends only on sustained low traffic — this is
  // what actually fixes "it doesn't stop what's not being used"
  const shouldScaleDown =
    lowRpsStreak >= STREAK_NEEDED &&
    currentWorkers > MIN_WORKERS && !isScaling;

  if (shouldScaleUp) {
    const reason = highErrorStreak >= STREAK_NEEDED ? `error rate ${Math.round(clusterErrorRate * 100)}%` : `traffic ${totalRps.toFixed(1)} req/s`;
    console.log(`🔥 [leader ${workerId}] Sustained load (${reason}) — scaling up`);
    scaleTo(currentWorkers + 1);
    highErrorStreak = 0; highRpsStreak = 0;
  } else if (shouldScaleDown) {
    console.log(`🧊 [leader ${workerId}] Load idle (${totalRps.toFixed(1)} req/s) for ${STREAK_NEEDED}s — scaling down`);
    scaleTo(currentWorkers - 1);
    lowRpsStreak = 0;
  }

  // Clean up heartbeats for workers that were scaled down and are gone.
  try {
    await WorkerHeartbeat.deleteMany({ lastSeen: { $lt: new Date(Date.now() - HEARTBEAT_STALE_MS * 3) } });
  } catch (e) { /* best-effort cleanup */ }

  } finally {
    scalingTickInFlight = false;
  }
}, 1000);

// ─────────────────────────────────────────────
// POST /api/load-balancer/notes
// ─────────────────────────────────────────────
router.post('/notes', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) {
      recordRequest(false);
      return res.status(400).json({ success: false, message: 'text is required' });
    }
    const note = await LoadBalancerNote.create({ text });
    touchStats();
    stats.postCount += 1;
    recordRequest(true);
    res.status(200).json({ success: true, note });
  } catch (err) {
    stats.errorCount += 1;
    recordRequest(false);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/load-balancer/notes
// ─────────────────────────────────────────────
router.get('/notes', async (req, res) => {
  if (isPaused) {
    // Intentionally NOT calling recordRequest() here — a rejection caused by
    // the user pressing Stop is not a server error, and counting it as one
    // previously could spike the measured error rate right as you stopped,
    // triggering a bogus scale-UP at the exact moment you wanted a scale-down.
    return res.status(503).json({ success: false, message: 'Load test paused' });
  }
  // Every load-test response closes its connection deliberately. Node's
  // cluster module only round-robins NEW TCP connections across workers —
  // requests reused on a browser's keep-alive connection all stick to
  // whichever single worker first accepted that connection. Forcing a
  // close here means every request opens a fresh connection, so the
  // round-robin actually spreads load across all workers instead of
  // piling onto 1-2 of them. This is what fixes uneven distribution.
  res.set('Connection', 'close');
  try {
    const limit = parseInt(req.query.limit, 10) || 20;
    const notes = await LoadBalancerNote.find().sort({ createdAt: -1 }).limit(limit);
    touchStats();
    stats.getCount += 1;
    recordRequest(true);
    res.status(200).json({ success: true, count: notes.length, notes });
  } catch (err) {
    stats.errorCount += 1;
    recordRequest(false);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/load-balancer/stats
// ─────────────────────────────────────────────
router.get('/stats', (req, res) => {
  const elapsedSec = stats.startedAt ? (Date.now() - new Date(stats.startedAt).getTime()) / 1000 : 0;
  const rps = elapsedSec > 0 ? (stats.totalRequests / elapsedSec).toFixed(2) : '0.00';
  res.json({ success: true, stats: { ...stats, elapsedSec: Number(elapsedSec.toFixed(1)), requestsPerSecond: Number(rps) } });
});

router.post('/stats/reset', (req, res) => {
  stats = { totalRequests: 0, postCount: 0, getCount: 0, errorCount: 0, startedAt: null, lastRequestAt: null };
  res.json({ success: true, stats });
});

// ─────────────────────────────────────────────
// POST /api/load-balancer/pause  — writes to the SHARED Mongo flag,
// so every worker (not just the one that received this request) picks
// it up within ~300ms via refreshPauseFlag().
// ─────────────────────────────────────────────
router.post('/pause', async (req, res) => {
  try {
    await ClusterState.updateOne(
      { _id: 'singleton' },
      { $set: { isPaused: true, forceScaleDown: true } },
      { upsert: true }
    );
    isPaused = true; // apply immediately on this worker too, don't wait for the poll
    res.status(200).json({ success: true, isPaused: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/resume', async (req, res) => {
  try {
    await ClusterState.updateOne({ _id: 'singleton' }, { $set: { isPaused: false } }, { upsert: true });
    isPaused = false;
    res.status(200).json({ success: true, isPaused: false });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /api/load-balancer/workers
// Cluster-wide view: aggregate stats + one entry per LIVE worker
// process, for the dashboard's worker boxes.
// ─────────────────────────────────────────────
router.get('/workers', async (req, res) => {
  try {
    const staleCutoff = new Date(Date.now() - HEARTBEAT_STALE_MS);
    const [clusterState, heartbeats] = await Promise.all([
      ClusterState.findById('singleton').lean(),
      WorkerHeartbeat.find({ lastSeen: { $gte: staleCutoff } }).sort({ workerId: 1 }).lean(),
    ]);

    const totalRps = heartbeats.reduce((s, h) => s + (h.rps || 0), 0);
    const weightedErrorSum = heartbeats.reduce((s, h) => s + (h.errorRatePct || 0) * (h.rps || 0), 0);
    const clusterErrorRatePct = totalRps > 0 ? Number((weightedErrorSum / totalRps).toFixed(1)) : 0;

    res.status(200).json({
      success: true,
      currentWorkers: (clusterState && clusterState.currentWorkers) || heartbeats.length || MIN_WORKERS,
      minWorkers: MIN_WORKERS,
      maxWorkers: MAX_WORKERS,
      resolvedAppName,
      appNameResolved,
      leaderId: (clusterState && clusterState.leaderId) || null,
      isPaused: !!(clusterState && clusterState.isPaused),
      forceScaleDownPending: !!(clusterState && clusterState.forceScaleDown),
      errorRate: clusterErrorRatePct,
      requestsPerSecond: Number(totalRps.toFixed(1)),
      scalingLog: (clusterState && clusterState.scalingLog) || [],
      workers: heartbeats.map(h => ({
        workerId: h.workerId,
        pid: h.pid,
        totalHandled: h.totalHandled,
        totalErrors: h.totalErrors,
        rps: h.rps,
        errorRatePct: h.errorRatePct,
        lastSeen: h.lastSeen,
        isLeader: (clusterState && clusterState.leaderId === h.workerId) || false,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;