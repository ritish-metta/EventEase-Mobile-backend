const net = require('net');
const mongoose = require('mongoose');

const TCP_PORT = 433;

// ✅ ADM-CID Schema
const tcpAlarmSchema = new mongoose.Schema(
  {
    raw: { type: String },
    cidCode: { type: String },
    account: { type: String },
    group: { type: String },
    zone: { type: String },
    eventDescription: { type: String },
    source: { type: String, default: 'TCP_ADM_CID' },
    clientIp: { type: String },
  },
  { timestamps: true }
);

const TcpAlarm = mongoose.model('TcpAlarm', tcpAlarmSchema);

// ✅ CID code descriptions
const CID_CODES = {
  '1130': 'Burglar Alarm',
  '1131': 'Perimeter Alarm',
  '1134': 'Entry/Exit',
  '1137': 'Device Tampered',
  '1301': 'AC Power Down',
  '1302': 'Low Battery',
  '1401': 'Disarming',
  '1403': 'Auto Disarming',
  '1406': 'Alarm Clearing',
  '1441': 'Stay Arming',
  '3401': 'Arming',
  '3403': 'Auto Arming',
  '1103': 'Instant Alarm',
  '1383': 'Detector Tampered',
};

// ✅ Parse ADM-CID message
const parseAdmCid = (raw) => {
  try {
    // Format: ADM-CID"XXXX#ACCOUNT[#ACCOUNT|CID_CODE GRP ZONE]_TIME
    const accountMatch = raw.match(/#(\w+)\[/);
    const cidMatch = raw.match(/\|(\d{4})\s+(\d+)\s+(\d+)/);

    const account = accountMatch ? accountMatch[1] : null;
    const cidCode = cidMatch ? cidMatch[1] : null;
    const group = cidMatch ? cidMatch[2] : null;
    const zone = cidMatch ? cidMatch[3] : null;
    const description = cidCode ? (CID_CODES[cidCode] || `Unknown CID: ${cidCode}`) : null;

    return { account, cidCode, group, zone, eventDescription: description };
  } catch (e) {
    return {};
  }
};

// ✅ Create TCP server
const createTcpServer = (io) => {
  const server = net.createServer((socket) => {
    const clientIp = socket.remoteAddress;
    console.log(`\n✅ Panel connected via TCP: ${clientIp}`);

    socket.on('data', async (data) => {
      const raw = data.toString().trim();
      console.log(`📩 TCP Data from ${clientIp}: ${raw}`);

      // ✅ Send ACK back to panel — required!
      socket.write('ACK\r\n');

      try {
        const parsed = parseAdmCid(raw);

        const alarm = await TcpAlarm.create({
          raw,
          clientIp,
          ...parsed,
        });

        console.log(`✅ TCP Alarm saved: ${parsed.eventDescription || raw}`);

        // ✅ Emit to Flutter/dashboard via WebSocket
        if (io) {
          io.emit('tcpAlarm', alarm);
        }
      } catch (e) {
        console.error('TCP save error:', e.message);
      }
    });

    socket.on('error', (err) => {
      console.error('TCP socket error:', err.message);
    });

    socket.on('close', () => {
      console.log(`Panel disconnected: ${clientIp}`);
    });
  });

  server.listen(TCP_PORT, '0.0.0.0', () => {
    console.log(`✅ TCP Alarm Server listening on port ${TCP_PORT}`);
  });

  server.on('error', (err) => {
    console.error('TCP server error:', err.message);
  });

  return server;
};

module.exports = { createTcpServer };