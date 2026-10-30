// Panel settings: alert webhook, alert thresholds, saved quick commands.

const store = require('./store');

const DEFAULTS = {
  webhookUrl: '',
  thresholds: { cpu: 90, memory: 90, disk: 90 },
  quickCommands: [
    { name: 'Disk usage', command: 'df -h' },
    { name: 'Memory', command: 'free -h' },
    { name: 'PM2 status', command: 'pm2 list' },
    { name: 'Biggest folders in home', command: 'du -h --max-depth=2 ~ 2>/dev/null | sort -rh | head -15' },
    { name: 'Network summary', command: 'ss -s' },
    { name: 'Failed services', command: 'systemctl --failed --no-pager' },
    { name: 'npm audit (EventEase)', command: 'cd ~/eventease_backend && npm audit --omit=dev || true' },
  ],
};

module.exports = function settings(ctx) {
  const saved = store.load('settings', {});
  let current = { ...DEFAULTS, ...saved, thresholds: { ...DEFAULTS.thresholds, ...saved.thresholds } };

  ctx.app.get('/api/settings', (req, res) => res.json({ success: true, settings: current }));

  ctx.app.put('/api/settings', (req, res) => {
    const { webhookUrl = '', thresholds = {}, quickCommands = current.quickCommands } = req.body || {};
    if (webhookUrl && !/^https:\/\/\S+$/.test(webhookUrl)) throw new ctx.HttpError(400, 'Webhook URL must start with https://');

    const pct = (v, def) => {
      const n = Number(v ?? def);
      if (!Number.isFinite(n) || n < 10 || n > 100) throw new ctx.HttpError(400, 'Thresholds must be between 10 and 100');
      return n;
    };
    if (!Array.isArray(quickCommands) || quickCommands.some((c) => !c?.name || !c?.command)) {
      throw new ctx.HttpError(400, 'Each quick command needs a name and a command');
    }

    current = {
      webhookUrl,
      thresholds: {
        cpu: pct(thresholds.cpu, current.thresholds.cpu),
        memory: pct(thresholds.memory, current.thresholds.memory),
        disk: pct(thresholds.disk, current.thresholds.disk),
      },
      quickCommands: quickCommands.map(({ name, command }) => ({ name: String(name).slice(0, 60), command: String(command).slice(0, 2000) })),
    };
    store.save('settings', current);
    res.json({ success: true, message: 'Settings saved', settings: current });
  });

  return { get: () => current };
};
