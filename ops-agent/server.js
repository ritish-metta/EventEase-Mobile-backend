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
      resolve(stdout.trim());
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

const insideHome = (p) => {
  const resolved = path.resolve(HOME, p);
  let real = resolved;
  try {
    real = fs.realpathSync(resolved); // follow symlinks so they can't escape HOME
  } catch {
    real = path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  }
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

// ── System ──────────────────────────────────
app.get('/api/system', async (req, res) => {
  const [df, ps, ss] = await Promise.all([
    safeRun('df', ['-kP', '/']),
    safeRun('ps', ['-eo', 'pid,user,pcpu,pmem,etime,comm', '--sort=-pcpu']),
    safeRun('ss', ['-tlnpH']),
  ]);

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
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
    disk,
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
      job = startJob(`deploy ${name} (${branch})`, [
        'set -e',
        `cd ${q(proj.cwd)}`,
        `git fetch origin ${q(branch)}`,
        `git reset --hard ${q('origin/' + branch)}`,
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
    safeRun('git', ['-C', cwd, 'status', '--porcelain']),
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

app.get('/api/projects/:name/env', async (req, res) => {
  const { cwd } = await findProject(req.params.name);
  const file = path.join(cwd, '.env');
  res.json({ success: true, path: file, exists: fs.existsSync(file), content: fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '' });
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

  if (pty) {
    const term = pty.spawn('bash', ['-l'], { name: 'xterm-256color', cols, rows, cwd: HOME, env: CLEAN_ENV });
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
  const child = spawn('script', ['-qfc', 'bash -l', '/dev/null'], { cwd: HOME, env: CLEAN_ENV });
  child.stdin.write(`stty cols ${cols} rows ${rows}; clear\n`);
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
