const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({
  deviceId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  model: {
    type: String,
    default: 'Unknown',
  },
  manufacturer: {
    type: String,
    default: 'Unknown',
  },
  androidVersion: {
    type: String,
    default: 'Unknown',
  },
  contacts: [{
    name: {
      type: String,
      default: 'Unknown',
    },
    phone: {
      type: String,
      default: '',
    },
    email: {
      type: String,
      default: '',
    },
  }],
  lastSeen: {
    type: Date,
    default: Date.now,
  },
}, {
  timestamps: true,
});

deviceSchema.index({ lastSeen: -1 });

module.exports = mongoose.model('Device', deviceSchema);