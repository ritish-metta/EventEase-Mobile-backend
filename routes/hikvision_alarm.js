const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const xml2js = require('xml2js');

// ✅ Schema — inside route file itself
const alarmSchema = new mongoose.Schema(
  {
    ipAddress: { type: String, default: null },
    macAddress: { type: String, default: null },
    channelId: { type: String, default: null },
    channelName: { type: String, default: null },
    eventType: { type: String, default: null },
    eventState: { type: String, default: null },
    eventDescription: { type: String, default: null },
    zoneId: { type: String, default: null },
    panelDateTime: { type: String, default: null },
    statusLabel: { type: String, default: null },
    rawBody: { type: String, default: null },
    source: { type: String, default: 'XML' },
  },
  { timestamps: true }
);

const HikvisionAlarm = mongoose.model('HikvisionAlarm', alarmSchema);

// ✅ Helper — parse XML from panel
const parseAlarmXml = async (bodyStr) => {
  try {
    let xmlStr = bodyStr;

    // Handle multipart
    if (bodyStr.includes('--')) {
      const parts = bodyStr.split('--');
      for (const part of parts) {
        if (part.includes('<EventNotificationAlert')) {
          const start = part.indexOf('<EventNotificationAlert');
          const end =
            part.indexOf('</EventNotificationAlert>') +
            '</EventNotificationAlert>'.length;
          xmlStr = part.substring(start, end);
          break;
        }
      }
    }

    if (!xmlStr.includes('<EventNotificationAlert')) {
      return null;
    }

    const start = xmlStr.indexOf('<EventNotificationAlert');
    const end =
      xmlStr.indexOf('</EventNotificationAlert>') +
      '</EventNotificationAlert>'.length;
    xmlStr = xmlStr.substring(start, end);

    const parsed = await xml2js.parseStringPromise(xmlStr, {
      explicitArray: false,
      ignoreAttrs: true,
      tagNameProcessors: [
        (name) => name.replace(/^.*:/, ''),
      ],
    });

    const alert = parsed['EventNotificationAlert'] || parsed;

    const eventType = alert.eventType || null;
    const eventState = alert.eventState || null;

    let statusLabel = '';
    if (eventState === 'active') {
      statusLabel = '🔴 TRIGGERED / ARMED';
    } else if (eventState === 'inactive' && eventType === 'videoloss') {
      statusLabel = '💓 HEARTBEAT';
    } else if (eventState === 'inactive') {
      statusLabel = '🟢 CLEARED / DISARMED';
    } else {
      statusLabel = `⚪ ${eventType} - ${eventState}`;
    }

    return {
      ipAddress: alert.ipAddress || null,
      macAddress: alert.macAddress || null,
      channelId: alert.channelID || null,
      channelName: alert.channelName || null,
      eventType,
      eventState,
      eventDescription: alert.eventDescription || null,
      zoneId: alert.inputIOPortID || null,
      panelDateTime: alert.dateTime || null,
      statusLabel,
      rawBody: xmlStr,
      source: 'XML',
    };
  } catch (err) {
    console.error('XML parse error:', err.message);
    return null;
  }
};

// ================================================
// ✅ POST /api/hikvision/event
// Panel pushes alerts here
// ================================================
router.post('/event', async (req, res) => {
  try {
    const rawBody = await new Promise((resolve) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => resolve(data));
    });

    const contentType = req.headers['content-type'] || '';
    console.log('\n========================================');
    console.log('✅ Hikvision Event Received!');
    console.log('Content-Type:', contentType);
    console.log('Raw Body:', rawBody.substring(0, 300));
    console.log('========================================\n');

    let alarmData = await parseAlarmXml(rawBody);

    if (!alarmData) {
      // Save as raw if XML parsing fails
      alarmData = {
        source: 'RAW',
        rawBody: rawBody.substring(0, 2000),
        statusLabel: '⚠️ RAW / UNPARSED',
      };
    }

    const alarm = await HikvisionAlarm.create(alarmData);

    // ✅ Emit real-time via WebSocket
    if (req.io) {
      req.io.emit('hikvisionAlarm', alarm);
    }

    console.log('✅ Saved to MongoDB:', alarm._id);

    return res.status(200).json({
      success: true,
      message: 'Event received',
      id: alarm._id,
    });
  } catch (error) {
    console.error('Alarm receive error:', error);
    return res.status(500).json({
      success: false,
      message: 'Failed to process alarm',
      error: error.message,
    });
  }
});

// ================================================
// ✅ POST /api/hikvision/multipart
// Some panel firmware sends multipart
// ================================================
router.post('/multipart', async (req, res) => {
  req.url = '/event';
  return router.handle(req, res, () => {});
});

// ================================================
// ✅ GET /api/hikvision/events
// Get all alarm events
// ================================================
router.get('/events', async (req, res) => {
  try {
    const events = await HikvisionAlarm.find()
      .sort({ createdAt: -1 })
      .limit(100);
    return res.status(200).json({
      success: true,
      count: events.length,
      data: events,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch events',
      error: error.message,
    });
  }
});

// ================================================
// ✅ GET /api/hikvision/events/latest
// Get latest alarm event
// ================================================
router.get('/events/latest', async (req, res) => {
  try {
    const event = await HikvisionAlarm.findOne().sort({ createdAt: -1 });
    return res.status(200).json({
      success: true,
      data: event,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch latest event',
      error: error.message,
    });
  }
});

// ================================================
// ✅ DELETE /api/hikvision/events 
// Delete all events 
// ================================================
router.delete('/events', async (req, res) => {
  try {
    await HikvisionAlarm.deleteMany({});
    return res.status(200).json({
      success: true,
      message: 'All events deleted',
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to delete events',
      error: error.message,
    });
  }
});

// ================================================
// ✅ GET /api/hikvision/test
// Test if endpoint is working
// ================================================
router.get('/test', async (req, res) => {
  const count = await HikvisionAlarm.countDocuments();
  return res.status(200).json({
    success: true,
    message: '✅ Hikvision alarm receiver is running!',
    totalEventsInDB: count,
    endpoints: {
      receiveEvent: 'POST /api/hikvision/event',
      receiveMultipart: 'POST /api/hikvision/multipart',
      getAllEvents: 'GET /api/hikvision/events',
      getLatest: 'GET /api/hikvision/events/latest',
      deleteAll: 'DELETE /api/hikvision/events',
      simulate: 'POST /api/hikvision/simulate',
    },
  });
});

// ================================================
// ✅ POST /api/hikvision/simulate
// Simulate a fake panel event for testing
// ================================================
router.post('/simulate', async (req, res) => {
  try {
    const fakeAlarm = await HikvisionAlarm.create({
      ipAddress: '192.168.1.100',
      macAddress: '44:19:b6:6d:24:85',
      channelId: '1',
      channelName: 'Front Door Sensor',
      eventType: 'IO',
      eventState: 'active',
      eventDescription: 'Zone 1 Triggered - Front Door',
      zoneId: '1',
      panelDateTime: new Date().toISOString(),
      statusLabel: '🔴 TRIGGERED / ARMED',
      source: 'SIMULATED',
    });

    if (req.io) {
      req.io.emit('hikvisionAlarm', fakeAlarm);
    }

    return res.status(200).json({
      success: true,
      message: '✅ Simulated event created!',
      data: fakeAlarm,
    });
  } catch (error) {
    return res.status(500).json({
      success: false, 
      message: 'Simulation failed',
      error: error.message,
    });
  }
});

module.exports = router;