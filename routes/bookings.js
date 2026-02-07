// routes/bookings.js - UPDATED
const express = require('express');
const router = express.Router();
const Booking = require('../models/Booking');
const Event = require('../models/Event');
const { verifyToken } = require('../middleware/middleware');
   
// POST create a new booking (protected - requires token)
router.post('/', verifyToken, async (req, res) => {
  try { 
    const { eventId, seats, name, email, phone } = req.body;
    const userId = req.user._id;

    // Debug logging
    console.log('=== BOOKING DEBUG ===');
    console.log('userId:', userId);
    console.log('user:', req.user); 
    console.log('Request body:', req.body);
    console.log('===================');

    // Validate input
    if (!eventId || !seats || !name || !email || !phone) { 
      return res.status(400).json({ 
        success: false,
        message: 'Missing required fields'
      });
    }

    if (seats < 1) {
      return res.status(400).json({
        success: false,
        message: 'Seats must be at least 1'
      });
    }

    // Check if event exists
    const event = await Event.findById(eventId);
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Check seat availability
    const availableSeats = event.capacity - event.bookedSeats;
    if (seats > availableSeats) {
      return res.status(400).json({
        success: false,
        message: `Only ${availableSeats} seats available`
      });
    }

    // Generate booking ID
    const bookingId = generateBookingId();

    // Create booking
    const booking = new Booking({
      bookingId,
      userId: userId,
      eventId,
      seats,
      totalPrice: event.price * seats,
      userDetails: {
        name,
        email,
        phone
      },
      status: 'confirmed'
    });

    console.log('Booking object before save:', booking);

    await booking.save();

    // Update event booked seats
    event.bookedSeats += seats;
    await event.save();

    res.status(201).json({
      success: true,
      message: 'Booking created successfully',
      data: booking
    });
  } catch (err) {
    console.error('Error creating booking:', err);
    res.status(400).json({
      success: false,
      message: err.message || 'Error creating booking'
    });
  }
});

// GET all bookings for logged-in user (protected)
router.get('/', verifyToken, async (req, res) => {
  try {
    const userId = req.user._id;

    const { status } = req.query;
    let query = { userId };

    // Filter by status if provided
    if (status) {
      query.status = status;
    }

    // FIXED: Include endDate in populate to fix the virtual field error
    const bookings = await Booking.find(query)
      .populate('eventId', 'title image startDate endDate location category price capacity bookedSeats description')
      .sort({ createdAt: -1 })
      .lean(); // Add lean() to get plain JavaScript objects

    res.json({
      success: true,
      count: bookings.length,
      data: bookings
    });
  } catch (err) {
    console.error('Error fetching bookings:', err);
    res.status(500).json({
      success: false,
      message: 'Error fetching bookings'
    });
  }
});

// GET single booking by ID (protected)
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const userId = req.user._id;

    // FIXED: Include all necessary fields including endDate
    const booking = await Booking.findById(req.params.id)
      .populate('eventId', 'title image startDate endDate location category price description capacity bookedSeats')
      .lean();

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Verify user owns this booking
    if (booking.userId.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    res.json({
      success: true,
      data: booking
    });
  } catch (err) {
    console.error('Error fetching booking:', err);
    res.status(500).json({
      success: false,
      message: 'Error fetching booking'
    });
  }
});

// PUT cancel booking (protected)
router.put('/:id/cancel', verifyToken, async (req, res) => {
  try {
    const userId = req.user._id;

    const booking = await Booking.findById(req.params.id);

    if (!booking) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // Verify user owns this booking
    if (booking.userId.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    // Can't cancel completed bookings
    if (booking.status === 'completed') {
      return res.status(400).json({
        success: false,
        message: 'Cannot cancel completed bookings'
      });
    }

    if (booking.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Booking already cancelled'
      });
    }

    // Update booking status
    booking.status = 'cancelled';
    await booking.save();

    // Free up seats
    const event = await Event.findById(booking.eventId);
    if (event) {
      event.bookedSeats = Math.max(0, event.bookedSeats - booking.seats);
      await event.save();
    }

    res.json({
      success: true,
      message: 'Booking cancelled successfully',
      data: booking
    });
  } catch (err) {
    console.error('Error cancelling booking:', err);
    res.status(500).json({
      success: false,
      message: 'Error cancelling booking'
    });
  } 
}); 

// Helper function to generate booking ID
function generateBookingId() {
  const now = new Date();
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const month = months[now.getMonth()];
  const year = now.getFullYear();
  
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let randomStr = '';
  for (let i = 0; i < 3; i++) {
    randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  
  return `BKG-${month}${year}-${randomStr}`;
}

module.exports = router; 