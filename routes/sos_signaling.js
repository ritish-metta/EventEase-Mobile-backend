// routes/sos_signaling.js
// SOS Live Audio Signaling — pure WebRTC relay via Socket.IO
// No auth, no DB, no storage — just forwards offer/answer/ICE candidates.

const DASHBOARD_ROOM = 'sos_dashboards';

function initializeSosSignaling(io, socket) {
  // ── Dashboard joins the dashboard room ──
  socket.on('sos:dashboard:join', () => {
    socket.join(DASHBOARD_ROOM);
    console.log(`SOS Dashboard joined: ${socket.id}`);
  });

  // ── Device sends WebRTC offer (starts SOS) ──
  socket.on('sos:offer', ({ offer }) => {
    console.log(`SOS offer from device: ${socket.id}`);
    io.to(DASHBOARD_ROOM).emit('sos:incoming', {
      deviceId: socket.id,
      offer,
    });
  });

  // ── Dashboard sends WebRTC answer back to the device ──
  socket.on('sos:answer', ({ deviceId, answer }) => {
    console.log(`SOS answer for device: ${deviceId}`);
    io.to(deviceId).emit('sos:answer', { answer });
  });

  // ── ICE candidates relay (both directions) ──
  socket.on('sos:ice-candidate', ({ deviceId, candidate, target }) => {
    if (target === 'dashboard') {
      // device -> all dashboards
      io.to(DASHBOARD_ROOM).emit('sos:ice-candidate', {
        deviceId: socket.id,
        candidate,
      });
    } else if (target === 'device' && deviceId) {
      // dashboard -> specific device
      io.to(deviceId).emit('sos:ice-candidate', { candidate });
    }
  });

  // ── Device ends SOS manually ──
  socket.on('sos:end', () => {
    console.log(`SOS ended by device: ${socket.id}`);
    io.to(DASHBOARD_ROOM).emit('sos:ended', { deviceId: socket.id });
  });

  // ── Cleanup if device disconnects mid-SOS ──
  socket.on('disconnect', () => {
    io.to(DASHBOARD_ROOM).emit('sos:ended', { deviceId: socket.id });
  });
}

module.exports = { initializeSosSignaling };