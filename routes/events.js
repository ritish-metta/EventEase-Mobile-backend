// routes/events.js
const express = require('express');
const router = express.Router();
const Event = require('../models/Event');
const { verifyToken } = require('../middleware/middleware');

// GET all events (public - no token needed) 
router.get('/', async (req, res) => {
  try {
    const { category, search } = req.query;
    let query = {};

    // Filter by category
    if (category) {
      query.category = category;
    }

    // Search functionality
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { location: { $regex: search, $options: 'i' } },
        { category: { $regex: search, $options: 'i' } }
      ];
    }

    const events = await Event.find(query).sort({ startDate: 1 });
    
    res.json({
      success: true,
      count: events.length,
      data: events
    });
  } catch (err) {
    console.error('Error fetching events:', err);
    res.status(500).json({
      success: false,
      message: 'Error fetching events'
    });
  }
});

// GET featured events (public - no token needed) - MUST come before /:id route
router.get('/featured/list', async (req, res) => {
  try {
    const now = new Date();
    const events = await Event.find({
      startDate: { $gte: now }
    })
    .sort({ startDate: 1 })
    .limit(10);

    res.json({
      success: true,
      count: events.length,
      data: events
    });
  } catch (err) {
    console.error('Error fetching featured events:', err);
    res.status(500).json({
      success: false,
      message: 'Error fetching featured events'
    });
  }
});

// GET single event by ID (public - no token needed)
router.get('/:id', async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    res.json({
      success: true,
      data: event
    });
  } catch (err) {
    console.error('Error fetching event:', err);
    res.status(500).json({
      success: false,
      message: 'Error fetching event'
    });
  }
});

// POST create new event (public - no token needed)
router.post('/', async (req, res) => {
  try {
    const eventData = {
      ...req.body
      // createdBy is now optional since no authentication is required
    };

    const event = new Event(eventData);
    await event.save();

    res.status(201).json({
      success: true,
      message: 'Event created successfully',
      data: event
    });
  } catch (err) {
    console.error('Error creating event:', err);
    res.status(400).json({
      success: false,
      message: err.message || 'Error creating event'
    });
  }
});

// PUT update event (protected)
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    // Update event fields
    Object.keys(req.body).forEach(key => {
      if (req.body[key] !== undefined) {
        event[key] = req.body[key];
      }
    });

    await event.save();

    res.json({
      success: true,
      message: 'Event updated successfully',
      data: event
    });
  } catch (err) {
    console.error('Error updating event:', err);
    res.status(400).json({
      success: false,
      message: err.message || 'Error updating event'
    });
  }
});

// DELETE event (protected)
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const event = await Event.findByIdAndDelete(req.params.id);
    
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found'
      });
    }

    res.json({
      success: true,
      message: 'Event deleted successfully'
    });
  } catch (err) {
    console.error('Error deleting event:', err);
    res.status(500).json({
      success: false,
      message: 'Error deleting event'
    });
  }
});

module.exports = router;