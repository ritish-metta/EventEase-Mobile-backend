// ops-agent/server.js
// Standalone control panel for the whole server. Runs as its own PM2 process
// ("ops-agent", port 7000) so it stays reachable even when the apps it manages
// are stopped or crashing.
//
// Auth: every API call and socket needs OPS_TOKEN (read from ops-agent/.env or
// the parent project's .env). Only GET /api/health is public.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const express = require('express');
const { Server } = require('socket.io');

for (const file of [path.join(__dirname, '.env'), path.join(__dirname, '..', '.env')]) {
  if (fs.existsSync(file)) process.loadEnvFile(file); // first file wins, never overrides
}

const PORT = parseInt(process.env.OPS_PORT, 10) || 7000;
const OPS_TOKEN = process.env.OPS_TOKEN;
const AGENT_NAME = process.env.OPS_AGENT_NAME || 'ops-agent';
const HOME = os.homedir();
const USER = os.userInfo().username;

// Commands we spawn get a clean environment. Passing our own env along would leak
// this agent's PM2 variables and the parent project's .env (PORT etc.) into every
// app started or restarted from the dashboard.
const CLEAN_ENV = {
  HOME,
  USER,
  LOGNAME: USER,
  PATH: process.env.PATH,
  LANG: process.env.LANG || 'C.UTF-8',
  SHELL: '/bin/bash',
  TERM: 'xterm-256color',
};

let pty = null;
try {
  pty = require('node-pty');
} catch {
  console.log('node-pty not available — terminal falls back to `script` (no live resize)');
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // single-quote for bash

const run = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 20000, maxBuffer: 20 * 1024 * 1024, env: CLEAN_ENV, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve(opts.raw ? stdout : stdout.trim()); // raw: keep leading spaces (git porcelain)
    });
  });

const safeRun = (cmd, args, opts) => run(cmd, args, opts).catch(() => null);

const tailFile = (file, lines) => {
  if (!file || !fs.existsSync(file)) return [];
  const { size } = fs.statSync(file);
  const bytes = Math.min(size, 512 * 1024);
  const buf = Buffer.alloc(bytes);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, buf, 0, bytes, size - bytes);
  fs.closeSync(fd);
  return buf.toString('utf8').split('\n').filter(Boolean).slice(-lines);
};

// Resolves p (absolute or relative to HOME) and returns it only if it stays inside
// HOME. Symlinks are followed on the part that exists, so they can't escape HOME.
const insideHome = (p) => {
  let existing = path.resolve(HOME, p);
  const missing = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return null;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  const real = path.join(fs.realpathSync(existing), ...missing);
  return real === HOME || real.startsWith(HOME + path.sep) ? real : null;
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const NAME_RE = /^[\w.-]{1,50}$/;
const BRANCH_RE = /^[\w./-]{1,100}$/;
const SCRIPT_RE = /^[\w./-]{1,200}$/;
const REPO_RE = /^(https:\/\/[\w.-]+\/[\w./~-]+|git@[\w.-]+:[\w./~-]+)$/;

// ─────────────────────────────────────────────
// Auth — constant-time compare + lockout after repeated failures per IP
// ─────────────────────────────────────────────
const failures = new Map(); // ip -> { count, first }
const LOCK_AFTER = 10;
const LOCK_WINDOW_MS = 15 * 60 * 1000;

function verifyToken(token, ip) {
  if (!OPS_TOKEN) return 'OPS_TOKEN is not set on the server';
  const now = Date.now();
  const f = failures.get(ip);
  if (f && now - f.first > LOCK_WINDOW_MS) failures.delete(ip);
  const current = failures.get(ip);
  if (current && current.count >= LOCK_AFTER) return 'Too many wrong tokens — locked for 15 minutes';

  const given = Buffer.from(String(token || ''));
  const want = Buffer.from(OPS_TOKEN);
  if (given.length === want.length && crypto.timingSafeEqual(given, want)) {
    failures.delete(ip);
    return null;
  }
  failures.set(ip, { count: (current?.count || 0) + 1, first: current?.first || now });
  return 'Invalid ops token';
}

// ─────────────────────────────────────────────
// Jobs — long-running commands whose output streams to the Activity tab
// ─────────────────────────────────────────────
const jobs = []; // newest first
const MAX_JOBS = 40;
let opsNs; // socket.io namespace, set below

const jobSummary = ({ output, ...rest }) => rest;

function startJob(title, command, { cwd = HOME, detached = false } = {}) {
  const job = {
    id: crypto.randomUUID().slice(0, 8),
    title,
    command,
    status: 'running',
    output: '',
    startedAt: Date.now(),
    endedAt: null,
  };
  jobs.unshift(job);
  if (jobs.length > MAX_JOBS) jobs.length = MAX_JOBS;

  if (detached) {
    // Used for commands that restart this agent (or the machine). A normal child
    // would be killed together with us halfway through, so double-fork it away.
    spawn('bash', ['-lc', `(${command}) > /dev/null 2>&1 &`], { cwd, env: CLEAN_ENV, detached: true, stdio: 'ignore' }).unref();
    job.status = 'sent';
    job.output = 'Sent. This restarts the agent or the server, so the page will reconnect in a few seconds.\n';
    job.endedAt = Date.now();
    opsNs?.emit('job', job);
    return job;
  }

  opsNs?.emit('job', job);
  const child = spawn('bash', ['-lc', command], { cwd, env: CLEAN_ENV });
  const append = (chunk) => {
    const text = chunk.toString();
    job.output = (job.output + text).slice(-300000);
    opsNs?.emit('job:output', { id: job.id, text });
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('close', (code) => {
    job.status = code === 0 ? 'success' : 'failed';
    job.exitCode = code;
    job.endedAt = Date.now();
    opsNs?.emit('job', jobSummary(job));
  });
  return job;
}

// ─────────────────────────────────────────────
// PM2 projects
// ─────────────────────────────────────────────
async function pm2List() {
  const out = await run('pm2', ['jlist']);
  return JSON.parse(out.slice(out.indexOf('[')));
}

async function getProjects({ withGit = false } = {}) {
  const byName = new Map();
  for (const p of await pm2List()) {
    const env = p.pm2_env;
    if (!byName.has(p.name)) {
      byName.set(p.name, {
        name: p.name,
        cwd: env.pm_cwd,
        script: env.pm_exec_path,
        mode: env.exec_mode === 'cluster_mode' ? 'cluster' : 'fork',
        isAgent: p.name === AGENT_NAME,
        instances: [],
        logs: { out: new Set(), err: new Set() },
      });
    }
    const proj = byName.get(p.name);
    proj.instances.push({
      id: p.pm_id,
      pid: p.pid,
      status: env.status,
      cpu: p.monit?.cpu ?? 0,
      memory: p.monit?.memory ?? 0,
      restarts: env.restart_time,
      startedAt: env.pm_uptime,
    });
    proj.logs.out.add(env.pm_out_log_path);
    proj.logs.err.add(env.pm_err_log_path);
  }

  const projects = [...byName.values()].map((p) => ({
    ...p,
    logs: { out: [...p.logs.out], err: [...p.logs.err] },
    online: p.instances.filter((i) => i.status === 'online').length,
    cpu: p.instances.reduce((s, i) => s + i.cpu, 0),
    memory: p.instances.reduce((s, i) => s + i.memory, 0),
    restarts: p.instances.reduce((s, i) => s + i.restarts, 0),
  }));

  if (withGit) {
    await Promise.all(projects.map(async (p) => {
      const log = await safeRun('git', ['-C', p.cwd, 'log', '-1', '--format=%h%n%s%n%cr']);
      const branch = await safeRun('git', ['-C', p.cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
      if (log) {
        const [commit, message, when] = log.split('\n');
        p.git = { branch, commit, message, when };
      }
    }));
  }
  return projects;
}

async function findProject(name) {
  const proj = (await getProjects()).find((p) => p.name === name);
  if (!proj) throw new HttpError(404, `No PM2 project named "${name}"`);
  return proj;
}

const installCmd = 'if [ -f package-lock.json ]; then npm ci --omit=dev; elif [ -f package.json ]; then npm install --omit=dev; fi';

// ─────────────────────────────────────────────
// App + API
// ─────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ success: true, agent: AGENT_NAME, uptimeSec: Math.round(process.uptime()), terminal: pty ? 'pty' : 'script' });
});

app.use('/api', (req, res, next) => {
  const error = verifyToken(req.header('x-ops-token'), req.ip);
  if (error) return res.status(401).json({ success: false, message: error });
  next();
});

// ── Feature modules (features/*.js) ─────────
const ctx = {
  app,
  run,
  safeRun,
  q,
  tailFile,
  HttpError,
  startJob,
  getProjects,
  findProject,
  failures,
  NAME_RE,
  AGENT_NAME,
  CLEAN_ENV,
  emit: (event, data) => opsNs?.emit(event, data),
};
const security = require('./features/security')(ctx);
app.use('/api', security.auditMiddleware);

const settings = require('./features/settings')(ctx);
const metrics = require('./features/metrics')(ctx);
const alerts = require('./features/alerts')(ctx, { metrics, settings });
require('./features/monitors')(ctx, { alerts });
require('./features/redis')(ctx);
require('./features/cron')(ctx);
const backups = require('./features/backups')(ctx);

// Pending Ubuntu updates, cached — apt-check takes a second or two.
let updatesCache = { at: 0, value: null };
async function pendingUpdates() {
  if (Date.now() - updatesCache.at < 30 * 60 * 1000) return updatesCache.value;
  const value = await new Promise((resolve) => {
    // apt-check prints "<updates>;<security updates>" on stderr
    execFile('/usr/lib/update-notifier/apt-check', [], { timeout: 30000 }, (err, stdout, stderr) => {
      const m = /^(\d+);(\d+)/.exec(String(stderr).trim());
      resolve(m ? { total: +m[1], security: +m[2] } : null);
    });
  });
  updatesCache = { at: Date.now(), value };
  return value;
}

// ── Run a one-off command ───────────────────
app.post('/api/run', (req, res) => {
  const command = String(req.body?.command || '').trim();
  if (!command) throw new HttpError(400, 'command is required');
  const cwd = req.body?.cwd ? insideHome(req.body.cwd) : HOME;
  if (!cwd || !fs.existsSync(cwd)) throw new HttpError(400, `Folder must exist inside ${HOME}`);
  const job = startJob(`$ ${command.length > 60 ? command.slice(0, 57) + '…' : command}`, command, { cwd });
  res.json({ success: true, message: 'Command started', jobId: job.id });
});

// ── System ──────────────────────────────────
app.get('/api/system', async (req, res) => {
  const [df, ps, ss, updates] = await Promise.all([
    safeRun('df', ['-kP', '/']),
    safeRun('ps', ['-eo', 'pid,user,pcpu,pmem,etime,args', '--sort=-pcpu']),
    safeRun('ss', ['-tlnpH']),
    pendingUpdates(),
  ]);
  const mem = metrics.memInfo();

  let disk = null;
  if (df) {
    const cols = df.split('\n')[1].split(/\s+/);
    disk = { totalBytes: +cols[1] * 1024, usedBytes: +cols[2] * 1024, freeBytes: +cols[3] * 1024 };
  }

  const processes = (ps || '').split('\n').slice(1, 13).map((line) => {
    const [pid, user, cpu, mem, elapsed, ...cmd] = line.trim().split(/\s+/);
    return { pid: +pid, user, cpu: +cpu, mem: +mem, elapsed, command: cmd.join(' ') };
  });

  const ports = (ss || '').split('\n').filter(Boolean).map((line) => {
    const cols = line.trim().split(/\s+/);
    const local = cols[3] || '';
    const proc = (line.match(/users:\(\("([^"]+)",pid=(\d+)/) || []);
    return { address: local, port: +local.slice(local.lastIndexOf(':') + 1), process: proc[1] || '', pid: proc[2] ? +proc[2] : null };
  }).sort((a, b) => a.port - b.port);

  res.json({
    success: true,
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    node: process.version,
    user: USER,
    cpus: os.cpus().length,
    loadAvg: os.loadavg(),
    // "free" = MemAvailable (includes reclaimable cache), not MemFree
    memory: { totalBytes: mem.totalBytes, freeBytes: mem.availableBytes },
    swap: { totalBytes: mem.swapTotalBytes, freeBytes: mem.swapFreeBytes },
    disk,
    updates,
    rebootRequired: fs.existsSync('/var/run/reboot-required'),
    uptimeSec: Math.round(os.uptime()),
    processes,
    ports,
  });
});

app.post('/api/system/kill', (req, res) => {
  const pid = parseInt(req.body?.pid, 10);
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) throw new HttpError(400, 'Invalid pid');
  process.kill(pid, req.body?.force ? 'SIGKILL' : 'SIGTERM');
  res.json({ success: true, message: `Signal sent to ${pid}` });
});

// ── Projects ────────────────────────────────
app.get('/api/projects', async (req, res) => {
  res.json({ success: true, projects: await getProjects({ withGit: true }) });
});

app.post('/api/projects', async (req, res) => {
  const { name, repo, branch = 'main', script = 'app.js', dir, instances = 1, cluster = false } = req.body || {};
  if (!NAME_RE.test(name || '')) throw new HttpError(400, 'Name: letters, numbers, . _ - only');
  if (!REPO_RE.test(repo || '')) throw new HttpError(400, 'Repo must be an https:// or git@ URL');
  if (!BRANCH_RE.test(branch)) throw new HttpError(400, 'Invalid branch');
  if (!SCRIPT_RE.test(script) || script.includes('..')) throw new HttpError(400, 'Invalid start script');
  const n = parseInt(instances, 10);
  if (!Number.isInteger(n) || n < 1 || n > 8) throw new HttpError(400, 'Instances must be 1–8');
  const target = insideHome(dir || name);
  if (!target || target === HOME) throw new HttpError(400, `Folder must be inside ${HOME}`);
  if ((await getProjects()).some((p) => p.name === name)) throw new HttpError(409, `A PM2 project named "${name}" already exists`);

  const job = startJob(`Add project ${name}`, [
    'set -e',
    `if [ -d ${q(target + '/.git')} ]; then echo "Folder exists, pulling latest"; cd ${q(target)}; git pull; else git clone --branch ${q(branch)} ${q(repo)} ${q(target)}; cd ${q(target)}; fi`,
    installCmd,
    `pm2 start ${q(script)} --name ${q(name)}${cluster ? ` -i ${n}` : ''}`,
    'pm2 save',
    `echo "✅ ${name} is running"`,
  ].join('\n'));
  res.json({ success: true, message: `Adding ${name}…`, jobId: job.id });
});

app.post('/api/projects/:name/:action', async (req, res) => {
  const { name, action } = req.params;
  const proj = await findProject(name);
  let job;

  switch (action) {
    case 'start':
    case 'stop':
    case 'restart':
    case 'reload':
    case 'delete': {
      if (proj.isAgent && ['stop', 'delete'].includes(action)) {
        throw new HttpError(400, 'Stopping the ops agent would lock you out of this dashboard');
      }
      job = startJob(`${action} ${name}`, `pm2 ${action} ${q(name)} && pm2 save`, { detached: proj.isAgent });
      break;
    }
    case 'scale': {
      const n = parseInt(req.body?.instances, 10);
      if (proj.mode !== 'cluster') throw new HttpError(400, 'Scaling only works in cluster mode');
      if (!Number.isInteger(n) || n < 1 || n > 8) throw new HttpError(400, 'Instances must be 1–8');
      job = startJob(`scale ${name} → ${n}`, `pm2 scale ${q(name)} ${n} && pm2 save`, { detached: proj.isAgent });
      break;
    }
    case 'deploy': {
      const branch = await run('git', ['-C', proj.cwd, 'rev-parse', '--abbrev-ref', 'HEAD']).catch(() => {
        throw new HttpError(400, `${proj.cwd} is not a git repository`);
      });
      // body.commit = rollback / deploy a specific older version instead of the branch tip
      const commit = req.body?.commit;
      if (commit && !/^[0-9a-f]{4,40}$/i.test(commit)) throw new HttpError(400, 'Invalid commit hash');
      job = startJob(commit ? `rollback ${name} → ${commit}` : `deploy ${name} (${branch})`, [
        'set -e',
        `cd ${q(proj.cwd)}`,
        `git fetch origin ${q(branch)}`,
        `git reset --hard ${q(commit || 'origin/' + branch)}`,
        installCmd,
        `pm2 reload ${q(name)}`,
        'pm2 save',
        `echo "✅ ${name} deployed: $(git log -1 --format='%h %s')"`,
      ].join('\n'), { cwd: proj.cwd, detached: proj.isAgent });
      break;
    }
    case 'flush':
      job = startJob(`clear logs ${name}`, `pm2 flush ${q(name)}`);
      break;
    case 'commit': {
      // Save server-side edits to GitHub so the next deploy doesn't wipe them.
      // The push then triggers the normal CI/CD deploy.
      const message = String(req.body?.message || '').trim();
      if (!message) throw new HttpError(400, 'A commit message is required');
      const branch = await run('git', ['-C', proj.cwd, 'rev-parse', '--abbrev-ref', 'HEAD']);
      const files = Array.isArray(req.body?.files) && req.body.files.length
        ? req.body.files.map((f) => q(projectFile(proj, f))).join(' ')
        : '-A';
      job = startJob(`commit & push ${name}: ${message.slice(0, 50)}`, [
        'set -e',
        `cd ${q(proj.cwd)}`,
        `git add ${files}`,
        // nothing staged (e.g. retrying a failed push) → skip straight to the push
        `git diff --cached --quiet || git -c user.name=${q('Server Control Panel')} -c user.email=${q(`panel@${os.hostname()}`)} commit -m ${q(message)}`,
        `git push origin ${q(branch)} || { echo; echo "❌ Push failed. The server needs WRITE access to GitHub:"; echo "   1) GitHub repo → Settings → Deploy keys → add ~/.ssh/id_ed25519.pub with 'Allow write access'"; echo "   2) Use the SSH remote:  git remote set-url origin git@github.com:OWNER/REPO.git"; echo "   Your commit is saved on the server; click Commit & push again after fixing access."; exit 1; }`,
        'echo "✅ Pushed. GitHub Actions will now deploy it."',
      ].join('\n'), { cwd: proj.cwd });
      break;
    }
    case 'destroy': {
      // Delete a project for good: stop it, drop it from PM2, remove its folder.
      if (req.body?.confirm !== name) throw new HttpError(400, 'Type the project name to confirm');
      if (proj.isAgent) throw new HttpError(400, 'The control panel cannot delete itself');
      const dir = insideHome(proj.cwd);
      if (!dir || dir === HOME || isProtected(dir)) throw new HttpError(400, `Refusing to delete ${proj.cwd}`);
      if (__dirname === dir || __dirname.startsWith(dir + path.sep)) {
        throw new HttpError(400, `${dir} also contains this control panel. Remove it from PM2 instead, or move the panel first`);
      }
      // other PM2 apps living in the same folder would lose their files too
      const neighbours = (await getProjects()).filter((p) => p.name !== name && (p.cwd === dir || p.cwd.startsWith(dir + path.sep)));
      if (neighbours.length) throw new HttpError(400, `Also used by: ${neighbours.map((p) => p.name).join(', ')}. Delete those first`);

      // safety net: snapshot first, so a deleted project can be restored from Backups
      const backup = backups.backupCommand(proj);
      job = startJob(`DELETE project ${name}`, [
        'set -e',
        backup.command,
        'set +e',
        `pm2 delete ${q(name)} || true`,
        'pm2 save',
        `rm -rf -- ${q(dir)}`,
        `echo "🗑️  ${name} removed from PM2 and ${dir} deleted"`,
      ].join('\n'));
      break;
    }
    case 'discard': {
      // Throw away server-side edits to one file (or all tracked files).
      const file = req.body?.file ? projectFile(proj, req.body.file) : null;
      job = startJob(`discard changes ${name}${file ? `: ${file}` : ''}`,
        `cd ${q(proj.cwd)} && git checkout -- ${file ? q(file) : '.'} && git status --short`, { cwd: proj.cwd });
      break;
    }
    default:
      throw new HttpError(400, `Unknown action "${action}"`);
  }
  res.json({ success: true, message: `${job.title} started`, jobId: job.id });
});

app.get('/api/projects/:name/logs', async (req, res) => {
  const proj = await findProject(req.params.name);
  const lines = Math.min(parseInt(req.query.lines, 10) || 200, 3000);
  const files = req.query.type === 'err' ? proj.logs.err : proj.logs.out;
  const all = files.flatMap((f) => tailFile(f, lines).map((l) => (files.length > 1 ? `[${path.basename(f)}] ${l}` : l)));
  res.json({ success: true, lines: all.slice(-lines) });
});

app.get('/api/projects/:name/git', async (req, res) => {
  const { cwd } = await findProject(req.params.name);
  const branch = await run('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD']).catch(() => {
    throw new HttpError(400, `${cwd} is not a git repository`);
  });
  await safeRun('git', ['-C', cwd, 'fetch', '-q', 'origin', branch], { timeout: 30000 });
  const [remote, counts, status, log] = await Promise.all([
    safeRun('git', ['-C', cwd, 'remote', 'get-url', 'origin']),
    safeRun('git', ['-C', cwd, 'rev-list', '--left-right', '--count', `HEAD...origin/${branch}`]),
    safeRun('git', ['-C', cwd, 'status', '--porcelain'], { raw: true }),
    safeRun('git', ['-C', cwd, 'log', '-15', '--format=%h|%s|%an|%cr']),
  ]);
  const [ahead, behind] = (counts || '0 0').split(/\s+/).map(Number);
  res.json({
    success: true,
    cwd,
    branch,
    remote,
    ahead,
    behind,
    changedFiles: (status || '').split('\n').filter(Boolean),
    commits: (log || '').split('\n').filter(Boolean).map((l) => {
      const [hash, message, author, when] = l.split('|');
      return { hash, message, author, when };
    }),
  });
});

// A file inside a project, given relative to the project folder.
function projectFile(proj, file) {
  const target = insideHome(path.join(proj.cwd, String(file || '')));
  if (!target || !(target === proj.cwd || target.startsWith(proj.cwd + path.sep))) {
    throw new HttpError(400, 'File must be inside the project folder');
  }
  return path.relative(proj.cwd, target).split(path.sep).join('/');
}

// Version of a file in the last commit, for the code editor's diff view.
app.get('/api/projects/:name/original', async (req, res) => {
  const proj = await findProject(req.params.name);
  const rel = projectFile(proj, req.query.file);
  const content = await run('git', ['-C', proj.cwd, 'show', `HEAD:${rel}`]).catch(() => null);
  res.json({ success: true, file: rel, exists: content !== null, content: content ?? '' });
});

app.get('/api/projects/:name/env', async (req, res) => {
  const { cwd } = await findProject(req.params.name);
  const file = path.join(cwd, '.env');
  const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

  // keys listed in .env.example but missing (or empty) in .env
  const keys = (text) => new Map(text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).replace(/^export\s+/, '').trim(), l.slice(l.indexOf('=') + 1).trim()]));
  const exampleFile = path.join(cwd, '.env.example');
  let missing = null;
  if (fs.existsSync(exampleFile)) {
    const have = keys(content);
    missing = [...keys(fs.readFileSync(exampleFile, 'utf8')).keys()].filter((k) => !have.get(k));
  }
  res.json({ success: true, path: file, exists: fs.existsSync(file), content, missing });
});

app.put('/api/projects/:name/env', async (req, res) => {
  const { cwd } = await findProject(req.params.name);
  if (typeof req.body?.content !== 'string') throw new HttpError(400, 'content is required');
  const file = path.join(cwd, '.env');
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  fs.writeFileSync(file, req.body.content);
  res.json({ success: true, message: 'Saved (old version kept as .env.bak). Restart the project to apply.' });
});

// ── Services (systemd) ──────────────────────
const SERVICES = ['redis-server', 'nginx', 'mongod', 'docker', 'cron', 'ssh', `pm2-${USER}`];
const PROTECTED_SERVICES = new Set(['ssh', `pm2-${USER}`]); // stopping these locks you out

app.get('/api/services', async (req, res) => {
  const services = (await Promise.all(SERVICES.map(async (name) => {
    const out = await safeRun('systemctl', ['show', name, '-p', 'LoadState,ActiveState,SubState,Description']);
    if (!out) return null;
    const info = Object.fromEntries(out.split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    if (info.LoadState !== 'loaded') return null;
    return { name, description: info.Description, active: info.ActiveState, sub: info.SubState, protected: PROTECTED_SERVICES.has(name) };
  }))).filter(Boolean);
  res.json({ success: true, services });
});

app.post('/api/services/:name/:action', (req, res) => {
  const { name, action } = req.params;
  if (!SERVICES.includes(name)) throw new HttpError(404, 'Unknown service');
  if (!['start', 'stop', 'restart'].includes(action)) throw new HttpError(400, 'Unknown action');
  if (action === 'stop' && PROTECTED_SERVICES.has(name)) throw new HttpError(400, `Stopping ${name} would lock you out of the server`);
  const job = startJob(`${action} service ${name}`, `sudo systemctl ${action} ${q(name)} && systemctl status ${q(name)} --no-pager | head -5`);
  res.json({ success: true, message: job.title + ' started', jobId: job.id });
});

// ── Server ──────────────────────────────────
app.post('/api/server/:action', (req, res) => {
  const actions = {
    reboot: ['Reboot server', 'sleep 2 && sudo reboot', true],
    update: ['Update system packages', 'sudo DEBIAN_FRONTEND=noninteractive apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y', false],
    'clean-logs': ['Clean logs', 'pm2 flush && sudo journalctl --vacuum-size=100M && df -h /', false],
    'pm2-save': ['Save PM2 process list', 'pm2 save', false],
    swap: ['Create 2 GB swap', [
      'if [ -n "$(swapon --show --noheadings)" ]; then echo "Swap is already on:"; swapon --show; exit 0; fi',
      'set -e',
      'sudo fallocate -l 2G /swapfile',
      'sudo chmod 600 /swapfile',
      'sudo mkswap /swapfile',
      'sudo swapon /swapfile',
      "grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab",
      'free -h',
    ].join('\n'), false],
  };
  const entry = actions[req.params.action];
  if (!entry) throw new HttpError(400, 'Unknown server action');
  const [title, command, detached] = entry;
  const job = startJob(title, command, { detached });
  res.json({ success: true, message: `${title} started`, jobId: job.id });
});

// ── Files (inside the home folder) ──────────
app.get('/api/files', (req, res) => {
  const target = insideHome(req.query.path || HOME);
  if (!target) throw new HttpError(403, `Only files inside ${HOME} can be opened`);
  if (!fs.existsSync(target)) throw new HttpError(404, 'Not found');
  const stat = fs.statSync(target);

  if (stat.isDirectory()) {
    const entries = fs.readdirSync(target, { withFileTypes: true }).map((d) => {
      let size = 0;
      let mtime = null;
      try {
        const s = fs.statSync(path.join(target, d.name));
        size = s.size;
        mtime = s.mtimeMs;
      } catch {
        // broken symlink
      }
      return { name: d.name, type: d.isDirectory() ? 'dir' : 'file', size, mtime };
    }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return res.json({ success: true, type: 'dir', path: target, home: HOME, entries });
  }

  if (stat.size > 1024 * 1024) throw new HttpError(413, 'File is larger than 1 MB — open it in the terminal instead');
  const buf = fs.readFileSync(target);
  if (buf.includes(0)) throw new HttpError(415, 'Binary file — cannot be shown');
  res.json({ success: true, type: 'file', path: target, home: HOME, content: buf.toString('utf8') });
});

// Deleting or renaming these would lock you out (ssh keys) or kill every app (PM2 state).
const PROTECTED_DIRS = ['.ssh', '.pm2'].map((d) => path.join(HOME, d));
const isProtected = (p) => p === HOME || PROTECTED_DIRS.some((d) => p === d || p.startsWith(d + path.sep));

const homePath = (p, what = 'path') => {
  const target = insideHome(p || '');
  if (!target) throw new HttpError(403, `The ${what} must be inside ${HOME}`);
  return target;
};

// Every file under a folder (relative paths), for the editor's "Go to file".
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache', 'coverage']);
app.get('/api/files/tree', (req, res) => {
  const root = homePath(req.query.root, 'folder');
  const files = [];
  const MAX = 10000;
  const walk = (dir, rel, depth) => {
    if (files.length >= MAX || depth > 15) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length >= MAX) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), r, depth + 1);
      } else if (e.isFile()) files.push(r);
    }
  };
  walk(root, '', 0);
  res.json({ success: true, root, files, truncated: files.length >= MAX });
});

// Search text inside files (grep), for the editor's "Find in files".
app.get('/api/files/grep', async (req, res) => {
  const root = homePath(req.query.root, 'folder');
  const query = String(req.query.q || '');
  if (!query) throw new HttpError(400, 'Search text is required');
  const args = ['-rnI', '--color=never', '-m', '30'];
  if (req.query.case !== '1') args.push('-i');
  if (req.query.regex !== '1') args.push('-F');
  if (req.query.word === '1') args.push('-w');
  for (const d of SKIP_DIRS) args.push(`--exclude-dir=${d}`);
  args.push('--exclude=*.min.js', '--exclude=package-lock.json', '-e', query, '--', '.');

  const out = await new Promise((resolve, reject) => {
    execFile('grep', args, { cwd: root, timeout: 20000, maxBuffer: 10 * 1024 * 1024, env: CLEAN_ENV }, (err, stdout, stderr) => {
      if (err && err.code === 1) return resolve(''); // grep exits 1 when nothing matches
      if (err && !stdout) return reject(new HttpError(400, stderr.trim() || err.message));
      resolve(stdout);
    });
  });

  const MAX_RESULTS = 500;
  const matches = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const m = /^\.\/(.+?):(\d+):(.*)$/.exec(line);
    if (m) matches.push({ file: m[1], line: Number(m[2]), text: m[3].slice(0, 400) });
    if (matches.length >= MAX_RESULTS) break;
  }
  res.json({ success: true, root, matches, truncated: matches.length >= MAX_RESULTS });
});

app.post('/api/files/mkdir', (req, res) => {
  const target = homePath(req.body?.path, 'folder');
  if (fs.existsSync(target)) throw new HttpError(409, 'Already exists');
  fs.mkdirSync(target, { recursive: true });
  res.json({ success: true, message: `Created ${target}` });
});

app.post('/api/files/rename', (req, res) => {
  const from = homePath(req.body?.from);
  const to = homePath(req.body?.to);
  if (!fs.existsSync(from)) throw new HttpError(404, 'Not found');
  if (isProtected(from)) throw new HttpError(403, `${from} is protected`);
  if (fs.existsSync(to)) throw new HttpError(409, `${path.basename(to)} already exists`);
  fs.renameSync(from, to);
  res.json({ success: true, message: `Renamed to ${path.basename(to)}` });
});

app.delete('/api/files', (req, res) => {
  const target = homePath(req.query.path);
  if (!fs.existsSync(target)) throw new HttpError(404, 'Not found');
  if (isProtected(target)) throw new HttpError(403, `${target} is protected`);
  fs.rmSync(target, { recursive: true });
  res.json({ success: true, message: `Deleted ${path.basename(target)}` });
});

app.get('/api/files/download', (req, res) => {
  const target = homePath(req.query.path);
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) throw new HttpError(404, 'File not found');
  res.download(target);
});

// name may contain sub-folders ("src/routes/a.js") so whole project folders can be dropped in
app.post('/api/files/upload', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  const name = String(req.query.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = name.split('/');
  if (!name || parts.some((p) => !p || p === '.' || p === '..')) throw new HttpError(400, 'Invalid file name');
  const dir = homePath(req.query.dir, 'folder');
  const target = homePath(path.join(dir, ...parts));
  if (isProtected(target)) throw new HttpError(403, `${target} is protected`);
  if (fs.existsSync(target) && req.query.overwrite !== '1') throw new HttpError(409, `${name} already exists`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0); // empty upload → {} from express.raw
  fs.writeFileSync(target, data);
  res.json({ success: true, message: `Uploaded ${name} (${data.length} bytes)` });
});

// Copy a file or a whole folder (explorer copy → paste, duplicate).
app.post('/api/files/copy', (req, res) => {
  const from = homePath(req.body?.from);
  let to = homePath(req.body?.to);
  if (!fs.existsSync(from)) throw new HttpError(404, 'Source not found');
  // same path = duplicate (gets a "copy" name below); inside itself = impossible
  if (to.startsWith(from + path.sep)) throw new HttpError(400, 'Cannot copy a folder into itself');
  if (fs.existsSync(to)) {
    // paste next to an existing name → "name copy", "name copy 2"…
    const ext = fs.statSync(from).isDirectory() ? '' : path.extname(to);
    const stem = to.slice(0, to.length - ext.length);
    let n = 1;
    do { to = `${stem} copy${n > 1 ? ' ' + n : ''}${ext}`; n++; } while (fs.existsSync(to));
  }
  fs.cpSync(from, to, { recursive: true, errorOnExist: true });
  res.json({ success: true, message: `Copied to ${path.basename(to)}`, path: to });
});

// Download a folder (or a whole project) as .tar.gz, without node_modules and .git.
app.get('/api/files/archive', (req, res) => {
  const target = homePath(req.query.path, 'folder');
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new HttpError(404, 'Folder not found');
  const name = path.basename(target) || 'home';
  const excludes = req.query.full === '1' ? [] : ['--exclude=node_modules', '--exclude=.git'];
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${name}.tar.gz"`);
  const tar = spawn('tar', ['-czf', '-', ...excludes, '-C', path.dirname(target), name], { env: CLEAN_ENV });
  tar.stdout.pipe(res);
  tar.on('error', () => res.destroy());
  req.on('close', () => tar.kill());
});

app.put('/api/files', (req, res) => {
  const target = insideHome(req.body?.path || '');
  if (!target) throw new HttpError(403, `Only files inside ${HOME} can be saved`);
  if (typeof req.body?.content !== 'string') throw new HttpError(400, 'content is required');
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) throw new HttpError(400, 'That path is a folder');
  fs.writeFileSync(target, req.body.content);
  res.json({ success: true, message: `Saved ${target}` });
});

// ── Jobs ────────────────────────────────────
app.get('/api/jobs', (req, res) => res.json({ success: true, jobs: jobs.map(jobSummary) }));

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.find((j) => j.id === req.params.id);
  if (!job) throw new HttpError(404, 'Job not found');
  res.json({ success: true, job });
});

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ success: false, message: err.message });
});

// ─────────────────────────────────────────────
// Sockets — live job output, live logs, terminal
// ─────────────────────────────────────────────
const server = http.createServer(app);
const io = new Server(server);

const socketAuth = (socket, next) => {
  const error = verifyToken(socket.handshake.auth?.token, socket.handshake.address);
  error ? next(new Error(error)) : next();
};

opsNs = io.of('/ops');
opsNs.use(socketAuth);
opsNs.on('connection', (socket) => {
  let follower = null;
  const stopFollow = () => {
    follower?.kill();
    follower = null;
  };

  socket.on('logs:follow', async ({ name, type }) => {
    stopFollow();
    try {
      const proj = await findProject(name);
      const files = (type === 'err' ? proj.logs.err : proj.logs.out).filter((f) => fs.existsSync(f));
      if (!files.length) return socket.emit('logs:data', '(no log files yet)\n');
      follower = spawn('tail', ['-n', '100', '-F', ...files], { env: CLEAN_ENV });
      follower.stdout.on('data', (d) => socket.emit('logs:data', d.toString()));
    } catch (err) {
      socket.emit('logs:data', `Error: ${err.message}\n`);
    }
  });
  socket.on('logs:stop', stopFollow);
  socket.on('disconnect', stopFollow);
});

const termNs = io.of('/terminal');
termNs.use(socketAuth);
termNs.on('connection', (socket) => {
  const clamp = (v, min, max, def) => Math.min(max, Math.max(min, parseInt(v, 10) || def));
  const cols = clamp(socket.handshake.query.cols, 20, 500, 120);
  const rows = clamp(socket.handshake.query.rows, 5, 200, 30);
  // the code editor opens its terminal inside the project folder
  let cwd = HOME;
  try {
    const wanted = socket.handshake.query.cwd ? insideHome(String(socket.handshake.query.cwd)) : null;
    if (wanted && fs.existsSync(wanted) && fs.statSync(wanted).isDirectory()) cwd = wanted;
  } catch {
    // fall back to HOME
  }

  if (pty) {
    const term = pty.spawn('bash', ['-l'], { name: 'xterm-256color', cols, rows, cwd, env: CLEAN_ENV });
    term.onData((d) => socket.emit('output', d));
    term.onExit(() => {
      socket.emit('exit');
      socket.disconnect();
    });
    socket.on('input', (d) => term.write(d));
    socket.on('resize', (size) => term.resize(clamp(size?.cols, 20, 500, cols), clamp(size?.rows, 5, 200, rows)));
    socket.on('disconnect', () => term.kill());
    return;
  }

  // Fallback without node-pty: util-linux `script` allocates the pty for us.
  const child = spawn('script', ['-qfc', 'bash -l', '/dev/null'], { cwd, env: CLEAN_ENV });
  child.stdin.write(`stty cols ${cols} rows ${rows}; cd ${q(cwd)}; clear\n`);
  child.stdout.on('data', (d) => socket.emit('output', d.toString()));
  child.stderr.on('data', (d) => socket.emit('output', d.toString()));
  child.on('exit', () => {
    socket.emit('exit');
    socket.disconnect();
  });
  socket.on('input', (d) => child.stdin.write(d));
  socket.on('disconnect', () => child.kill());
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🛠️  Ops agent running on http://0.0.0.0:${PORT}`);
  if (!OPS_TOKEN) console.log('⚠️  OPS_TOKEN is not set — every request will be refused');
});
