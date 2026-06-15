const mongoose = require('mongoose');
const socketIO = require('socket.io');

const { initializeGame } = require('../routes/game');
const { initializeLaserGridSprint } = require('../routes/laser_grid_sprint');
const { initializePhoneFootball } = require('../routes/phone_football');
const { initializeRuthlessBattle } = require('../routes/ruthless_battle');
const { callPythonAnalyze } = require('../routes/yoga');
const { initializeSosSignaling } = require('../routes/sos_signaling');

let io;
const connectedDevices = new Map();
const buzzerActiveDevices = new Set();

const connectDB = async () => {
  try {
    const mongoUri =
      process.env.MONGO_URI ||
      process.env.MONGODB_URI ||
      'mongodb://localhost:27017/eventease';

    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 10000,
    });

    console.log('MongoDB Connected');
  } catch (error) {
    console.error('MongoDB Connection Error:', error.message);
    process.exit(1);
  }
};

const initializeWebSocket = (server) => {
  io = socketIO(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket'],
    allowUpgrades: false,
  });

  console.log('WebSocket server initialized');

  io.on('connection', (socket) => {
    console.log(`New connection: ${socket.id}`);
    initializeSosSignaling(io, socket);
    initializePhoneFootball(io, socket);
    initializeRuthlessBattle(io, socket);
    initializeLaserGridSprint(io, socket);
    initializeGame(io);

    socket.on('register', ({ deviceId }) => {
      if (!deviceId) return;

      connectedDevices.set(deviceId, socket.id);

      console.log(`Device registered: ${deviceId} -> ${socket.id}`);
      console.log(`Total devices: ${connectedDevices.size}`);

      if (buzzerActiveDevices.has(deviceId)) {
        io.to(socket.id).emit('triggerBuzzer', { deviceId });
      }

      io.emit('deviceConnected', { deviceId, socketId: socket.id });
    });

    socket.on('triggerBuzzer', ({ deviceId }) => {
      const deviceSocketId = connectedDevices.get(deviceId);

      if (!deviceSocketId) {
        socket.emit('buzzerTriggered', {
          success: false,
          deviceId,
          message: 'Device not connected',
        });
        return;
      }

      io.to(deviceSocketId).emit('triggerBuzzer', { deviceId });
      buzzerActiveDevices.add(deviceId);

      socket.emit('buzzerTriggered', {
        success: true,
        deviceId,
        message: 'Buzzer triggered',
      });
    });

    socket.on('stopBuzzer', ({ deviceId }) => {
      const deviceSocketId = connectedDevices.get(deviceId);
      buzzerActiveDevices.delete(deviceId);

      if (!deviceSocketId) {
        socket.emit('buzzerStopped', {
          success: false,
          deviceId,
          message: 'Device not connected',
        });
        return;
      }

      io.to(deviceSocketId).emit('stopBuzzer', { deviceId });

      socket.emit('buzzerStopped', {
        success: true,
        deviceId,
        message: 'Buzzer stopped',
      });
    });

    socket.on('triggerAllBuzzers', () => {
      if (connectedDevices.size === 0) {
        socket.emit('allBuzzersTriggered', { success: false, count: 0 });
        return;
      }

      let count = 0;
      connectedDevices.forEach((socketId, deviceId) => {
        io.to(socketId).emit('triggerBuzzer', { deviceId });
        buzzerActiveDevices.add(deviceId);
        count++;
      });

      socket.emit('allBuzzersTriggered', { success: true, count });
    });

    socket.on('stopAllBuzzers', () => {
      if (connectedDevices.size === 0) {
        socket.emit('allBuzzersStopped', { success: false, count: 0 });
        return;
      }

      let count = 0;
      connectedDevices.forEach((socketId, deviceId) => {
        io.to(socketId).emit('stopBuzzer', { deviceId });
        count++;
      });

      buzzerActiveDevices.clear();

      socket.emit('allBuzzersStopped', { success: true, count });
    });

    socket.on('batteryUpdate', (data) => {
      io.emit('batteryUpdate', data);
    });

    socket.on('yogoAnalyzePose', async ({ userId, poseName, keypoints }) => {
      if (!poseName || !keypoints) {
        socket.emit('yogaPoseResult', {
          status: 'error',
          message: 'Missing data',
        });
        return;
      }

      try {
        const result = await callPythonAnalyze({
          user_id: userId,
          pose_name: poseName,
          keypoints,
        });

        socket.emit('yogaPoseResult', result);
      } catch (err) {
        socket.emit('yogaPoseResult', {
          status: 'error',
          message: 'Python server error',
        });
      }
    });

    socket.on('disconnect', () => {
      console.log(`Disconnected: ${socket.id}`);

      let removedDevice = null;

      connectedDevices.forEach((sockId, deviceId) => {
        if (sockId === socket.id) {
          removedDevice = deviceId;
          connectedDevices.delete(deviceId);
        }
      });

      if (removedDevice) {
        io.emit('deviceDisconnected', { deviceId: removedDevice });
      }
    });
  });

  initializeGame(io);

  return io;
};

const getIO = () => {
  if (!io) throw new Error('Socket.io not initialized!');
  return io;
};

module.exports = { connectDB, initializeWebSocket, getIO };
