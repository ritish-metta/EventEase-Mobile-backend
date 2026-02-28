const mongoose = require('mongoose');
const socketIO = require('socket.io');
const { initializeGame } = require('../routes/game'); // 🎮 Fast Finger Tap
const { initializeLaserGridSprint } = require('../routes/laser_grid_sprint');
const { initializePhoneFootball } = require('../routes/phone_football');
let io;
const connectedDevices = new Map(); // Store connected devices: deviceId -> socketId
const buzzerActiveDevices = new Set(); // Track which devices have active buzzers

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/eventease', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('✓ MongoDB Connected');
  } catch (error) {
    console.error('✗ MongoDB Connection Error:', error.message);
    process.exit(1);
  }
};

const initializeWebSocket = (server) => {
  io = socketIO(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  console.log('✓ WebSocket server initialized');

  io.on('connection', (socket) => {
    initializePhoneFootball(io, socket);
    console.log(`✓ New connection: ${socket.id}`);
initializeLaserGridSprint(io, socket);
    // 📱 DEVICE REGISTRATION
    socket.on('register', (data) => {
      const { deviceId } = data;
      if (deviceId) {
        connectedDevices.set(deviceId, socket.id);
        console.log(`📱 Device registered: ${deviceId} -> ${socket.id}`);
        console.log(`📊 Total devices connected: ${connectedDevices.size}`);

        // If buzzer was active for this device before it disconnected, re-trigger it
        if (buzzerActiveDevices.has(deviceId)) {
          io.to(socket.id).emit('triggerBuzzer', { deviceId });
          console.log(`🔊 Re-triggered buzzer for reconnected device: ${deviceId}`);
        }

        // Notify dashboard about connected devices
        io.emit('deviceConnected', { deviceId, socketId: socket.id });
      }
    });

    // 🔊 TRIGGER BUZZER FOR SPECIFIC DEVICE (from dashboard)
    socket.on('triggerBuzzer', (data) => {
      const { deviceId } = data;
      console.log(`🔊 Dashboard triggered buzzer for: ${deviceId}`);

      const deviceSocketId = connectedDevices.get(deviceId);

      if (deviceSocketId) {
        io.to(deviceSocketId).emit('triggerBuzzer', { deviceId });
        buzzerActiveDevices.add(deviceId); // Track buzzer state
        console.log(`✓ Buzzer signal sent to device ${deviceId} (socket: ${deviceSocketId})`);

        socket.emit('buzzerTriggered', {
          success: true,
          deviceId,
          message: 'Buzzer triggered successfully'
        });
      } else {
        console.log(`✗ Device ${deviceId} not connected`);
        socket.emit('buzzerTriggered', {
          success: false,
          deviceId,
          message: 'Device not connected'
        });
      }
    });

    // 🔇 STOP BUZZER FOR SPECIFIC DEVICE (from dashboard)
    socket.on('stopBuzzer', (data) => {
      const { deviceId } = data;
      console.log(`🔇 Dashboard stopped buzzer for: ${deviceId}`);

      const deviceSocketId = connectedDevices.get(deviceId);
      buzzerActiveDevices.delete(deviceId); // Clear buzzer state regardless

      if (deviceSocketId) {
        io.to(deviceSocketId).emit('stopBuzzer', { deviceId });
        console.log(`✓ Stop signal sent to device ${deviceId} (socket: ${deviceSocketId})`);

        socket.emit('buzzerStopped', {
          success: true,
          deviceId,
          message: 'Buzzer stopped successfully'
        });
      } else {
        console.log(`✗ Device ${deviceId} not connected`);
        socket.emit('buzzerStopped', {
          success: false,
          deviceId,
          message: 'Device not connected'
        });
      }
    });

    // 🚨 TRIGGER ALL BUZZERS (from dashboard)
    socket.on('triggerAllBuzzers', () => {
      console.log('🚨 Dashboard triggered ALL buzzers');

      if (connectedDevices.size === 0) {
        console.log('✗ No devices connected');
        socket.emit('allBuzzersTriggered', {
          success: false,
          message: 'No devices connected',
          count: 0
        });
        return;
      }

      let triggered = 0;
      connectedDevices.forEach((socketId, deviceId) => {
        io.to(socketId).emit('triggerBuzzer', { deviceId });
        buzzerActiveDevices.add(deviceId); // Track all as active
        triggered++;
        console.log(`✓ Buzzer triggered for device: ${deviceId}`);
      });

      console.log(`✓ Triggered ${triggered} buzzers`);

      socket.emit('allBuzzersTriggered', {
        success: true,
        message: `Triggered ${triggered} devices`,
        count: triggered
      });
    });

    // 🔇 STOP ALL BUZZERS (from dashboard)
    socket.on('stopAllBuzzers', () => {
      console.log('🔇 Dashboard stopped ALL buzzers');

      if (connectedDevices.size === 0) {
        console.log('✗ No devices connected');
        socket.emit('allBuzzersStopped', {
          success: false,
          message: 'No devices connected',
          count: 0
        });
        return;
      }

      let stopped = 0;
      connectedDevices.forEach((socketId, deviceId) => {
        io.to(socketId).emit('stopBuzzer', { deviceId });
        stopped++;
        console.log(`✓ Buzzer stopped for device: ${deviceId}`);
      });

      buzzerActiveDevices.clear(); // Clear all buzzer states

      console.log(`✓ Stopped ${stopped} buzzers`);

      socket.emit('allBuzzersStopped', {
        success: true,
        message: `Stopped ${stopped} devices`,
        count: stopped
      });
    });

    // 🔋 BATTERY UPDATE (from mobile device)
    socket.on('batteryUpdate', (data) => {
      io.emit('batteryUpdate', data);
    });

    // 📡 DISCONNECT
    socket.on('disconnect', () => {
      console.log(`✗ Disconnected: ${socket.id}`);

      let disconnectedDeviceId = null;
      connectedDevices.forEach((socketId, deviceId) => {
        if (socketId === socket.id) {
          disconnectedDeviceId = deviceId;
          connectedDevices.delete(deviceId);
        }
      });

      if (disconnectedDeviceId) {
        console.log(`📱 Device unregistered: ${disconnectedDeviceId}`);
        console.log(`📊 Total devices connected: ${connectedDevices.size}`);

        // NOTE: We do NOT remove from buzzerActiveDevices on disconnect
        // so that when the device reconnects, it will re-trigger the buzzer
        io.emit('deviceDisconnected', { deviceId: disconnectedDeviceId });
      }
    });
  });

  // 🎮 Initialize Fast Finger Tap game
  initializeGame(io);

  return io;
};

const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized!');
  }
  return io;
};

module.exports = { connectDB, initializeWebSocket, getIO };
