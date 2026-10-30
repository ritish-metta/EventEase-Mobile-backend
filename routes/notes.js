// routes/notes.js
// Plain MongoDB read/write — no caching layer.

const express = require('express');
const mongoose = require('mongoose');

const router = express.Router();

// --- Simple Mongoose model ---
const noteSchema = new mongoose.Schema(
  {
    text: { type: String, required: true },
  },
  { timestamps: true }
);
const Note = mongoose.models.Note || mongoose.model('Note', noteSchema);

// POST /api/notes -> save text to MongoDB
router.post('/', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, message: 'text is required' });
    }

    const note = await Note.create({ text: text.trim() });
    res.status(201).json({ success: true, note });
  } catch (err) {
    console.error('POST /api/notes error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/notes -> return all notes straight from MongoDB
router.get('/', async (req, res) => {
  try {
    const notes = await Note.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, notes });
  } catch (err) {
    console.error('GET /api/notes error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;