const express = require('express');
const crypto = require('crypto');
const router = express.Router(); 

// --- 🛑 CONFIGURATION 🛑 ---
// Credentials live in .env — see .env.example for the required keys.
const USER_ID = process.env.EPRISONS_USER_ID;
const RAW_PASSWORD = process.env.EPRISONS_PASSWORD;
const PRIVATE_KEY = process.env.EPRISONS_PRIVATE_KEY;

// --- HELPER FUNCTIONS ---
function getDynamicKey() {
  const today = new Date();
  const dd = String(today.getDate()).padStart(2, '0');
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const yyyy = today.getFullYear();
  return `ePrisons${dd}${mm}${yyyy}`;
}

function encryptPayload(payloadObj, keyString) {
  const payloadStr = JSON.stringify(payloadObj);
  const key = Buffer.from(keyString, 'utf8');
  const cipher = crypto.createCipheriv('aes-128-cbc', key, key);
  cipher.setAutoPadding(true);
  let encrypted = cipher.update(payloadStr, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return encrypted;
}

// GET /api/releases/prisoner-photo?objectId=36896a90-a6bd-463f-9ce2-722982872c34.jpeg
router.get('/prisoner-photo', async (req, res) => {
  try {
    const { objectId } = req.query;

    if (!objectId || !String(objectId).trim()) {
      return res.status(400).json({ success: false, message: 'objectId is required' });
    }

    // STEP 1 — Get token (same as releases flow)
    const tokenPayload = {
      userid: USER_ID,
      password: crypto.createHash('md5').update(RAW_PASSWORD).digest('hex')
    };
    const sharedKey = getDynamicKey();
    const encryptedTokenData = encryptPayload(tokenPayload, sharedKey);

    const tokenRes = await fetch('https://eprisons.nic.in/ePrisonsAPI/api/Token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputdata: encryptedTokenData })
    });
    const tokenJson = await tokenRes.json();

    if (!tokenJson.status || !tokenJson.data) {
      return res.status(401).json({ success: false, message: 'Failed to get token', details: tokenJson.message });
    }

    const jwtToken = tokenJson.data;

    // STEP 2 — Encrypt objectId payload with PRIVATE_KEY
    const photoPayload = { objectId: String(objectId).trim() };
    const encryptedPhotoData = encryptPayload(photoPayload, PRIVATE_KEY);

    // STEP 3 — UTF-8 encode and call API
    const encodedPayload = encodeURIComponent(encryptedPhotoData);
    const photoUrl = `https://eprisons.nic.in/ePrisonsAPI/api/ePrisons/GetPrisonerPhotofromScanid?reqstring=${encodedPayload}`;

    console.log('[prisoner-photo] objectId:', objectId);
    console.log('[prisoner-photo] url:', photoUrl);

    const photoRes = await fetch(photoUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwtToken}`
      }
    });

    const photoText = await photoRes.text();

    try {
      const photoJson = JSON.parse(photoText);

      // data comes as stringified JSON — parse it
      if (photoJson.data && typeof photoJson.data === 'string') {
        try {
          photoJson.data = JSON.parse(photoJson.data);
        } catch (_) {}
      }

      console.log('[prisoner-photo] status:', photoRes.status, 'success:', photoJson.status);
      return res.json({ success: photoJson.status === true, data: photoJson });
    } catch (_) {
      return res.json({ success: false, raw: photoText });
    }
  } catch (err) {
    console.error('[prisoner-photo] error:', err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;