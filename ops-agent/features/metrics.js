// Samples CPU / memory / swap / network every 10 s and keeps 2 hours of history
// for the Overview charts. Reads /proc directly (Linux), falls back to `os` elsewhere.

const fs = require('fs');
const os = require('os');
const store = require('./store');

const INTERVAL_MS = 10000;
const HISTORY = 720; // 2 h at 10 s

function cpuTimes() {
  return os.cpus().reduce((acc, { times: t }) => {
    acc.idle += t.idle;
    acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
    return acc;
  }, { idle: 0, total: 0 });
}

function netBytes() {
  try {
    return fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2).reduce((acc, line) => {
      const [iface, rest] = line.split(':');
      if (!rest || iface.trim() === 'lo') return acc;
      const cols = rest.trim().split(/\s+/);
      acc.rx += Number(cols[0]);
      acc.tx += Number(cols[8]);
      return acc;
    }, { rx: 0, tx: 0 });
  } catch {
    return { rx: 0, tx: 0 };
  }
}

function memInfo() {
  try {
    const m = Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').split('\n').filter(Boolean).map((line) => {
      const [key, value] = line.split(':');
      return [key, parseInt(value, 10) * 1024];
    }));
    return { totalBytes: m.MemTotal, availableBytes: m.MemAvailable, swapTotalBytes: m.SwapTotal, swapFreeBytes: m.SwapFree };
  } catch {
    return { totalBytes: os.totalmem(), availableBytes: os.freemem(), swapTotalBytes: 0, swapFreeBytes: 0 };
  }
}

module.exports = function metrics(ctx) {
  // history survives agent restarts (every deploy restarts the agent)
  const samples = (store.load('metrics', []) || []).filter((s) => s.t > Date.now() - HISTORY * INTERVAL_MS);
  let sinceSave = 0;
  let prevCpu = cpuTimes();
  let prevNet = netBytes();
  let prevTime = Date.now();

  function sample() {
    const now = Date.now();
    const cpu = cpuTimes();
    const net = netBytes();
    const mem = memInfo();
    const seconds = (now - prevTime) / 1000 || 1;
    const busy = cpu.total - prevCpu.total;

    const s = {
      t: now,
      cpu: busy ? +((1 - (cpu.idle - prevCpu.idle) / busy) * 100).toFixed(1) : 0,
      mem: +((1 - mem.availableBytes / mem.totalBytes) * 100).toFixed(1),
      swap: mem.swapTotalBytes ? +((1 - mem.swapFreeBytes / mem.swapTotalBytes) * 100).toFixed(1) : 0,
      rx: Math.max(0, Math.round((net.rx - prevNet.rx) / seconds)),
      tx: Math.max(0, Math.round((net.tx - prevNet.tx) / seconds)),
    };
    prevCpu = cpu;
    prevNet = net;
    prevTime = now;

    samples.push(s);
    if (samples.length > HISTORY) samples.shift();
    ctx.emit('metrics', s);
    if (++sinceSave >= 6) { // once a minute
      sinceSave = 0;
      try { store.save('metrics', samples); } catch { /* disk full: keep running */ }
    }
  }

  setInterval(sample, INTERVAL_MS).unref();

  ctx.app.get('/api/metrics', (req, res) => res.json({ success: true, intervalMs: INTERVAL_MS, samples }));

  return {
    memInfo,
    latest: () => samples.at(-1),
    recent: (n) => samples.slice(-n),
  };
};
