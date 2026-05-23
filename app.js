require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { connectDB, initializeWebSocket } = require('./config/db');
const authRoutes = require('./routes/auth');
const eventRoutes = require('./routes/events');
const bookingsRouter = require('./routes/bookings');
const childSafetyRoutes = require('./routes/childSafety');
const yogaRoutes = require('./routes/yoga');
const pmjSmsRoutes = require('./routes/pmj_sms_route');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 5000;

const io = initializeWebSocket(server);

app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, ngrok-skip-browser-warning');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});





app.use((req, res, next) => {
  req.io = io;
  next();
});



app.use(express.static('public')); 

app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/bookings', bookingsRouter);
app.use('/api/child-safety', childSafetyRoutes);
app.use('/api/yoga', yogaRoutes);
app.use('/api/pmj-sms', pmjSmsRoutes);

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'child-safety-dashboard.html'));
});

app.get('/api', (req, res) => {
  res.json({
    message: 'EventEase API with Child Safety Monitoring',
    version: '1.0.0',
    websocket: 'Active',
    endpoints: {
      dashboard: 'GET / (Child Safety Dashboard)',
      public: {
        register: 'POST /api/auth/register',
        sendOtp: 'POST /api/auth/send-otp',
        verifyOtp: 'POST /api/auth/verify-otp',
        login: 'POST /api/auth/login',
        getAllEvents: 'GET /api/events',
        getEvent: 'GET /api/events/:id',
        getFeaturedEvents: 'GET /api/events/featured/list',
      },
      protected: {
        profile: 'GET /api/auth/profile',
        updateProfile: 'PUT /api/auth/profile',
        refreshToken: 'POST /api/auth/refresh-token',
        createEvent: 'POST /api/events',
        updateEvent: 'PUT /api/events/:id',
        deleteEvent: 'DELETE /api/events/:id',
      },
      childSafety: {
        registerDevice: 'POST /api/child-safety/device',
        sendContacts: 'POST /api/child-safety/contacts',
        sendBattery: 'POST /api/child-safety/battery',
        getAllDevices: 'GET /api/child-safety/devices',
        getDevice: 'GET /api/child-safety/device/:deviceId',
        deleteDevice: 'DELETE /api/child-safety/device/:deviceId',
      },
      websocket: {
        events: [
          'register - Register device',
          'triggerBuzzer - Trigger specific device buzzer',
          'stopBuzzer - Stop specific device buzzer',
          'triggerAllBuzzers - Trigger all device buzzers',
          'stopAllBuzzers - Stop all device buzzers',
          'batteryUpdate - Real-time battery updates',
          'deviceConnected - Device connection notification',
          'deviceDisconnected - Device connection notification',
        ],
      },
    },
  });
});

app.use((err, req, res, next) => {
  console.error('Error:', err.stack);
  res.status(500).json({
    success: false,
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found',
  });
});

const startServer = async () => {
  await connectDB();

  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`API info available at http://localhost:${PORT}/api`);
  });
};

startServer();

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
