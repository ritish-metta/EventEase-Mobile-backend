// models/Event.js
const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Event title is required'],
    trim: true
  },
  image: {
    type: String,
    required: [true, 'Event image is required']
  },
  startDate: {
    type: Date,
    required: [true, 'Start date is required']
  },
  endDate: {
    type: Date,
    required: [true, 'End date is required']
  },
  location: {
    type: String,
    required: [true, 'Location is required'],
    trim: true
  },
  category: {
    type: String,
    required: [true, 'Category is required'],
    enum: ['Concert', 'Music', 'Jazz', 'Comedy', 'Ballet', 'Theater', 'Sports', 'Other']
  },
  price: {
    type: Number,
    required: [true, 'Price is required'],
    min: 0
  },
  capacity: {
    type: Number,
    required: [true, 'Capacity is required'],
    min: 1
  },
  bookedSeats: {
    type: Number,
    default: 0,
    min: 0
  },
  description: {
    type: String,
    required: [true, 'Description is required']
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Virtual for formatted date
eventSchema.virtual('date').get(function() {
  const start = this.startDate;
  const end = this.endDate;
  
  const formatDate = (date) => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  };
  
  if (start.toDateString() === end.toDateString()) {
    return formatDate(start);
  }
  return `${formatDate(start)} - ${formatDate(end)}`;
});

// Ensure virtuals are included when converting to JSON
eventSchema.set('toJSON', { virtuals: true });
eventSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Event', eventSchema);