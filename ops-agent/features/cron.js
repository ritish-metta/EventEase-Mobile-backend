// Cron: view and replace the server user's crontab.

const { spawn } = require('child_process');

module.exports = function cron(ctx) {
  ctx.app.get('/api/cron', async (req, res) => {
    // `crontab -l` exits non-zero when the user has no crontab yet
    const content = (await ctx.safeRun('crontab', ['-l'])) ?? '';
    const jobs = content.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    res.json({ success: true, content, jobCount: jobs.length });
  });

  ctx.app.put('/api/cron', async (req, res) => {
    const content = String(req.body?.content ?? '');
    const finalContent = content.endsWith('\n') ? content : `${content}\n`; // cron ignores a last line without newline
    const error = await new Promise((resolve) => {
      const child = spawn('crontab', ['-'], { env: ctx.CLEAN_ENV });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', (err) => resolve(err.message));
      child.on('close', (code) => resolve(code === 0 ? null : stderr.trim() || `crontab exited with ${code}`));
      child.stdin.end(finalContent);
    });
    if (error) throw new ctx.HttpError(400, error);
    res.json({ success: true, message: 'Crontab saved' });
  });
};
