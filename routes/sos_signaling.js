// routes/sos_signaling.js
// SOS Live Audio + Video Signaling — pure WebRTC relay via Socket.IO
// No auth, no DB, no storage — just forwards offer/answer/ICE candidates.
//
// NOTE: This file does not need to know or care whether the stream contains
// audio, video, or both. WebRTC bundles all tracks into a single offer/answer
// SDP, and this server just relays that SDP blindly between device <-> dashboard.
// As long as the Flutter app adds both an audio track and a video track to its
// RTCPeerConnection (which it does), audio is carried through this same path
// with zero extra code here.

const DASHBOARD_ROOM = 'sos_dashboards';

function initializeSosSignaling(io, socket) {
  // ── Dashboard joins the dashboard room ──
  socket.on('sos:dashboard:join', () => {
    socket.join(DASHBOARD_ROOM);
    console.log(`SOS Dashboard joined: ${socket.id}`);
  });

  // ── Device sends WebRTC offer (starts SOS) ──
  // This offer's SDP already describes both the audio and video tracks
  // captured on the phone (see getUserMedia({ audio: true, video: {...} })).
  socket.on('sos:offer', ({ offer }) => {
    console.log(`SOS offer from device: ${socket.id}`);
    io.to(DASHBOARD_ROOM).emit('sos:incoming', {
      deviceId: socket.id,
      offer,
    });
  });

  // ── Dashboard sends WebRTC answer back to the device ──
  // The answer's SDP confirms the dashboard is ready to receive both tracks.
  socket.on('sos:answer', ({ deviceId, answer }) => {
    console.log(`SOS answer for device: ${deviceId}`);
    io.to(deviceId).emit('sos:answer', { answer });
  });

  // ── ICE candidates relay (both directions) ──
  // Candidates are transport-level (network paths), not tied to audio or
  // video specifically — same relay handles both media types.
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