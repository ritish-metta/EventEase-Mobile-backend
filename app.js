// Updated server.js - Add event routes
require('dotenv').config();
const express = require('express');
const connectDB = require('./config/db');
const authRoutes = require('./routes/auth');
const eventRoutes = require('./routes/events');
const bookingsRouter = require('./routes/bookings');

const app = express();
const PORT = process.env.PORT || 3000;

// Connect to Database
connectDB();

// Middleware
app.use(express.json());

// CORS Middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes); // Add this line
// IMPORTANT: Register the bookings routes
app.use('/api/bookings', bookingsRouter);

// Default route
app.get('/', (req, res) => {
  res.json({
    message: 'EventEase API is running',
    version: '1.0.0',
    endpoints: {
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
    },
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'Something went wrong!',
  });
});

// Start the server
app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}/`);
});