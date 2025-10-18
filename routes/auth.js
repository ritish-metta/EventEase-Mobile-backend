const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const nodemailer = require('nodemailer');
const { verifyToken } = require('../middleware/middleware');

// ============================================
// EMAIL CONFIGURATION (Declared ONCE)
// ============================================
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS, // 16-char app password from Google
  },
});

// ============================================
// HELPER FUNCTIONS
// ============================================

// Generate JWT Token
const generateToken = (userId) => {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE || '7d' }
  );
};

// Generate 6-digit OTP
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Send OTP Email
async function sendOtpEmail(email, otp) {
  try {
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'EventEase - Your OTP Code',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; max-width: 600px; margin: 0 auto;">
          <div style="background: linear-gradient(135deg, #7546A8 0%, #9b6fd4 100%); padding: 30px; border-radius: 10px 10px 0 0;">
            <h1 style="color: white; margin: 0; text-align: center;">EventEase</h1>
          </div>
          <div style="background: #f8f4fc; padding: 30px; border-radius: 0 0 10px 10px;">
            <h2 style="color: #2D1B4E; margin-top: 0;">Email Verification</h2>
            <p style="color: #64748B; font-size: 16px;">Your verification code is:</p>
            <div style="background: white; padding: 20px; border-radius: 10px; text-align: center; margin: 20px 0;">
              <h1 style="color: #7546A8; letter-spacing: 8px; font-size: 36px; margin: 0;">${otp}</h1>
            </div>
            <p style="color: #64748B; font-size: 14px;">This code will expire in <strong>10 minutes</strong>.</p>
            <p style="color: #64748B; font-size: 14px;">If you didn't request this code, please ignore this email.</p>
          </div>
          <div style="text-align: center; padding: 20px; color: #94a3b8; font-size: 12px;">
            <p>© 2024 EventEase. All rights reserved.</p>
          </div>
        </div>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Email sent successfully:', info.response);
    return { success: true, message: 'OTP sent successfully' };
  } catch (error) {
    console.error('❌ Email sending error:', error);
    return { success: false, message: 'Failed to send OTP email' };
  }
}

// ============================================
// ROUTE 1: Register User
// POST /api/auth/register
// ============================================
router.post('/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // Validation
    if (!username || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required',
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters',
      });
    }

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: 'This email is already registered',
      });
    }

    // Create new user
    const user = new User({
      username,
      email,
      password,
    });

    await user.save();

    console.log('✅ User registered:', email);

    res.status(201).json({
      success: true,
      message: 'Registration successful',
      data: {
        userId: user._id,
        username: user.username,
        email: user.email,
      },
    });
  } catch (error) {
    console.error('❌ Register error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during registration',
    });
  }
});

// ============================================
// ROUTE 2: Send OTP
// POST /api/auth/send-otp
// ============================================
router.post('/send-otp', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required',
      });
    }

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    // Generate OTP
    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Save OTP to database
    user.otp = otp;
    user.otpExpiry = otpExpiry;
    await user.save();

    console.log('📧 Sending OTP to:', email);

    // Send OTP via email
    const emailResult = await sendOtpEmail(email, otp);

    if (!emailResult.success) {
      return res.status(500).json({
        success: false,
        message: 'Failed to send OTP email. Please try again.',
      });
    }

    res.status(200).json({
      success: true,
      message: 'OTP sent successfully to your email',
    });
  } catch (error) {
    console.error('❌ Send OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send OTP',
    });
  }
});

// ============================================
// ROUTE 3: Verify OTP
// POST /api/auth/verify-otp
// ============================================
router.post('/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Email and OTP are required',
      });
    }

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    // Check if OTP exists
    if (!user.otp) {
      return res.status(400).json({
        success: false,
        message: 'No OTP found. Please request a new one',
      });
    }

    // Check if OTP is expired
    if (new Date() > user.otpExpiry) {
      return res.status(400).json({
        success: false,
        message: 'OTP has expired. Please request a new one',
      });
    }

    // Verify OTP
    if (user.otp !== otp) {
      return res.status(400).json({
        success: false,
        message: 'Invalid OTP. Please try again',
      });
    }

    // Mark user as verified and clear OTP
    user.isVerified = true;
    user.otp = null;
    user.otpExpiry = null;
    await user.save();

    console.log('✅ User verified:', email);

    // Generate JWT token
    const token = generateToken(user._id);

    res.status(200).json({
      success: true,
      message: 'Email verified successfully',
      data: {
        token,
        userId: user._id,
        username: user.username,
        email: user.email,
        isVerified: user.isVerified,
      },
    });
  } catch (error) {
    console.error('❌ Verify OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify OTP',
    });
  }
});

// ============================================
// ROUTE 4: Resend OTP
// POST /api/auth/resend-otp
// ============================================
router.post('/resend-otp', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email is required',
      });
    }

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    // Generate new OTP
    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);

    // Update OTP in database
    user.otp = otp;
    user.otpExpiry = otpExpiry;
    await user.save();

    console.log('📧 Resending OTP to:', email);

    // Send OTP via email
    const emailResult = await sendOtpEmail(email, otp);

    if (!emailResult.success) {
      return res.status(500).json({
        success: false,
        message: 'Failed to resend OTP email',
      });
    }

    res.status(200).json({
      success: true,
      message: 'OTP resent successfully',
    });
  } catch (error) {
    console.error('❌ Resend OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to resend OTP',
    });
  }
});

// ============================================
// ROUTE 5: Login User
// POST /api/auth/login
// ============================================
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Email and password are required',
      });
    }

    // Find user
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    // Check if user is verified
    if (!user.isVerified) {
      return res.status(403).json({
        success: false,
        message: 'Please verify your email first',
      });
    }

    // Verify password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid password',
      });
    }

    console.log('✅ User logged in:', email);

    // Generate JWT token
    const token = generateToken(user._id);

    res.status(200).json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        userId: user._id,
        username: user.username,
        email: user.email,
        isVerified: user.isVerified,
      },
    });
  } catch (error) {
    console.error('❌ Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during login',
    });
  }
});

module.exports = router;