const mongoose = require('mongoose');

const pmjSmsSchema = new mongoose.Schema(
  {
    sender:    { type: String, required: true },
    message:   { type: String, required: true },
    timestamp: { type: String, required: true },
    numberId:  { type: String, default: 'number_1' },
    deviceId:  { type: String, default: 'unknown' },
    msgHash:   { type: String, unique: true, sparse: true }, // ✅ ADD THIS
  },
  { timestamps: true }
);

pmjSmsSchema.index({ sender: 1, message: 1, timestamp: 1 }, { unique: true });

module.exports = mongoose.model('PmjSms', pmjSmsSchema);