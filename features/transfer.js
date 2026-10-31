// Transfer: WinSCP-style upload of a project's files, then "Apply" = backup →
// install / build (when needed) → restart → health check, with the result kept
// in a per-project history and a one-click rollback to the backup.
//
//   GET  /api/transfer/projects          projects with status, port, deploy settings
//   POST /api/transfer/compare           which local files are new / changed / same
//   POST /api/transfer/apply             start the apply job, returns a history id
//   GET  /api/transfer/history           recent applies of a project (with results)
//   GET  /api/transfer/history/:id       one apply (polled while it runs)
//   GET  /api/transfer/health            live health of a project right now
//   POST /api/transfer/rollback          restore the backup of an apply and restart

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const store = require('./store');

const MAX_FILES = 5000;
const HASH_MAX_BYTES = 60 * 1024 * 1024; // the upload limit is 50 MB anyway
const KEEP_AUTO_BACKUPS = 3; // automatic backups kept per project
const KEEP_HISTORY = 20; // applies remembered per project
const LOCK_FILES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);
const NO_BUILD_FILES = /^(\.env(\..*)?|readme(\..*)?|license(\..*)?|\.gitignore)$/i; // changing only these needs no build

module.exports = function transfer(ctx, { backups, deploys }) {
  const { app, q, HttpError, run, safeRun } = ctx;
  const history = store.load('transfers', {}); // project -> [record, newest first]
  const saveHistory = () => store.save('transfers', history);

  // ── helpers ───────────────────────────────
  const projectDir = (dir) => {
    const target = ctx.homePath(dir, 'folder');
    if (target === ctx.HOME || ctx.isProtected(target)) throw new HttpError(400, 'Pick a project folder');
    return target;
  };

  // "a/b/c.js" inside root, never escaping it
  const safeJoin = (root, rel) => {
    const parts = String(rel || '').replace(/\\/g, '/').split('/').filter(Boolean);
    if (!parts.length || parts.some((p) => p === '.' || p === '..')) return null;
    const full = path.join(root, ...parts);
    return full.startsWith(root + path.sep) ? full : null;
  };

  const sha256File = (file) => new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });

  // pid -> children, to find the real app process under "npm start" etc.
  async function descendants(pids) {
    const out = await safeRun('ps', ['-eo', 'pid=,ppid=']);
    const kids = new Map();
    for (const line of (out || '').split('\n')) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (!pid) continue;
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(pid);
    }
    const all = new Set(pids);
    const stack = [...pids];
    while (stack.length) for (const c of kids.get(stack.pop()) || []) if (!all.has(c)) { all.add(c); stack.push(c); }
    return all;
  }

  // TCP ports the project's processes listen on (via `ss`)
  async function projectPorts(proj) {
    const pids = proj.instances.map((i) => i.pid).filter(Boolean);
    if (!pids.length) return [];
    const [tree, ss] = await Promise.all([descendants(pids), safeRun('ss', ['-ltnpH'])]);
    const ports = new Set();
    for (const line of (ss || '').split('\n')) {
      const local = line.trim().split(/\s+/)[3] || '';
      const port = Number(local.slice(local.lastIndexOf(':') + 1));
      const owners = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
      if (port && owners.some((p) => tree.has(p))) ports.add(port);
    }
    return [...ports].sort((a, b) => a - b);
  }

  // PORT from the project's .env (used when the app isn't running)
  function envPort(cwd) {
    try {
      const m = fs.readFileSync(path.join(cwd, '.env'), 'utf8').match(/^\s*PORT\s*=\s*["']?(\d{1,5})/m);
      return m ? Number(m[1]) : null;
    } catch { return null; }
  }

  const httpCheck = (port) => new Promise((resolve) => {
    const started = Date.now();
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 5000 }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, ms: Date.now() - started });
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'No answer within 5 s', ms: Date.now() - started }); });
    req.on('error', (err) => resolve({ error: err.code || err.message, ms: Date.now() - started }));
  });

  // new lines in a log file since a byte offset (or the last lines)
  function logSince(file, offset, maxLines = 40) {
    if (!file || !fs.existsSync(file)) return [];
    const { size } = fs.statSync(file);
    if (offset == null || offset > size) return ctx.tailFile(file, maxLines);
    const start = Math.max(offset, size - 256 * 1024);
    const buf = Buffer.alloc(size - start);
    const fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n').filter(Boolean).slice(-maxLines);
  }
  const fileSize = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };

  async function health(name, { errOffset, outOffset } = {}) {
    const proj = (await ctx.getProjects()).find((p) => p.name === name);
    if (!proj) return { found: false, ok: false, summary: `${name} is not running under PM2` };
    const statuses = [...new Set(proj.instances.map((i) => i.status))];
    const online = proj.online === proj.instances.length;
    const ports = online ? await projectPorts(proj) : [];
    const port = ports[0] || null;
    const httpResult = port ? await httpCheck(port) : null;
    const errLines = logSince(proj.logs.err[0], errOffset, 40);
    const outLines = logSince(proj.logs.out[0], outOffset, 40);
    const problems = [];
    if (!online) problems.push(`Status is ${statuses.join(', ')}`);
    if (online && !port) problems.push('Running, but not listening on any port (yet)');
    if (httpResult?.error) problems.push(`Port ${port} does not answer: ${httpResult.error}`);
    else if (httpResult?.status >= 500) problems.push(`Port ${port} answers with an error: HTTP ${httpResult.status}`);
    return {
      found: true,
      ok: online && Boolean(port) && !httpResult?.error && httpResult?.status < 500,
      status: statuses.join(', '),
      online,
      restarts: proj.restarts,
      startedAt: Math.max(0, ...proj.instances.map((i) => i.startedAt || 0)),
      ports,
      port: port || envPort(proj.cwd),
      http: httpResult,
      problems,
      logs: { out: outLines, err: errLines },
      summary: problems.length ? problems.join(' · ') : `Live on port ${port} · HTTP ${httpResult.status} in ${httpResult.ms} ms`,
    };
  }

  // ── projects for the switcher ─────────────
  app.get('/api/transfer/projects', async (req, res) => {
    const list = (await ctx.getProjects()).filter((p) => !p.isAgent);
    const out = await Promise.all(list.map(async (p) => ({
      name: p.name,
      cwd: p.cwd,
      online: p.online === p.instances.length,
      status: [...new Set(p.instances.map((i) => i.status))].join(', '),
      restarts: p.restarts,
      startedAt: Math.max(0, ...p.instances.map((i) => i.startedAt || 0)),
      port: (await projectPorts(p))[0] || envPort(p.cwd),
      deploy: deploys.get(p.name) || null,
      last: (history[p.name] || [])[0] || null,
      busy: Boolean(ctx.busyJob(p.name)),
    })));
    res.json({ success: true, home: ctx.HOME, projects: out });
  });

  // ── compare local files with the server ───
  // body: { root, files: [{ path, size }] } → per file: new | changed | check (same size: compare hash)
  app.post('/api/transfer/compare', async (req, res) => {
    const root = projectDir(req.body?.root);
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (files.length > MAX_FILES) throw new HttpError(400, `Too many files at once (max ${MAX_FILES})`);
    const results = [];
    for (const f of files) {
      const full = safeJoin(root, f.path);
      if (!full || ctx.isProtected(full)) { results.push({ path: f.path, status: 'blocked' }); continue; }
      let st = null;
      try { st = fs.statSync(full); } catch { /* not on the server */ }
      if (!st) results.push({ path: f.path, status: 'new' });
      else if (st.isDirectory()) results.push({ path: f.path, status: 'blocked', reason: 'A folder with this name exists on the server' });
      else if (st.size !== Number(f.size)) results.push({ path: f.path, status: 'changed', serverSize: st.size, serverMtime: st.mtimeMs });
      else if (st.size > HASH_MAX_BYTES) results.push({ path: f.path, status: 'changed', serverSize: st.size, serverMtime: st.mtimeMs });
      else results.push({ path: f.path, status: 'check', serverSize: st.size, serverMtime: st.mtimeMs, hash: await sha256File(full) });
    }
    res.json({ success: true, root, results });
  });

  // ── apply: backup → install/build when needed → restart → health ──
  // body: { project, changed: [relative paths], mode: auto | restart | full }
  app.post('/api/transfer/apply', async (req, res) => {
    const proj = await ctx.findProject(String(req.body?.project || ''));
    if (proj.isAgent) throw new HttpError(400, 'The panel itself is updated by its own deploy, not here');
    ctx.assertNotBusy(proj.name);
    const changed = (Array.isArray(req.body?.changed) ? req.body.changed : []).map(String).slice(0, MAX_FILES);
    const mode = ['restart', 'full'].includes(req.body?.mode) ? req.body.mode : 'auto';
    const settings = deploys.get(proj.name) || {};

    const base = (p) => p.split('/').pop();
    const pkgChanged = changed.some((p) => LOCK_FILES.has(base(p)) && !p.includes('/'));
    const codeChanged = changed.some((p) => !NO_BUILD_FILES.test(base(p)));
    const install = mode === 'full' || (mode === 'auto' && pkgChanged);
    const build = Boolean(settings.buildCmd) && (mode === 'full' || (mode === 'auto' && codeChanged));
    const why = mode === 'full' ? 'you chose a full redeploy'
      : mode === 'restart' ? 'you chose restart only'
      : pkgChanged ? 'package.json / lock file changed'
      : changed.length ? 'only code / config files changed' : 'nothing uploaded, just restarting';

    backups.pruneAuto(proj.name, KEEP_AUTO_BACKUPS - 1); // the new one makes it KEEP_AUTO_BACKUPS
    const backup = backups.backupCommand(proj, { auto: true });
    // any failing step stops the job (also for "a && b" commands, which set -e does not catch)
    const step = (id, label, cmd) => [`echo "▶ STEP ${id} ${label}"`, `{\n${cmd}\n} || { echo "✖ STEP ${id} failed"; exit 1; }`, `echo "✔ STEP ${id}"`].join('\n');
    const plan = [{ id: 'backup', label: 'Backup current files' }];
    const lines = ['set -e', step('backup', 'Backup current files', backup.command), `cd ${q(proj.cwd)}`];
    if (install) {
      plan.push({ id: 'install', label: 'Install packages' });
      lines.push(step('install', 'Install packages', settings.installCmd || ctx.installCmd));
    }
    if (build) {
      plan.push({ id: 'build', label: 'Build' });
      lines.push(step('build', 'Build', settings.buildCmd));
    }
    plan.push({ id: 'restart', label: proj.mode === 'cluster' ? 'Reload (zero downtime)' : 'Restart' });
    lines.push(step('restart', 'Restart', `pm2 ${proj.mode === 'cluster' ? 'reload' : 'restart'} ${q(proj.name)}`));
    plan.push({ id: 'save', label: 'Save PM2 list' });
    lines.push(step('save', 'Save PM2 list', 'pm2 save'));
    plan.push({ id: 'health', label: 'Health check' });

    const record = {
      id: crypto.randomUUID().slice(0, 8),
      project: proj.name,
      at: Date.now(),
      mode,
      why,
      changed: changed.slice(0, 200),
      changedCount: changed.length,
      plan,
      backupFile: backup.file,
      errOffset: fileSize(proj.logs.err[0]),
      outOffset: fileSize(proj.logs.out[0]),
      status: 'running',
    };
    const job = ctx.startJob(`Apply upload to ${proj.name}`, lines.join('\n'), { project: proj.name, kind: 'transfer' });
    record.jobId = job.id;
    remember(record);
    finalize(record, job);
    res.json({ success: true, message: `Applying to ${proj.name}…`, id: record.id, jobId: job.id, plan, why });
  });

  function remember(record) {
    const list = history[record.project] || (history[record.project] = []);
    const i = list.findIndex((r) => r.id === record.id);
    if (i >= 0) list[i] = record; else list.unshift(record);
    list.length = Math.min(list.length, KEEP_HISTORY);
    saveHistory();
  }

  // After the job: give the app a few seconds, then check it (also catches crash loops).
  function finalize(record, job) {
    const timer = setInterval(async () => {
      if (job.status === 'running') return;
      clearInterval(timer);
      record.jobStatus = job.status;
      record.output = (job.output || '').slice(-20000);
      if (job.status !== 'success') {
        const failedStep = [...record.output.matchAll(/^▶ STEP (\w+)/gm)].map((m) => m[1]).pop();
        record.failedStep = failedStep || null;
        record.status = 'failed';
        record.result = await health(record.project, record).catch(() => null);
        record.summary = `Stopped at "${record.plan.find((s) => s.id === failedStep)?.label || 'a step'}". The app was not restarted with the new files.`;
        record.endedAt = Date.now();
        remember(record);
        ctx.emit('transfer', { id: record.id, project: record.project, status: record.status });
        return;
      }
      const before = await ctx.getProjects().then((ps) => ps.find((p) => p.name === record.project)?.restarts ?? 0).catch(() => 0);
      let h = null;
      for (let i = 0; i < 6; i++) { // up to ~12 s for the app to open its port
        await new Promise((r) => setTimeout(r, 2000));
        h = await health(record.project, record).catch(() => null);
        if (h?.ok && i >= 1) break;
      }
      if (h && h.restarts - before >= 2) h.problems.unshift(`It keeps crashing (${h.restarts - before} restarts in a few seconds)`);
      if (h && h.restarts - before >= 2) h.ok = false;
      record.result = h;
      record.status = h?.ok ? 'live' : 'unhealthy';
      record.summary = h ? (h.problems.length ? h.problems.join(' · ') : h.summary) : 'Could not check the app';
      record.endedAt = Date.now();
      remember(record);
      ctx.emit('transfer', { id: record.id, project: record.project, status: record.status });
    }, 1000);
  }

  app.get('/api/transfer/history', (req, res) => {
    const list = (history[String(req.query.project || '')] || []).map(({ output, ...r }) => r);
    res.json({ success: true, history: list });
  });

  app.get('/api/transfer/history/:id', (req, res) => {
    for (const list of Object.values(history)) {
      const r = list.find((x) => x.id === req.params.id);
      if (r) return res.json({ success: true, record: r });
    }
    throw new HttpError(404, 'Not found');
  });

  app.get('/api/transfer/health', async (req, res) => {
    res.json({ success: true, health: await health(String(req.query.project || '')) });
  });

  // ── rollback: put the backup of an apply back exactly, reinstall, restart ──
  app.post('/api/transfer/rollback', async (req, res) => {
    const proj = await ctx.findProject(String(req.body?.project || ''));
    ctx.assertNotBusy(proj.name);
    const record = (history[proj.name] || []).find((r) => r.id === req.body?.id);
    if (!record?.backupFile) throw new HttpError(404, 'No backup for this apply');
    const file = path.join(backups.BACKUP_DIR, record.backupFile);
    if (!fs.existsSync(file)) throw new HttpError(404, 'That backup was deleted (only the last 3 automatic backups are kept)');
    const settings = deploys.get(proj.name) || {};
    const folder = path.basename(proj.cwd);
    const job = ctx.startJob(`Rollback ${proj.name}`, [
      'set -e',
      'TMP=$(mktemp -d)',
      'trap \'rm -rf "$TMP"\' EXIT',
      `echo "⏪ Restoring files from ${record.backupFile}"`,
      `tar -xzf ${q(file)} -C "$TMP"`,
      // exact restore (files added since are removed), but keep node_modules and .git
      `if command -v rsync >/dev/null; then rsync -a --delete --exclude node_modules --exclude .git "$TMP/"${q(folder)}/ ${q(proj.cwd + '/')}; else cp -a "$TMP/"${q(folder)}/. ${q(proj.cwd)}; fi`,
      `cd ${q(proj.cwd)}`,
      settings.installCmd || ctx.installCmd,
      settings.buildCmd || 'true',
      `pm2 ${proj.mode === 'cluster' ? 'reload' : 'restart'} ${q(proj.name)}`,
      'pm2 save',
      `echo "✅ ${proj.name} is back to how it was before the upload of ${new Date(record.at).toLocaleString()}"`,
    ].join('\n'), { project: proj.name, kind: 'rollback' });
    record.rolledBackAt = Date.now();
    remember(record);
    res.json({ success: true, message: `Rolling back ${proj.name}…`, jobId: job.id });
  });

  return { health };
};
