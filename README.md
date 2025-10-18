# 🎉 EventEase Backend API

**A Professional Event Management Backend Service**

Robust REST API for event booking, user authentication, and real-time event management with MongoDB integration.

---

## 🔗 Quick Links

<div align="center">

[![Repository](https://img.shields.io/badge/GitHub-Repository-blue?style=for-the-badge&logo=github)](https://github.com/ritish-metta/EventEase-Mobile-backend)
[![API Docs](https://img.shields.io/badge/API-Documentation-green?style=for-the-badge&logo=swagger)](https://github.com/ritish-metta/EventEase-Mobile-backend)
[![MongoDB](https://img.shields.io/badge/MongoDB-Database-green?style=for-the-badge&logo=mongodb)](https://www.mongodb.com/)

</div>

---

## 🌟 Overview

EventEase Backend is a Node.js-based REST API service designed for comprehensive event management. Built with Express.js and MongoDB, it provides secure authentication, event CRUD operations, booking management, and real-time data synchronization.

---

## 🎯 Why This API Stands Out

- **🔐 Secure Authentication**: JWT-based auth with OTP email verification
- **📧 Email Integration**: Nodemailer for OTP and notifications
- **🎫 Smart Booking**: Seat management with capacity validation
- **📊 Real-time Updates**: Live event data and booking status
- **🔍 Advanced Search**: Query events by category, date, and keywords
- **💾 MongoDB Integration**: Scalable NoSQL database architecture
- **🛡️ Data Validation**: Comprehensive input validation and error handling

---

## ✨ Features

### Core Features

| Feature | Description | Status |
|---------|-------------|--------|
| 🔑 **User Authentication** | JWT-based login with OTP verification | ✅ |
| 📧 **Email OTP** | Secure email verification system | ✅ |
| 🎪 **Event Management** | Full CRUD operations for events | ✅ |
| 🎫 **Booking System** | Create, view, and cancel bookings | ✅ |
| 🔍 **Search & Filter** | Query events by multiple parameters | ✅ |
| 👤 **User Profiles** | Manage user information and preferences | ✅ |
| 📊 **Analytics** | Track bookings and event statistics | ✅ |

### API Endpoints

- **Authentication** - Register, Login, OTP verification
- **Events** - Create, Read, Update, Delete events
- **Bookings** - Book tickets, view history, cancel bookings
- **Users** - Profile management, preferences
- **Admin** - Event approval, user management

---

## 🏗️ Architecture

```
EventEase-Backend/
├── 🔧 config/
│   └── db.js                          # MongoDB connection
│
├── 🗂️ models/
│   ├── User.js                        # User schema
│   ├── Event.js                       # Event schema
│   └── Booking.js                     # Booking schema
│
├── 🛣️ routes/
│   ├── auth.js                        # Authentication routes
│   ├── events.js                      # Event routes
│   └── bookings.js                    # Booking routes
│
├── 🛡️ middleware/
│   └── middleware.js                  # JWT verification & error handling
│
├── 📄 .env                            # Environment variables
├── 📄 app.js                          # App entry point
└── 📄 package.json                    # Dependencies
```

---

## 🚀 Quick Start

### Prerequisites

- Node.js (v14 or higher)
- MongoDB (local or Atlas)
- Gmail account (for email service)
- npm or yarn

### Installation

1. **Clone the repository**

```bash
git clone https://github.com/ritish-metta/EventEase-Mobile-backend.git
cd EventEase-Mobile-backend
```

2. **Install dependencies**

```bash
npm install
```

3. **Set up environment variables**

Create a `.env` file in the root directory:

```env
# Server Configuration
PORT=5000
NODE_ENV=development

# Database
MONGODB_URI=mongodb://localhost:27017/eventease
# OR for MongoDB Atlas:
# MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/eventease

# JWT Secret
JWT_SECRET=your_super_secret_jwt_key_here_change_this
JWT_EXPIRE=7d

# Email Configuration (Gmail)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-specific-password
EMAIL_FROM=EventEase <noreply@eventease.com>

# OTP Configuration
OTP_EXPIRE_MINUTES=10

# Frontend URL (for CORS)
FRONTEND_URL=http://localhost:3000

# API Configuration
API_VERSION=v1
```

4. **Start MongoDB**

```bash
# If using local MongoDB
mongod

# If using MongoDB Atlas, ensure your connection string is in .env
```

5. **Run the server**

```bash
# Development mode with nodemon
npm run dev

# Production mode
npm start
```

The server will start on `http://localhost:5000`

---

## 📡 API Documentation

### Base URL
```
http://localhost:5000/api
```

### Authentication Endpoints

#### 1. Register User
```http
POST /api/auth/register
```

**Request Body:**
```json
{
  "username": "johndoe",
  "email": "john@example.com",
  "password": "securePassword123"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Registration successful. OTP sent to email.",
  "data": {
    "userId": "64abc123def456",
    "email": "john@example.com"
  }
}
```

---

#### 2. Send OTP
```http
POST /api/auth/send-otp
```

**Request Body:**
```json
{
  "email": "john@example.com"
}
```

**Response:**
```json
{
  "success": true,
  "message": "OTP sent to email successfully",
  "expiresIn": "10 minutes"
}
```

---

#### 3. Verify OTP
```http
POST /api/auth/verify-otp
```

**Request Body:**
```json
{
  "email": "john@example.com",
  "otp": "123456"
}
```

**Response:**
```json
{
  "success": true,
  "message": "OTP verified successfully",
  "data": {
    "verified": true
  }
}
```

---

#### 4. Login
```http
POST /api/auth/login
```

**Request Body:**
```json
{
  "email": "john@example.com",
  "password": "securePassword123"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "64abc123def456",
    "username": "johndoe",
    "email": "john@example.com"
  }
}
```

---

### Event Endpoints

#### 5. Get All Events
```http
GET /api/events
```

**Query Parameters:**
- `search` - Search by title or description
- `category` - Filter by category
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 10)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "64abc123def456",
      "title": "Music Festival 2024",
      "image": "https://example.com/image.jpg",
      "startDate": "2024-12-01T10:00:00Z",
      "endDate": "2024-12-01T22:00:00Z",
      "location": "Central Park, New York",
      "category": "Music",
      "price": 50.00,
      "capacity": 1000,
      "bookedSeats": 450,
      "description": "Annual music festival featuring top artists"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 25
  }
}
```

---

#### 6. Get Featured Events
```http
GET /api/events/featured/list
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "64abc123def456",
      "title": "Tech Conference 2024",
      "date": "Dec 15, 2024",
      "location": "Convention Center",
      "price": 100.00,
      "availableSeats": 250
    }
  ]
}
```

---

#### 7. Get Event by ID
```http
GET /api/events/:id
```

**Response:**
```json
{
  "success": true,
  "data": {
    "_id": "64abc123def456",
    "title": "Music Festival 2024",
    "description": "Full event details...",
    "startDate": "2024-12-01T10:00:00Z",
    "endDate": "2024-12-01T22:00:00Z",
    "location": "Central Park, New York",
    "category": "Music",
    "price": 50.00,
    "capacity": 1000,
    "bookedSeats": 450,
    "availableSeats": 550
  }
}
```

---

#### 8. Create Event (Admin)
```http
POST /api/events
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "title": "New Year Party 2025",
  "image": "https://example.com/party.jpg",
  "startDate": "2024-12-31T20:00:00Z",
  "endDate": "2025-01-01T02:00:00Z",
  "location": "Downtown Club",
  "category": "Party",
  "price": 75.00,
  "capacity": 500,
  "description": "Welcome 2025 with style!"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Event created successfully",
  "data": {
    "_id": "64abc789xyz012",
    "title": "New Year Party 2025"
  }
}
```

---

#### 9. Update Event (Admin)
```http
PUT /api/events/:id
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "price": 80.00,
  "capacity": 600
}
```

---

#### 10. Delete Event (Admin)
```http
DELETE /api/events/:id
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "message": "Event deleted successfully"
}
```

---

### Booking Endpoints

#### 11. Create Booking
```http
POST /api/bookings
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "eventId": "64abc123def456",
  "numberOfSeats": 2,
  "userDetails": {
    "name": "John Doe",
    "email": "john@example.com",
    "phone": "+1234567890"
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Booking confirmed",
  "data": {
    "bookingId": "BK123456789",
    "eventTitle": "Music Festival 2024",
    "numberOfSeats": 2,
    "totalAmount": 100.00,
    "status": "confirmed"
  }
}
```

---

#### 12. Get User Bookings
```http
GET /api/bookings
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "_id": "64def456abc789",
      "bookingId": "BK123456789",
      "event": {
        "title": "Music Festival 2024",
        "date": "Dec 1, 2024",
        "location": "Central Park"
      },
      "numberOfSeats": 2,
      "totalAmount": 100.00,
      "status": "confirmed",
      "createdAt": "2024-11-15T10:30:00Z"
    }
  ]
}
```

---

#### 13. Cancel Booking
```http
PUT /api/bookings/:id/cancel
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "message": "Booking cancelled successfully",
  "refundAmount": 100.00
}
```

---

## 🗄️ Database Schema

### User Model
```javascript
{
  _id: ObjectId,
  username: String (required, unique),
  email: String (required, unique),
  password: String (hashed),
  isVerified: Boolean (default: false),
  otp: {
    code: String,
    expiresAt: Date
  },
  role: String (enum: ['user', 'admin']),
  createdAt: Date,
  updatedAt: Date
}
```

### Event Model
```javascript
{
  _id: ObjectId,
  title: String (required),
  image: String (URL),
  startDate: Date (required),
  endDate: Date (required),
  location: String (required),
  category: String (enum: ['Music', 'Sports', 'Tech', 'Arts', 'Food', 'Party']),
  price: Number (required, min: 0),
  capacity: Number (required, min: 1),
  bookedSeats: Number (default: 0),
  description: String,
  createdBy: ObjectId (ref: 'User'),
  createdAt: Date,
  updatedAt: Date
}
```

### Booking Model
```javascript
{
  _id: ObjectId,
  bookingId: String (unique, auto-generated),
  user: ObjectId (ref: 'User'),
  event: ObjectId (ref: 'Event'),
  numberOfSeats: Number (required, min: 1),
  totalAmount: Number (required),
  status: String (enum: ['confirmed', 'cancelled', 'pending']),
  userDetails: {
    name: String,
    email: String,
    phone: String
  },
  paymentStatus: String (enum: ['paid', 'pending', 'refunded']),
  createdAt: Date,
  updatedAt: Date
}
```

---

## 🛡️ Security Features

- **JWT Authentication**: Secure token-based authentication
- **Password Hashing**: bcrypt with salt rounds
- **OTP Verification**: 6-digit time-limited codes
- **Input Validation**: Joi schema validation
- **XSS Protection**: Sanitized user inputs
- **Rate Limiting**: Prevent brute force attacks
- **CORS**: Configured for frontend integration
- **Environment Variables**: Sensitive data protection

---

## 🔧 Environment Setup

### Gmail App Password Setup
1. Enable 2-Factor Authentication in your Google Account
2. Go to Security → App Passwords
3. Generate a new app password for "Mail"
4. Use this password in `EMAIL_PASSWORD` env variable

### MongoDB Setup
**Local:**
```bash
# Install MongoDB
# Start service
mongod

# Connect
mongo
```

**Cloud (MongoDB Atlas):**
1. Create account at [mongodb.com/atlas](https://www.mongodb.com/atlas)
2. Create a cluster
3. Get connection string
4. Add to `.env` as `MONGODB_URI`

---

## 🧪 Testing

```bash
# Run tests
npm test

# Run tests with coverage
npm run test:coverage
```

---

## 📦 Dependencies

| Package | Purpose | Version |
|---------|---------|---------|
| **express** | Web framework | ^4.18.0 |
| **mongoose** | MongoDB ODM | ^7.0.0 |
| **jsonwebtoken** | JWT authentication | ^9.0.0 |
| **bcryptjs** | Password hashing | ^2.4.3 |
| **nodemailer** | Email service | ^6.9.0 |
| **joi** | Input validation | ^17.9.0 |
| **dotenv** | Environment variables | ^16.0.3 |
| **cors** | CORS middleware | ^2.8.5 |
| **express-rate-limit** | Rate limiting | ^6.7.0 |

---

## 🚀 Deployment

### Using Render / Railway / Heroku

1. **Push to GitHub**
```bash
git push origin main
```

2. **Connect to hosting platform**
- Link your GitHub repository
- Set environment variables
- Deploy!

3. **Update frontend with production URL**
```env
BASE_URL=https://your-api.render.com/api
```

---

## 📝 Error Handling

All API responses follow this format:

**Success:**
```json
{
  "success": true,
  "message": "Operation successful",
  "data": { /* response data */ }
}
```

**Error:**
```json
{
  "success": false,
  "message": "Error description",
  "error": "Detailed error message"
}
```

**HTTP Status Codes:**
- `200` - Success
- `201` - Created
- `400` - Bad Request
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `409` - Conflict
- `500` - Internal Server Error

---

## 📄 License

This project is licensed under the **MIT License** - see the LICENSE file for details.

---

## 🤝 Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'Add AmazingFeature'`)
4. Push to branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📧 Support

For support, email ritishmetta@gmail.com or create an issue in the repository.

---

## ⭐ Star this repository if you found it helpful!

**Made with ❤️ using Node.js, Express, and MongoDB**
