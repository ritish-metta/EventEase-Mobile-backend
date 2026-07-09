const express = require('express');
const router = express.Router();
const { request } = require('undici');

const CCTNS_BASE_URL = 'http://10.20.2.211:3001';
const CCTNS_CLIENT = 'BCSS';
const CCTNS_API_KEY = '6a1d8a8c-2c1a-4369-94a0-2c0e3a3a69a6';

// Helper: format a Date object as YYYY-MM-DD
function toDateStr(d) {
  return d.toISOString().split('T')[0];
}

// ---- 1. PING ----
router.get('/ping', async (req, res) => {
  try {
    const { statusCode, body, headers } = await request(
      `${CCTNS_BASE_URL}/api/${CCTNS_CLIENT}/ping`,
      {
        headers: {
          Accept: '*/*',
          'x-api-key': CCTNS_API_KEY,
        },
      }
    );

    const contentType = headers['content-type'] || '';
    if (contentType.includes('application/json')) {
      const json = await body.json();
      return res.status(statusCode).json(json);
    } else {
      const text = await body.text();
      return res.status(statusCode).send(text);
    }
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

// ---- 2. CRIMES DISPOSAL ----
// GET /api/cctns/crimes/disposal?fromDate=2025-01-01&toDate=2025-01-07
// If fromDate/toDate are not sent by the frontend, defaults to "last 30 days up to today"
router.get('/crimes/disposal', async (req, res) => {
  try {
    const today = new Date();
    const defaultFrom = new Date();
    defaultFrom.setDate(today.getDate() - 30);

    const fromDate = req.query.fromDate || toDateStr(defaultFrom);
    const toDate = req.query.toDate || toDateStr(today);

    const { statusCode, body } = await request(
      `${CCTNS_BASE_URL}/api/${CCTNS_CLIENT}/crimes/disposal?fromDate=${fromDate}&toDate=${toDate}`,
      {
        headers: {
          Accept: 'application/json',
          'x-api-key': CCTNS_API_KEY,
        },
      }
    );

    const json = await body.json().catch(() => null);
    res.status(statusCode).json(json);
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

// ---- 3. CRIMES DISPOSAL BY CRIME ID ----
// GET /api/cctns/crimes/disposal/:crimeId
// e.g. /api/cctns/crimes/disposal/67749961b16fe238530da648
router.get('/crimes/disposal/:crimeId', async (req, res) => {
  try {
    const { crimeId } = req.params;

    const { statusCode, body } = await request(
      `${CCTNS_BASE_URL}/api/${CCTNS_CLIENT}/crimes/disposal/${crimeId}`,
      {
        headers: {
          Accept: 'application/json',
          'x-api-key': CCTNS_API_KEY,
        },
      }
    );

    const json = await body.json().catch(() => null);
    res.status(statusCode).json(json);
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

// ---- 4. FULL CRIME DETAILS BY CRIME ID ----
// GET /api/cctns/crimes/:crimeId
// e.g. /api/cctns/crimes/67749961b16fe238530da648
router.get('/crimes/:crimeId', async (req, res) => {
  try {
    const { crimeId } = req.params;

    const { statusCode, body } = await request(
      `${CCTNS_BASE_URL}/api/${CCTNS_CLIENT}/crimes/${crimeId}`,
      {
        headers: {
          Accept: 'application/json',
          'x-api-key': CCTNS_API_KEY,
        },
      }
    );

    const json = await body.json().catch(() => null);
    res.status(statusCode).json(json);
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

module.exports = router;