// routes/pmjSms.js

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const PmjSms  = require('../models/PmjSms');

function buildHash(sender, message, timestamp) {
  return crypto
    .createHash('sha256') 
    .update(`${sender}|${message}|${timestamp}`)
    .digest('hex');
}

// ─────────────────────────────────────────────────────────────────
//  POST /sync
// ─────────────────────────────────────────────────────────────────
router.post('/sync', async (req, res) => {
  try {
    const { deviceId = 'unknown', localHashes = [], messages = [] } = req.body;

    console.log(`\n🔄 ====== SYNC STARTED ======`);
    console.log(`📱 Device     : ${deviceId}`);
    console.log(`📤 Pushing    : ${messages.length} message(s) from device`);
    console.log(`🗂️  Known hashes: ${localHashes.length} on device`);

    const confirmedHashes = [];

    // ── 1. Upsert incoming messages ──────────────────────────────
    if (messages.length > 0) {
      const bulkOps = messages.map((msg) => {
        const hash = msg.msgHash || buildHash(msg.sender, msg.message, msg.timestamp);
        console.log(`   ➡️  Upserting [${msg.sender}] "${msg.message?.slice(0, 30)}..." hash=${hash.slice(0, 8)}...`);
        return {
          updateOne: {
            filter: { msgHash: hash },
            update: {
              $setOnInsert: {
                sender:    msg.sender,
                message:   msg.message,
                timestamp: msg.timestamp,
                deviceId,
                numberId:  msg.numberId || 'number_1',
                msgHash:   hash,
              },
            },
            upsert: true,
          },
        };
      });

      const bulkResult = await PmjSms.bulkWrite(bulkOps, { ordered: false });
      console.log(`✅ MongoDB upsert done — inserted: ${bulkResult.upsertedCount}, matched: ${bulkResult.matchedCount}`);

      const savedHashes = messages.map(
        (m) => m.msgHash || buildHash(m.sender, m.message, m.timestamp)
      );
      confirmedHashes.push(...savedHashes);
      console.log(`🔐 Confirmed ${confirmedHashes.length} hash(es) back to device`);

      if (req.io) {
        req.io.emit('newSms', { deviceId, count: bulkResult.upsertedCount });
        console.log(`📡 Socket.io emitted newSms event`);
      }
    } else {
      console.log(`⏭️  No messages to push — skipping upsert`);
    }

    // ── 2. Find what device is missing ──────────────────────────
    console.log(`\n🔍 Checking MongoDB for messages missing on device...`);
    const missingOnDevice = localHashes.length > 0
      ? await PmjSms.find({ msgHash: { $nin: localHashes } })
          .sort({ timestamp: 1 })
          .limit(200)
          .lean()
      : await PmjSms.find({})
          .sort({ timestamp: 1 })
          .limit(200)
          .lean();

    if (missingOnDevice.length > 0) {
      console.log(`📥 Found ${missingOnDevice.length} message(s) missing on device — sending down`);
      missingOnDevice.forEach((m) => {
        console.log(`   ⬇️  [${m.sender}] "${m.message?.slice(0, 30)}..."`);
      });
    } else {
      console.log(`✅ Device is fully in sync — nothing missing`);
    }

    console.log(`\n📊 SYNC SUMMARY`);
    console.log(`   📤 Pushed up   : ${messages.length}`);
    console.log(`   📥 Pulled down : ${missingOnDevice.length}`);
    console.log(`   🗂️  Device knew  : ${localHashes.length}`);
    console.log(`🔄 ====== SYNC COMPLETE ======\n`);
// ── 3. Return ALL backend hashes so device can detect deletions ──
    const allBackendHashes = await PmjSms.find({}, { msgHash: 1, _id: 0 }).lean();
    const allHashes = allBackendHashes.map(d => d.msgHash).filter(Boolean);
    console.log(`🔐 Total hashes in MongoDB: ${allHashes.length}`);

    return res.status(200).json({
      success: true,
      confirmedHashes: allHashes,
      missingOnDevice,
      stats: {
        pushed:        messages.length,
        pulled:        missingOnDevice.length,
        knownByDevice: localHashes.length,
      },
    });


  } catch (error) {
    console.error(`❌ SYNC ERROR: ${error.message}`);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  POST /receive
// ─────────────────────────────────────────────────────────────────
router.post('/receive', async (req, res) => {
  try {
    const { sender, message, timestamp, deviceId, numberId } = req.body;

    console.log(`\n📩 ====== RECEIVE ======`);
    console.log(`   From    : ${sender}`);
    console.log(`   Message : ${message?.slice(0, 50)}...`);
    console.log(`   Device  : ${deviceId}`);

    if (!sender || !message || !timestamp) {
      console.warn(`⚠️  Missing required fields`);
      return res.status(400).json({ success: false, message: 'sender, message and timestamp are required' });
    }

    const hash = buildHash(sender, message, timestamp);
    console.log(`🔐 Hash: ${hash.slice(0, 16)}...`);

    const sms = await PmjSms.findOneAndUpdate(
      { msgHash: hash },
      {
        $setOnInsert: {
          sender, message, timestamp,
          deviceId: deviceId || 'unknown',
          numberId: numberId || 'number_1',
          msgHash:  hash,
        },
      },
      { upsert: true, new: true }
    );

    if (req.io) {
      req.io.emit('newSms', sms);
      console.log(`📡 Socket emitted`);
    }

    console.log(`✅ Saved to MongoDB\n`);
    return res.status(200).json({ success: true, data: sms });
  } catch (error) {
    console.error(`❌ RECEIVE ERROR: ${error.message}`);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  GET /all
// ─────────────────────────────────────────────────────────────────
router.get('/all', async (req, res) => {
  try {
    const messages = await PmjSms.find().sort({ createdAt: -1 });
    console.log(`📋 GET /all — returned ${messages.length} messages`);
    return res.status(200).json({ success: true, count: messages.length, data: messages });
  } catch (error) {
    console.error(`❌ GET /all error: ${error.message}`);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  GET /by-number/:numberId
// ─────────────────────────────────────────────────────────────────
router.get('/by-number/:numberId', async (req, res) => {
  try {
    const messages = await PmjSms.find({ numberId: req.params.numberId }).sort({ createdAt: -1 });
    console.log(`📋 GET /by-number/${req.params.numberId} — ${messages.length} messages`);
    return res.status(200).json({ success: true, count: messages.length, data: messages });
  } catch (error) {
    console.error(`❌ GET /by-number error: ${error.message}`);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  DELETE /delete-all
// ─────────────────────────────────────────────────────────────────
router.delete('/delete-all', async (req, res) => {
  try {
    const result = await PmjSms.deleteMany({});
    console.log(`🗑️  Deleted ALL — ${result.deletedCount} documents removed`);
    return res.status(200).json({ success: true, message: 'All SMS deleted' });
  } catch (error) {
    console.error(`❌ DELETE /delete-all error: ${error.message}`);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────
//  DELETE /delete/:numberId
// ─────────────────────────────────────────────────────────────────
router.delete('/delete/:numberId', async (req, res) => {
  try {
    const result = await PmjSms.deleteMany({ numberId: req.params.numberId });
    console.log(`🗑️  Deleted for ${req.params.numberId} — ${result.deletedCount} removed`);
    return res.status(200).json({ success: true, message: `Deleted for ${req.params.numberId}` });
  } catch (error) {
    console.error(`❌ DELETE /${req.params.numberId} error: ${error.message}`);
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;