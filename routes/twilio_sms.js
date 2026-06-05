const express = require('express');
const router = express.Router();
const twilio = require('twilio');

// In-memory store (replace with DB if needed)
const smsAlerts = [];

// POST /api/twilio/sms — Twilio calls this when ESIM364 sends SMS to your Twilio number
router.post('/sms', (req, res) => {
  try {
    const from    = req.body.From  || 'Unknown';
    const body    = req.body.Body  || '';
    const to      = req.body.To    || '';
    const msgSid  = req.body.MessageSid || '';

    const alert = {
      id:        msgSid || Date.now().toString(),
      from,
      to,
      message:   body,
      timestamp: new Date().toISOString(),
      read:      false,
    };

    smsAlerts.unshift(alert); // newest first
    if (smsAlerts.length > 200) smsAlerts.pop(); // keep last 200

    console.log(`📲 SMS Alert received from ${from}: ${body}`);

    // Emit real-time to dashboard via Socket.IO
    if (req.io) {
      req.io.emit('sms_alert', alert);
    }

    // Respond to Twilio with empty TwiML (no reply SMS)
    res.set('Content-Type', 'text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><Response></Response>`);

  } catch (err) {
    console.error('Twilio webhook error:', err);
    res.status(500).send('Error');
  }
});

// GET /api/twilio/alerts — Your dashboard fetches all stored alerts
router.get('/alerts', (req, res) => {
  res.json({ success: true, total: smsAlerts.length, alerts: smsAlerts });
});

// PUT /api/twilio/alerts/:id/read — Mark alert as read
router.put('/alerts/:id/read', (req, res) => {
  const alert = smsAlerts.find(a => a.id === req.params.id);
  if (alert) {
    alert.read = true;
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, message: 'Alert not found' });
  }
});

// DELETE /api/twilio/alerts — Clear all alerts
router.delete('/alerts', (req, res) => {
  smsAlerts.length = 0;
  res.json({ success: true, message: 'All alerts cleared' });
});

// POST /api/twilio/forward — Forward an alert SMS to another number
router.post('/forward', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ success: false, message: 'to and message are required' });
  }

  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const sent = await client.messages.create({
      body: message,
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
    });
    res.json({ success: true, messageSid: sent.sid });
  } catch (err) {
    console.error('Forward SMS error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;