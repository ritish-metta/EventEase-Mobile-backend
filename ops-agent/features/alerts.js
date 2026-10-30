// Alert engine: raises/clears alerts for down projects, high CPU/memory/disk and
// failing monitors. Pushes them to the panel live and, optionally, to a webhook
// (Discord / Slack / any URL that accepts JSON).

const os = require('os');

const EVAL_MS = 30000;
const MAX_HISTORY = 200;

module.exports = function alerts(ctx, { metrics, settings }) {
  const active = new Map(); // key -> { key, level, message, since }
  const history = [];

  const list = () => [...active.values()].sort((a, b) => b.since - a.since);
  const record = (entry) => {
    history.unshift(entry);
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  };

  async function notify(text) {
    const url = settings.get().webhookUrl;
    if (!url) return { sent: false, reason: 'No webhook URL set' };
    try {
      // `content` is what Discord reads, `text` is what Slack reads
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, content: text }),
        signal: AbortSignal.timeout(8000),
      });
      return { sent: res.ok, reason: res.ok ? '' : `Webhook answered HTTP ${res.status}` };
    } catch (err) {
      return { sent: false, reason: err.message };
    }
  }

  function raise(key, level, message) {
    if (active.has(key)) return;
    const alert = { key, level, message, since: Date.now() };
    active.set(key, alert);
    record({ ...alert, event: 'raised', at: alert.since });
    ctx.emit('alerts', list());
    notify(`${level === 'critical' ? '🚨' : '⚠️'} [${os.hostname()}] ${message}`);
  }

  function resolve(key) {
    const alert = active.get(key);
    if (!alert) return;
    active.delete(key);
    record({ ...alert, event: 'resolved', at: Date.now() });
    ctx.emit('alerts', list());
    notify(`✅ [${os.hostname()}] Resolved: ${alert.message}`);
  }

  const check = (key, condition, level, message) => (condition ? raise(key, level, message) : resolve(key));

  async function evaluate() {
    const th = settings.get().thresholds;

    const recent = metrics.recent(6); // last minute, so one spike doesn't alert
    if (recent.length) {
      const avg = (k) => recent.reduce((s, x) => s + x[k], 0) / recent.length;
      check('cpu', avg('cpu') >= th.cpu, 'warning', `CPU above ${th.cpu}% for the last minute`);
      check('memory', avg('mem') >= th.memory, 'warning', `Memory above ${th.memory}%`);
    }

    const df = await ctx.safeRun('df', ['-kP', '/']);
    if (df) {
      const cols = df.split('\n')[1].split(/\s+/);
      const pct = (Number(cols[2]) / Number(cols[1])) * 100;
      check('disk', pct >= th.disk, 'critical', `Disk ${pct.toFixed(0)}% full`);
    }

    try {
      const projects = await ctx.getProjects();
      const names = new Set(projects.map((p) => p.name));
      for (const p of projects) {
        check(`project:${p.name}`, p.online === 0, 'critical', `Project ${p.name} is ${p.instances[0]?.status || 'down'}`);
      }
      for (const key of active.keys()) {
        if (key.startsWith('project:') && !names.has(key.slice(8))) resolve(key); // project was removed
      }
    } catch {
      // PM2 unreachable — the panel's own status already shows this
    }
  }

  setInterval(evaluate, EVAL_MS).unref();
  setTimeout(evaluate, 5000).unref();

  ctx.app.get('/api/alerts', (req, res) => res.json({ success: true, active: list(), history }));

  ctx.app.post('/api/alerts/test', async (req, res) => {
    const result = await notify(`🔔 [${os.hostname()}] Test alert from the server control panel`);
    if (!result.sent) throw new ctx.HttpError(400, result.reason);
    res.json({ success: true, message: 'Test alert sent' });
  });

  return { raise, resolve, check, list };
};
