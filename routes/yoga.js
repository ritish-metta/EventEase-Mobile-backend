// routes/yoga.js
const express = require('express');
const router = express.Router();

const PYTHON_API = process.env.PYTHON_API_URL || 'http://localhost:5001';

// ✅ FIX: Correct node-fetch import for v3+
let fetchFn;
(async () => {
  try {
    const { default: fetch } = await import('node-fetch');
    fetchFn = fetch;
  } catch (e) {
    fetchFn = global.fetch; // Node 18+ built-in
  }
})();

// Helper to always get fetch
function getFetch() {
  if (fetchFn) return fetchFn;
  if (typeof global.fetch !== 'undefined') return global.fetch;
  throw new Error('No fetch available. Run: npm install node-fetch');
}

// ── Helper: call Python FastAPI ────────────────────────
async function callPythonAnalyze(data) {
  const f = getFetch();
  const response = await f(`${PYTHON_API}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error(`Python API error: ${response.status}`);
  return response.json();
}

// ── REST Routes ────────────────────────────────────────

// GET /api/yoga/poses
router.get('/poses', async (req, res) => {
  try {
    const f = getFetch();
    const response = await f(`${PYTHON_API}/api/poses`);
    const data = await response.json();
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('❌ /poses error:', err.message);
    res.status(500).json({ success: false, message: 'Python API not reachable', error: err.message });
  }
});

// POST /api/yoga/analyze
router.post('/analyze', async (req, res) => {
  try {
    const result = await callPythonAnalyze(req.body);
    if (req.io) req.io.emit('yogaPoseResult', result);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('❌ /analyze error:', err.message);
    res.status(500).json({ success: false, message: 'Python API not reachable', error: err.message });
  }
});

// GET /api/yoga/health ← Dashboard checks this
router.get('/health', async (req, res) => {
  try {
    const f = getFetch();
    const response = await f(`${PYTHON_API}/health`);
    const data = await response.json();
    console.log('✅ Python health check OK');
    res.json({ nodejs: 'ok', python: data });
  } catch (err) {
    console.error('❌ Python not reachable:', err.message);
    res.json({ nodejs: 'ok', python: 'unreachable' });
  }
});

module.exports = router;
module.exports.callPythonAnalyze = callPythonAnalyze;