// Security: audit log of every change made through the panel, plus who is logged
// in to the server, recent logins and IPs locked out for wrong tokens.

const fs = require('fs');
const path = require('path');
const store = require('./store');

const AUDIT_FILE = path.join(store.DATA_DIR, 'audit.log');
const MAX_AUDIT_BYTES = 5 * 1024 * 1024;
const SECRET_FIELDS = new Set(['content', 'value', 'webhookUrl']); // never written to the log

module.exports = function security(ctx) {
  // Registered right after the auth check, so only authenticated changes get here.
  function auditMiddleware(req, res, next) {
    if (req.method === 'GET') return next();
    const body = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)
      ? Object.fromEntries(Object.entries(req.body).map(([k, v]) => [k, SECRET_FIELDS.has(k) ? '(hidden)' : v]))
      : undefined;
    res.on('finish', () => {
      const entry = { t: Date.now(), ip: req.ip, method: req.method, path: req.originalUrl, status: res.statusCode, body };
      try {
        if (fs.existsSync(AUDIT_FILE) && fs.statSync(AUDIT_FILE).size > MAX_AUDIT_BYTES) {
          fs.renameSync(AUDIT_FILE, `${AUDIT_FILE}.1`);
        }
        fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(entry)}\n`);
      } catch {
        // auditing must never break the request
      }
    });
    next();
  }

  ctx.app.get('/api/security', async (req, res) => {
    const [who, last] = await Promise.all([
      ctx.safeRun('who', []),
      ctx.safeRun('last', ['-n', '20', '-a', '-w']),
    ]);
    const lockouts = [...ctx.failures.entries()].map(([ip, f]) => ({ ip, failures: f.count, since: f.first }));
    const audit = ctx.tailFile(AUDIT_FILE, 300).reverse().map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
    res.json({ success: true, sessions: who || '', logins: last || '', lockouts, audit });
  });

  ctx.app.delete('/api/security/lockouts/:ip', (req, res) => {
    ctx.failures.delete(req.params.ip);
    res.json({ success: true, message: `Unblocked ${req.params.ip}` });
  });

  return { auditMiddleware };
};
