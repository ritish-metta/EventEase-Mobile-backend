require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const { connectDB, initializeWebSocket } = require('./config/db');
const authRoutes = require('./routes/auth');
const eventRoutes = require('./routes/events');
const bookingsRouter = require('./routes/bookings');


const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 5000;

// Connect to Database
connectDB();

// Initialize WebSocket BEFORE routes
const io = initializeWebSocket(server);

// Middleware
app.use(express.json());

// CORS Middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

// Attach WebSocket to requests (for battery updates)
app.use((req, res, next) => {
  req.io = io;
  next();
});

// Serve static files (dashboard HTML)
app.use(express.static('public'));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);
app.use('/api/bookings', bookingsRouter);


// Serve dashboard at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'child-safety-dashboard.html'));
});

// API Info endpoint
app.get('/api', (req, res) => {
  res.json({
    message: 'EventEase API with Child Safety Monitoring',
    version: '1.0.0',
    websocket: 'Active ✓',
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
          'deviceDisconnected - Device disconnection notification',
        ]
      }
    },
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('❌ Error:', err.stack);
  res.status(500).json({
    success: false,
    message: 'Something went wrong!',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint not found'
  });
});

// Start server
server.listen(PORT, () => {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   🚀 Server Running Successfully          ║');
  console.log('╠════════════════════════════════════════════╣');
  console.log(`║   HTTP + WebSocket: http://localhost:${PORT}  ║`);
  console.log(`║   Dashboard: http://localhost:${PORT}/         ║`);
  console.log(`║   API Info: http://localhost:${PORT}/api       ║`);
  console.log('╠════════════════════════════════════════════╣');
  console.log('║   📊 Child Safety Features:               ║');
  console.log('║   ✓ Real-time battery monitoring          ║');
  console.log('║   ✓ Remote buzzer control                 ║');
  console.log('║   ✓ Contact tracking                      ║');
  console.log('║   ✓ WebSocket live updates                ║');
  console.log('╚════════════════════════════════════════════╝\n');
});

// Handle server shutdown gracefully
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});  