// Backups: .tar.gz snapshots of a project folder (without node_modules / .git)
// in ~/ops-backups. Restoring brings the files back and, if the project was
// deleted from PM2, starts it again, so "Delete completely" can be undone.

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');

const BACKUP_DIR = path.join(os.homedir(), 'ops-backups');
const FILE_RE = /^[\w.-]+__\d{8}-\d{6}\.tar\.gz$/;

module.exports = function backups(ctx) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  // file name -> { project, cwd, script, mode, instances, createdAt }
  const index = store.load('backups', {});

  const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

  // Shell command that snapshots a project; also used by "Delete completely".
  function backupCommand(proj) {
    const file = `${proj.name.replace(/[^\w.-]/g, '_')}__${stamp()}.tar.gz`;
    index[file] = {
      project: proj.name,
      cwd: proj.cwd,
      script: proj.script,
      mode: proj.mode,
      instances: proj.instances?.length || 1,
      createdAt: Date.now(),
    };
    store.save('backups', index);
    const dest = path.join(BACKUP_DIR, file);
    return {
      file,
      command: `tar -czf ${ctx.q(dest)} --exclude=node_modules --exclude=.git -C ${ctx.q(path.dirname(proj.cwd))} ${ctx.q(path.basename(proj.cwd))} && echo "💾 Backup saved: ${dest} ($(du -h ${ctx.q(dest)} | cut -f1))"`,
    };
  }

  const checkFile = (name) => {
    if (!FILE_RE.test(name)) throw new ctx.HttpError(400, 'Invalid backup name');
    const full = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(full)) throw new ctx.HttpError(404, 'Backup not found');
    return full;
  };

  ctx.app.get('/api/backups', (req, res) => {
    const list = fs.readdirSync(BACKUP_DIR).filter((f) => FILE_RE.test(f)).map((f) => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      const meta = index[f] || { project: f.split('__')[0] };
      return { file: f, size: st.size, createdAt: meta.createdAt || st.mtimeMs, ...meta };
    }).filter((b) => !req.query.project || b.project === req.query.project)
      .sort((a, b) => b.createdAt - a.createdAt);
    res.json({ success: true, dir: BACKUP_DIR, backups: list });
  });

  ctx.app.post('/api/backups', async (req, res) => {
    const proj = await ctx.findProject(String(req.body?.project || ''));
    ctx.assertNotBusy(proj.name);
    const { file, command } = backupCommand(proj);
    const job = ctx.startJob(`backup ${proj.name}`, command, { project: proj.name, kind: 'backup' });
    res.json({ success: true, message: `Backing up ${proj.name}…`, file, jobId: job.id });
  });

  ctx.app.post('/api/backups/:file/restore', async (req, res) => {
    const full = checkFile(req.params.file);
    const meta = index[req.params.file];
    if (!meta?.cwd) throw new ctx.HttpError(400, 'This backup has no project information, extract it from the Files page instead');
    ctx.assertNotBusy(meta.project);
    const parent = path.dirname(meta.cwd);
    const running = (await ctx.getProjects()).some((p) => p.name === meta.project);
    const start = running
      ? `pm2 reload ${ctx.q(meta.project)} || pm2 restart ${ctx.q(meta.project)}`
      : `pm2 start ${ctx.q(meta.script)} --name ${ctx.q(meta.project)}${meta.mode === 'cluster' ? ` -i ${meta.instances}` : ''}`;
    const job = ctx.startJob(`restore ${meta.project} from ${req.params.file}`, [
      'set -e',
      `mkdir -p ${ctx.q(parent)}`,
      `tar -xzf ${ctx.q(full)} -C ${ctx.q(parent)}`,
      `cd ${ctx.q(meta.cwd)}`,
      'if [ -f package-lock.json ]; then npm ci --omit=dev; elif [ -f package.json ]; then npm install --omit=dev; fi',
      start,
      'pm2 save',
      `echo "✅ ${meta.project} restored"`,
    ].join('\n'), { detached: meta.project === ctx.AGENT_NAME, project: meta.project, kind: 'restore' });
    res.json({ success: true, message: `Restoring ${meta.project}…`, jobId: job.id });
  });

  ctx.app.get('/api/backups/:file/download', (req, res) => {
    res.download(checkFile(req.params.file));
  });

  ctx.app.delete('/api/backups/:file', (req, res) => {
    fs.rmSync(checkFile(req.params.file));
    delete index[req.params.file];
    store.save('backups', index);
    res.json({ success: true, message: 'Backup deleted' });
  });

  return { backupCommand, BACKUP_DIR };
};
