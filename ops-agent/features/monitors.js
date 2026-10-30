// Uptime monitors: request a URL on an interval, track uptime % and response time,
// raise an alert after N failures in a row and optionally auto-restart the PM2
// project behind it ("auto-heal", at most once every 5 minutes).

const crypto = require('crypto');
const store = require('./store');

const HISTORY = 120;
const HEAL_COOLDOWN_MS = 5 * 60 * 1000;

module.exports = function monitors(ctx, { alerts }) {
  let list = store.load('monitors', null) ?? [{
    id: crypto.randomUUID().slice(0, 8),
    name: 'EventEase API',
    url: 'http://localhost:5000/api',
    intervalSec: 30,
    timeoutMs: 5000,
    failThreshold: 3,
    project: 'eventease_backend',
    autoRestart: false,
  }];
  const state = new Map(); // id -> { history, fails, lastHeal, timer }

  const getState = (id) => {
    if (!state.has(id)) state.set(id, { history: [], fails: 0, lastHeal: 0, timer: null });
    return state.get(id);
  };

  async function check(m) {
    const st = getState(m.id);
    const start = Date.now();
    let result;
    try {
      const res = await fetch(m.url, { signal: AbortSignal.timeout(m.timeoutMs), redirect: 'manual' });
      result = { t: start, ok: res.status < 400, status: res.status, ms: Date.now() - start };
    } catch (err) {
      result = { t: start, ok: false, status: 0, ms: Date.now() - start, error: err.name === 'TimeoutError' ? 'timeout' : err.cause?.code || err.message };
    }

    st.history.push(result);
    if (st.history.length > HISTORY) st.history.shift();
    st.fails = result.ok ? 0 : st.fails + 1;

    alerts.check(`monitor:${m.id}`, st.fails >= m.failThreshold, 'critical',
      `Monitor "${m.name}" is DOWN (${result.error || `HTTP ${result.status}`})`);

    if (m.autoRestart && m.project && st.fails === m.failThreshold && Date.now() - st.lastHeal > HEAL_COOLDOWN_MS) {
      st.lastHeal = Date.now();
      ctx.startJob(`auto-heal: restart ${m.project} (monitor "${m.name}" failed ${st.fails}×)`, `pm2 restart ${ctx.q(m.project)}`);
    }

    ctx.emit('monitor', { id: m.id, result, fails: st.fails });
    return result;
  }

  function schedule(m) {
    const st = getState(m.id);
    clearInterval(st.timer);
    st.timer = setInterval(() => check(m), m.intervalSec * 1000);
    st.timer.unref();
    setTimeout(() => check(m), 2000).unref();
  }

  function unschedule(id) {
    clearInterval(state.get(id)?.timer);
    state.delete(id);
    alerts.resolve(`monitor:${id}`);
  }

  const summary = (m) => {
    const { history, fails, lastHeal } = getState(m.id);
    const ok = history.filter((h) => h.ok);
    return {
      ...m,
      fails,
      lastHeal: lastHeal || null,
      last: history.at(-1) || null,
      uptimePct: history.length ? +((ok.length / history.length) * 100).toFixed(1) : null,
      avgMs: ok.length ? Math.round(ok.reduce((s, h) => s + h.ms, 0) / ok.length) : null,
      history: history.slice(-60),
    };
  };

  function validate(body) {
    const m = {
      name: String(body?.name || '').trim().slice(0, 60),
      url: String(body?.url || '').trim(),
      intervalSec: parseInt(body?.intervalSec, 10) || 30,
      timeoutMs: parseInt(body?.timeoutMs, 10) || 5000,
      failThreshold: parseInt(body?.failThreshold, 10) || 3,
      project: String(body?.project || '').trim(),
      autoRestart: Boolean(body?.autoRestart),
    };
    if (!m.name) throw new ctx.HttpError(400, 'Name is required');
    if (!/^https?:\/\/\S+$/.test(m.url)) throw new ctx.HttpError(400, 'URL must start with http:// or https://');
    if (m.intervalSec < 10 || m.intervalSec > 3600) throw new ctx.HttpError(400, 'Interval must be 10–3600 seconds');
    if (m.timeoutMs < 1000 || m.timeoutMs > 30000) throw new ctx.HttpError(400, 'Timeout must be 1000–30000 ms');
    if (m.failThreshold < 1 || m.failThreshold > 10) throw new ctx.HttpError(400, 'Fail threshold must be 1–10');
    if (m.project && !ctx.NAME_RE.test(m.project)) throw new ctx.HttpError(400, 'Invalid project name');
    if (m.project === ctx.AGENT_NAME) m.autoRestart = false; // never let a monitor restart the panel itself
    return m;
  }

  const find = (id) => {
    const m = list.find((x) => x.id === id);
    if (!m) throw new ctx.HttpError(404, 'Monitor not found');
    return m;
  };

  ctx.app.get('/api/monitors', (req, res) => res.json({ success: true, monitors: list.map(summary) }));

  ctx.app.post('/api/monitors', (req, res) => {
    const m = { id: crypto.randomUUID().slice(0, 8), ...validate(req.body) };
    list.push(m);
    store.save('monitors', list);
    schedule(m);
    res.json({ success: true, message: `Monitor "${m.name}" added` });
  });

  ctx.app.put('/api/monitors/:id', (req, res) => {
    const m = find(req.params.id);
    Object.assign(m, validate(req.body));
    store.save('monitors', list);
    schedule(m);
    res.json({ success: true, message: `Monitor "${m.name}" updated` });
  });

  ctx.app.delete('/api/monitors/:id', (req, res) => {
    const m = find(req.params.id);
    list = list.filter((x) => x.id !== m.id);
    store.save('monitors', list);
    unschedule(m.id);
    res.json({ success: true, message: `Monitor "${m.name}" removed` });
  });

  ctx.app.post('/api/monitors/:id/check', async (req, res) => {
    const result = await check(find(req.params.id));
    res.json({ success: true, result, message: result.ok ? `Up (${result.ms} ms)` : `Down: ${result.error || `HTTP ${result.status}`}` });
  });

  store.save('monitors', list);
  list.forEach(schedule);
};
