// routes/eprisons_encrypt.js
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

// AES encrypt function using ECB mode (no IV) - matches ePrisons API expectations
function aesEncrypt(plainText, key) {
  const keyBytes = Buffer.from(key, 'utf8');

  let algorithm;
  if (keyBytes.length === 16) algorithm = 'aes-128-ecb';
  else if (keyBytes.length === 24) algorithm = 'aes-192-ecb';
  else if (keyBytes.length === 32) algorithm = 'aes-256-ecb';
  else throw new Error(`Key length must be 16, 24, or 32 bytes, got ${keyBytes.length}`);

  const cipher = crypto.createCipheriv(algorithm, keyBytes, null); // ECB uses no IV
  let encrypted = cipher.update(plainText, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return encrypted;
}

// POST /api/eprisons/encrypt
// body: { "payload": { ... }, "key": "ePrisonsddMMYYYY" }
router.post('/encrypt', (req, res) => {
  try {
    const { payload, key } = req.body;

    if (!payload || !key) {
      return res.status(400).json({
        success: false,
        message: 'payload and key are required',
      });
    }

    const plainText = typeof payload === 'string' ? payload : JSON.stringify(payload);

    const encrypted = aesEncrypt(plainText, key);

    res.json({
      success: true,
      inputdata: encrypted,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message,
    });
  }
});

module.exports = router;