// routes/ops.js
// Server operations API — health, system metrics, PM2 process control,
// logs and manual redeploy. Powers public/ops-dashboard.html.
//
// Everything except GET /health requires the header:
//   x-ops-token: <OPS_TOKEN from .env>

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const mongoose = require('mongoose');
const { createClient } = require('redis');

const router = express.Router();

const APP_DIR = path.join(__dirname, '..');
const PM2_BIN = process.env.PM2_BIN || 'pm2';
const ACTION_LOG = path.join(os.tmpdir(), 'eventease-ops-actions.log');
const MAX_INSTANCES = 8;

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: APP_DIR, timeout: 15000, maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve(stdout.trim());
    });
  });

// Mutating PM2 commands are run fully detached (double fork via `sh -c '... &'`).
// PM2 kills the whole process tree of a worker on reload/restart, so a plain
// child of this worker would die halfway through reloading its own app.
const runDetached = (command) => {
  const line = `\n[${new Date().toISOString()}] $ ${command}\n`;
  fs.appendFileSync(ACTION_LOG, line);
  spawn('sh', ['-c', `(${command}) >> '${ACTION_LOG}' 2>&1 &`], {
    cwd: APP_DIR,
    detached: true,
    stdio: 'ignore',
  }).unref();
};

const pm2List = async () => {
  const out = await run(PM2_BIN, ['jlist']);
  return JSON.parse(out.slice(out.indexOf('['))); // skip any PM2 banner/warnings before the JSON
};

// Last `lines` lines of a file, reading only the tail of big log files.
const tailFile = (file, lines) => {
  if (!file || !fs.existsSync(file)) return [];
  const { size } = fs.statSync(file);
  const bytes = Math.min(size, 256 * 1024);
  const buf = Buffer.alloc(bytes);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, buf, 0, bytes, size - bytes);
  fs.closeSync(fd);
  return buf.toString('utf8').split('\n').filter(Boolean).slice(-lines);
};

const pingRedis = async () => {
  const client = createClient({
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    socket: { connectTimeout: 2000, reconnectStrategy: false },
  });
  client.on('error', () => {});
  try {
    await client.connect();
    const start = Date.now();
    await client.ping();
    return { status: 'up', latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 'down', error: err.message };
  } finally {
    if (client.isOpen) client.destroy();
  }
};

const MONGO_STATES = ['disconnected', 'connected', 'connecting', 'disconnecting'];

// ─────────────────────────────────────────────
// Auth — constant-time token check
// ─────────────────────────────────────────────
const requireOpsToken = (req, res, next) => {
  const expected = process.env.OPS_TOKEN;
  if (!expected) {
    return res.status(503).json({ success: false, message: 'OPS_TOKEN is not set in .env on the server' });
  }
  const given = Buffer.from(req.header('x-ops-token') || '');
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return res.status(401).json({ success: false, message: 'Invalid ops token' });
  }
  next();
};

// ─────────────────────────────────────────────
// GET /health — public, used by uptime checks / CI
// ─────────────────────────────────────────────
router.get('/health', async (req, res) => {
  const mongo = MONGO_STATES[mongoose.connection.readyState] || 'unknown';
  const redis = await pingRedis();
  const healthy = mongo === 'connected' && redis.status === 'up';

  res.status(healthy ? 200 : 503).json({
    success: healthy,
    status: healthy ? 'ok' : 'degraded',
    uptimeSec: Math.round(process.uptime()),
    worker: process.env.NODE_APP_INSTANCE ?? null,
    pid: process.pid,
    mongo,
    redis,
    time: new Date().toISOString(),
  });
});

router.use(requireOpsToken);

// ─────────────────────────────────────────────
// GET /system — machine metrics + deployed commit
// ─────────────────────────────────────────────
router.get('/system', async (req, res) => {
  let disk = null;
  try {
    const df = (await run('df', ['-kP', '/'])).split('\n')[1].split(/\s+/);
    disk = { totalBytes: +df[1] * 1024, usedBytes: +df[2] * 1024, freeBytes: +df[3] * 1024 };
  } catch {
    // df not available (e.g. local Windows dev)
  }

  let git = null;
  try {
    const [commit, message, when, branch] = (await run('git', ['log', '-1', '--format=%h%n%s%n%cr'])).split('\n')
      .concat(await run('git', ['rev-parse', '--abbrev-ref', 'HEAD']));
    git = { commit, message, when, branch };
  } catch {
    // not a git checkout
  }

  res.json({
    success: true,
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    node: process.version,
    cpus: os.cpus().length,
    loadAvg: os.loadavg(),
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
    disk,
    uptimeSec: Math.round(os.uptime()),
    git,
  });
});

// ─────────────────────────────────────────────
// GET /processes — PM2 process list
// ─────────────────────────────────────────────
router.get('/processes', async (req, res) => {
  try {
    const list = await pm2List();
    res.json({
      success: true,
      processes: list.map((p) => ({
        id: p.pm_id,
        name: p.name,
        status: p.pm2_env.status,
        mode: p.pm2_env.exec_mode,
        pid: p.pid,
        cpu: p.monit?.cpu ?? 0,
        memoryBytes: p.monit?.memory ?? 0,
        restarts: p.pm2_env.restart_time,
        startedAt: p.pm2_env.pm_uptime,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: `PM2 not available: ${err.message}` });
  }
});

// ─────────────────────────────────────────────
// POST /processes/:name/:action — restart | reload | stop | start
// POST /processes/:name/scale   — body { instances }
// ─────────────────────────────────────────────
const ACTIONS = ['restart', 'reload', 'stop', 'start'];

router.post('/processes/:name/:action', async (req, res) => {
  const { name, action } = req.params;
  try {
    const names = new Set((await pm2List()).map((p) => p.name));
    if (!names.has(name)) return res.status(404).json({ success: false, message: `No PM2 process named "${name}"` });

    if (action === 'scale') {
      const instances = parseInt(req.body?.instances, 10);
      if (!Number.isInteger(instances) || instances < 1 || instances > MAX_INSTANCES) {
        return res.status(400).json({ success: false, message: `instances must be 1–${MAX_INSTANCES}` });
      }
      runDetached(`${PM2_BIN} scale '${name}' ${instances}`);
      return res.json({ success: true, message: `Scaling ${name} to ${instances} instance(s)…` });
    }

    if (!ACTIONS.includes(action)) {
      return res.status(400).json({ success: false, message: `Unknown action "${action}"` });
    }
    runDetached(`${PM2_BIN} ${action} '${name}'${action === 'start' ? '' : ' --update-env'}`);
    res.json({ success: true, message: `${action} sent to ${name}` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────
// GET /logs?name=eventease_backend&type=out|err&lines=200
// ─────────────────────────────────────────────
router.get('/logs', async (req, res) => {
  const lines = Math.min(parseInt(req.query.lines, 10) || 200, 2000);
  const type = req.query.type === 'err' ? 'err' : 'out';
  try {
    const list = await pm2List();
    const procs = req.query.name ? list.filter((p) => p.name === req.query.name) : list;
    const files = [...new Set(procs.map((p) => (type === 'err' ? p.pm2_env.pm_err_log_path : p.pm2_env.pm_out_log_path)))];
    const logs = files.flatMap((f) => tailFile(f, lines).map((l) => `[${path.basename(f)}] ${l}`));
    res.json({ success: true, type, lines: logs.slice(-lines) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────
// POST /deploy — pull latest main, install, zero-downtime reload
// GET  /actions-log — output of deploy / pm2 actions
// ─────────────────────────────────────────────
router.post('/deploy', async (req, res) => {
  try {
    const self = (await pm2List()).find((p) => p.pid === process.pid);
    const appName = self?.name || process.env.PM2_APP_NAME || 'eventease_backend';
    runDetached(
      `cd '${APP_DIR}' && git fetch origin main && git reset --hard origin/main && npm ci --omit=dev && ${PM2_BIN} reload '${appName}' --update-env && echo '✅ deploy finished'`
    );
    res.json({ success: true, message: `Deploy started for ${appName} — watch the actions log` });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/actions-log', (req, res) => {
  res.json({ success: true, lines: tailFile(ACTION_LOG, 200) });
});

module.exports = router;
