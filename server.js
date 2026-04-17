/**
 * Clinic Booking System - Backend Server
 * Railway-ready version
 * Node.js + Express + MongoDB
 */

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const http = require('http');
const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors({
  origin: process.env.FRONTEND_URL || '*'
}));

// ============================================
// DATABASE MODELS
// ============================================

const PatientSchema = new mongoose.Schema({
  phone: { type: String, unique: true, required: true },
  name: String,
  email: String,
  age: Number,
  gender: String,
  address: String,
  allergies: String,
  medical_history: String,
  preferred_doctor: mongoose.Schema.Types.ObjectId,
  preferred_clinic: String,
  booking_count: { type: Number, default: 0 },
  last_appointment: Date
}, { timestamps: true });

const DoctorSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, unique: true, sparse: true },
  phone: String,
  specialty: {
    type: String,
    enum: ['Dental', 'Poly', 'Hoeopathic'],
    required: true
  },
  clinic_id: mongoose.Schema.Types.ObjectId,
  qualifications: String,
  experience: Number,
  appointment_duration: { type: Number, default: 30 },
  max_appointments_per_day: { type: Number, default: 20 },
  working_hours: [{
    day: Number,
    start: String,
    end: String,
    is_off: Boolean
  }],
  break_time: {
    start: String,
    end: String
  },
  unavailable_dates: [{
    from: Date,
    to: Date,
    reason: String,
    auto_notify_patients: { type: Boolean, default: true }
  }],
  is_active: { type: Boolean, default: true }
}, { timestamps: true });

const ClinicSchema = new mongoose.Schema({
  name: { type: String, required: true },
  type: { type: String, enum: ['Dental', 'Poly', 'Hoeopathic'] },
  address: String,
  phone: String,
  email: String,
  working_hours: [{
    day: Number,
    start: String,
    end: String
  }],
  holidays: [Date],
  logo: String,
  is_active: { type: Boolean, default: true }
}, { timestamps: true });

const AppointmentSchema = new mongoose.Schema({
  patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
  clinic_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true },
  scheduled_date: Date,
  scheduled_time: String,
  duration: { type: Number, default: 30 },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'completed', 'no_show', 'cancelled', 'rescheduled'],
    default: 'pending'
  },
  reason: String,
  symptoms: String,
  notes: String,
  prescription: String,
  booking_source: {
    type: String,
    enum: ['whatsapp', 'web', 'walk_in'],
    default: 'whatsapp'
  },
  reminder_24h_sent: { type: Boolean, default: false },
  reminder_2h_sent: { type: Boolean, default: false },
  confirmation_received: { type: Boolean, default: false },
  feedback: String,
  rating: Number
}, { timestamps: true });

const UserSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  name: String,
  role: {
    type: String,
    enum: ['admin', 'doctor', 'receptionist'],
    required: true
  },
  doctor_id: mongoose.Schema.Types.ObjectId,
  clinic_id: mongoose.Schema.Types.ObjectId,
  is_active: { type: Boolean, default: true },
  last_login: Date
}, { timestamps: true });

const MessageLogSchema = new mongoose.Schema({
  patient_id: mongoose.Schema.Types.ObjectId,
  doctor_id: mongoose.Schema.Types.ObjectId,
  direction: { type: String, enum: ['inbound', 'outbound'] },
  message_type: { type: String, enum: ['booking', 'reminder', 'follow_up', 'bulk', 'status_update'] },
  content: String,
  sent_at: { type: Date, default: Date.now },
  delivered_at: Date,
  read_at: Date,
  response: String,
  appointment_id: mongoose.Schema.Types.ObjectId,
  phone: String,
  twilio_sid: String
});

const Patient = mongoose.model('Patient', PatientSchema);
const Doctor = mongoose.model('Doctor', DoctorSchema);
const Clinic = mongoose.model('Clinic', ClinicSchema);
const Appointment = mongoose.model('Appointment', AppointmentSchema);
const User = mongoose.model('User', UserSchema);
const MessageLog = mongoose.model('MessageLog', MessageLogSchema);

// ============================================
// AUTH
// ============================================

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-in-production';

const generateToken = (user) => {
  return jwt.sign(
    {
      id: user._id,
      email: user.email,
      role: user.role,
      doctor_id: user.doctor_id || null,
      clinic_id: user.clinic_id || null
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
};

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const roleCheck = (allowedRoles) => (req, res, next) => {
  if (!req.user || !allowedRoles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
};

// ============================================
// HELPERS
// ============================================

async function sendWhatsAppMessage(to, message) {
  const hasTwilio =
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_WHATSAPP_NUMBER;

  if (!hasTwilio) {
    await MessageLog.create({
      phone: to,
      direction: 'outbound',
      message_type: 'booking',
      content: message
    });
    console.log(`WhatsApp skipped (Twilio not configured) -> ${to}: ${message}`);
    return null;
  }

  try {
    const twilio = require('twilio');
    const twilioClient = twilio(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_AUTH_TOKEN
    );

    const msg = await twilioClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${to}`,
      body: message
    });

    await MessageLog.create({
      phone: to,
      direction: 'outbound',
      message_type: 'booking',
      content: message,
      twilio_sid: msg.sid
    });

    return msg.sid;
  } catch (error) {
    console.error('WhatsApp send error:', error.message);
    return null;
  }
}

async function getAvailableSlots(doctorId, date) {
  const doctor = await Doctor.findById(doctorId);
  if (!doctor) return [];

  const clinic = await Clinic.findById(doctor.clinic_id);
  const dateObj = new Date(date);
  const dateStr = dateObj.toISOString().split('T')[0];
  const dayOfWeek = dateObj.getDay();

  if (clinic && Array.isArray(clinic.holidays)) {
    const isClinicClosed = clinic.holidays.some(
      (h) => new Date(h).toISOString().split('T')[0] === dateStr
    );
    if (isClinicClosed) return [];
  }

  if (Array.isArray(doctor.unavailable_dates)) {
    const isUnavailable = doctor.unavailable_dates.some(
      (u) => new Date(u.from) <= dateObj && dateObj <= new Date(u.to)
    );
    if (isUnavailable) return [];
  }

  const dayHours = (doctor.working_hours || []).find((w) => w.day === dayOfWeek);
  if (!dayHours || dayHours.is_off || !dayHours.start || !dayHours.end) return [];

  const [startHour, startMin] = dayHours.start.split(':').map(Number);
  const [endHour, endMin] = dayHours.end.split(':').map(Number);

  let breakStartMinutes = null;
  let breakEndMinutes = null;

  if (doctor.break_time?.start && doctor.break_time?.end) {
    const [bsh, bsm] = doctor.break_time.start.split(':').map(Number);
    const [beh, bem] = doctor.break_time.end.split(':').map(Number);
    breakStartMinutes = bsh * 60 + bsm;
    breakEndMinutes = beh * 60 + bem;
  }

  const bookedAppointments = await Appointment.find({
    doctor_id: doctorId,
    scheduled_date: {
      $gte: new Date(`${dateStr}T00:00:00.000Z`),
      $lt: new Date(`${dateStr}T23:59:59.999Z`)
    },
    status: { $in: ['pending', 'confirmed', 'completed'] }
  });

  const bookedTimes = new Set(bookedAppointments.map((a) => a.scheduled_time));
  const slots = [];
  const durationMin = doctor.appointment_duration || 30;

  let currentMinutes = startHour * 60 + startMin;
  const endMinutes = endHour * 60 + endMin;

  while (currentMinutes < endMinutes) {
    const hh = String(Math.floor(currentMinutes / 60)).padStart(2, '0');
    const mm = String(currentMinutes % 60).padStart(2, '0');
    const timeStr = `${hh}:${mm}`;

    const isBreakTime =
      breakStartMinutes !== null &&
      breakEndMinutes !== null &&
      currentMinutes >= breakStartMinutes &&
      currentMinutes < breakEndMinutes;

    if (!isBreakTime && !bookedTimes.has(timeStr)) {
      slots.push(timeStr);
    }

    currentMinutes += durationMin;
  }

  return slots;
}

// ============================================
// ROUTES
// ============================================

app.get('/', (req, res) => {
  res.json({
    message: 'Clinic Booking Backend API running',
    health: '/api/health'
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date(),
    env: process.env.NODE_ENV || 'development'
  });
});

// Auth
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, role, clinic_id, doctor_id } = req.body;

    if (!email || !password || !role) {
      return res.status(400).json({ error: 'email, password and role are required' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      email,
      password: hashedPassword,
      name,
      role,
      clinic_id,
      doctor_id
    });

    const token = generateToken(user);

    res.status(201).json({
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        clinic_id: user.clinic_id,
        doctor_id: user.doctor_id
      }
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: 'User not found' });

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(401).json({ error: 'Invalid password' });

    user.last_login = new Date();
    await user.save();

    const token = generateToken(user);

    res.json({
      token,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        doctor_id: user.doctor_id,
        clinic_id: user.clinic_id
      }
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Clinics
app.get('/api/clinics', async (req, res) => {
  try {
    const clinics = await Clinic.find().sort({ createdAt: -1 });
    res.json(clinics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/clinics', authMiddleware, roleCheck(['admin']), async (req, res) => {
  try {
    const clinic = await Clinic.create(req.body);
    res.status(201).json(clinic);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Doctors
app.get('/api/doctors', async (req, res) => {
  try {
    const { clinic_id, specialty } = req.query;
    const query = { is_active: true };

    if (clinic_id) query.clinic_id = clinic_id;
    if (specialty) query.specialty = specialty;

    const doctors = await Doctor.find(query).sort({ createdAt: -1 });
    res.json(doctors);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/doctors', authMiddleware, roleCheck(['admin']), async (req, res) => {
  try {
    const doctor = await Doctor.create(req.body);
    res.status(201).json(doctor);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app
