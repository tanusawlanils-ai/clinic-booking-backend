/**
 * Clinic Booking System - Backend Server
 * Node.js + Express + MongoDB
 * 
 * Run: npm install express mongoose dotenv twilio cors socket.io bull redis bcryptjs jsonwebtoken
 * Then: node server.js
 */

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const http = require('http');
const socketIO = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Queue = require('bull');
const redis = require('redis');

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: { origin: process.env.FRONTEND_URL || 'http://localhost:3000' }
});

// ============================================
// MIDDLEWARE
// ============================================
app.use(express.json());
app.use(cors());

// ============================================
// DATABASE MODELS
// ============================================

// Patient Model
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
  last_appointment: Date,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Doctor Model
const DoctorSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, unique: true },
  phone: String,
  specialty: { type: String, enum: ['Dental', 'Poly', 'Hoeopathic'], required: true },
  clinic_id: mongoose.Schema.Types.ObjectId,
  qualifications: String,
  experience: Number,
  appointment_duration: { type: Number, default: 30 }, // minutes
  max_appointments_per_day: { type: Number, default: 20 },
  
  // Working hours (0 = Monday, 6 = Sunday)
  working_hours: [{
    day: Number,
    start: String, // "09:00"
    end: String,   // "17:00"
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
  
  is_active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

// Clinic Model
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
  is_active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

// Appointment Model
const AppointmentSchema = new mongoose.Schema({
  patient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
  doctor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
  clinic_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true },
  
  scheduled_date: Date,
  scheduled_time: String, // "14:30"
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
  
  booking_source: { type: String, enum: ['whatsapp', 'web', 'walk_in'], default: 'whatsapp' },
  
  reminder_24h_sent: { type: Boolean, default: false },
  reminder_2h_sent: { type: Boolean, default: false },
  confirmation_received: { type: Boolean, default: false },
  
  feedback: String,
  rating: Number,
  
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// User Model (Admin, Doctor, Receptionist login)
const UserSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true }, // Will be hashed
  name: String,
  role: { type: String, enum: ['admin', 'doctor', 'receptionist'], required: true },
  doctor_id: mongoose.Schema.Types.ObjectId, // If role is doctor
  clinic_id: mongoose.Schema.Types.ObjectId,
  is_active: { type: Boolean, default: true },
  last_login: Date,
  createdAt: { type: Date, default: Date.now }
});

// Message Log Model
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
  twilio_sid: String // For tracking
});

// Create Models
const Patient = mongoose.model('Patient', PatientSchema);
const Doctor = mongoose.model('Doctor', DoctorSchema);
const Clinic = mongoose.model('Clinic', ClinicSchema);
const Appointment = mongoose.model('Appointment', AppointmentSchema);
const User = mongoose.model('User', UserSchema);
const MessageLog = mongoose.model('MessageLog', MessageLogSchema);

// ============================================
// MESSAGE QUEUE SETUP
// ============================================
const reminderQueue = new Queue('appointment-reminders', process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const notificationQueue = new Queue('notifications', process.env.REDIS_URL || 'redis://127.0.0.1:6379');
const bulkMessageQueue = new Queue('bulk-messages', process.env.REDIS_URL || 'redis://127.0.0.1:6379');

// ============================================
// AUTHENTICATION & AUTHORIZATION
// ============================================

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

const generateToken = (user) => {
  return jwt.sign(
    { id: user._id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
};

const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const roleCheck = (allowedRoles) => (req, res, next) => {
  if (!allowedRoles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
};

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Generate available appointment slots for a doctor on a given date
 */
async function getAvailableSlots(doctorId, date) {
  const doctor = await Doctor.findById(doctorId);
  const clinic = await Clinic.findById(doctor.clinic_id);
  
  const dateStr = date.toISOString().split('T')[0];
  const dayOfWeek = date.getDay(); // 0=Sunday, 1=Monday...
  
  // Check if clinic is closed on this date
  const isClinicClosed = clinic.holidays.some(h => h.toISOString().split('T')[0] === dateStr);
  if (isClinicClosed) return [];
  
  // Check if doctor is unavailable
  const isUnavailable = doctor.unavailable_dates.some(u => 
    new Date(u.from) <= date && date <= new Date(u.to)
  );
  if (isUnavailable) return [];
  
  // Get working hours for this day
  const dayHours = doctor.working_hours.find(w => w.day === dayOfWeek);
  if (!dayHours || dayHours.is_off) return [];
  
  const [startHour, startMin] = dayHours.start.split(':').map(Number);
  const [endHour, endMin] = dayHours.end.split(':').map(Number);
  const [breakStart, breakEnd] = dayHours.break_time ? 
    dayHours.break_time.start.split(':').map(Number) : [0, 0];
  
  // Get already booked appointments for this doctor on this date
  const bookedAppointments = await Appointment.find({
    doctor_id: doctorId,
    scheduled_date: {
      $gte: new Date(dateStr),
      $lt: new Date(new Date(dateStr).getTime() + 86400000)
    },
    status: { $in: ['pending', 'confirmed', 'completed'] }
  });
  
  const booked = bookedAppointments.map(a => ({
    start: a.scheduled_time,
    end: new Date(new Date(`${dateStr}T${a.scheduled_time}`).getTime() + a.duration * 60000)
      .toTimeString().substring(0, 5)
  }));
  
  // Generate slots
  const slots = [];
  const durationMin = doctor.appointment_duration;
  let currentHour = startHour;
  let currentMin = startMin;
  
  while (currentHour < endHour || (currentHour === endHour && currentMin < endMin)) {
    const timeStr = `${String(currentHour).padStart(2, '0')}:${String(currentMin).padStart(2, '0')}`;
    
    // Skip break time
    const isBreakTime = breakStart && currentHour >= breakStart && currentHour < breakEnd;
    
    // Check if slot is booked
    const isBooked = booked.some(b => b.start === timeStr);
    
    if (!isBreakTime && !isBooked) {
      slots.push(timeStr);
    }
    
    // Move to next slot
    currentMin += durationMin;
    if (currentMin >= 60) {
      currentHour += Math.floor(currentMin / 60);
      currentMin = currentMin % 60;
    }
  }
  
  return slots;
}

/**
 * Send WhatsApp message via Twilio
 */
const twilio = require('twilio');
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function sendWhatsAppMessage(to, message) {
  try {
    const msg = await twilioClient.messages.create({
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: `whatsapp:${to}`,
      body: message
    });
    
    // Log message
    await MessageLog.create({
      phone: to,
      direction: 'outbound',
      message_type: 'booking',
      content: message,
      twilio_sid: msg.sid
    });
    
    return msg.sid;
  } catch (err) {
    console.error('WhatsApp send error:', err);
    throw err;
  }
}

// ============================================
// ROUTES
// ============================================

// --- Authentication Routes ---
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name, role, clinic_id } = req.body;
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({
      email,
      password: hashedPassword,
      name,
      role,
      clinic_id
    });
    
    await user.save();
    const token = generateToken(user);
    
    res.json({ token, user: { id: user._id, email, name, role } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    
    if (!user) return res.status(401).json({ error: 'User not found' });
    
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) return res.status(401).json({ error: 'Invalid password' });
    
    await User.updateOne({ _id: user._id }, { last_login: new Date() });
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
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Clinic Routes ---
app.get('/api/clinics', async (req, res) => {
  try {
    const clinics = await Clinic.find();
    res.json(clinics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clinics', authMiddleware, roleCheck(['admin']), async (req, res) => {
  try {
    const clinic = new Clinic(req.body);
    await clinic.save();
    res.json(clinic);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Doctor Routes ---
app.get('/api/doctors', async (req, res) => {
  try {
    const { clinic_id, specialty } = req.query;
    const query = { is_active: true };
    
    if (clinic_id) query.clinic_id = clinic_id;
    if (specialty) query.specialty = specialty;
    
    const doctors = await Doctor.find(query);
    res.json(doctors);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/doctors', authMiddleware, roleCheck(['admin']), async (req, res) => {
  try {
    const doctor = new Doctor(req.body);
    await doctor.save();
    res.json(doctor);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/doctors/:id', authMiddleware, roleCheck(['admin', 'doctor']), async (req, res) => {
  try {
    // If doctor is updating own record, check permissions
    if (req.user.role === 'doctor' && req.user.id !== req.params.id) {
      return res.status(403).json({ error: 'Cannot update other doctors' });
    }
    
    const doctor = await Doctor.findByIdAndUpdate(req.params.id, req.body, { new: true });
    
    // If unavailable dates changed, notify patients
    if (req.body.unavailable_dates) {
      io.emit('doctor-unavailable', { doctor_id: doctor._id, dates: req.body.unavailable_dates });
    }
    
    res.json(doctor);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Patient Routes ---
app.get('/api/patients', authMiddleware, roleCheck(['admin', 'receptionist']), async (req, res) => {
  try {
    const patients = await Patient.find();
    res.json(patients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/patients/:phone', async (req, res) => {
  try {
    const patient = await Patient.findOne({ phone: req.params.phone });
    res.json(patient || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/patients', async (req, res) => {
  try {
    let patient = await Patient.findOne({ phone: req.body.phone });
    
    if (!patient) {
      patient = new Patient(req.body);
      await patient.save();
    } else {
      Object.assign(patient, req.body);
      await patient.save();
    }
    
    res.json(patient);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Availability Routes ---
app.get('/api/doctors/:id/available-slots', async (req, res) => {
  try {
    const { date } = req.query; // YYYY-MM-DD
    const slots = await getAvailableSlots(req.params.id, new Date(date));
    res.json(slots);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Appointment Routes ---
app.get('/api/appointments', authMiddleware, async (req, res) => {
  try {
    const { status, patient_id, doctor_id } = req.query;
    const query = {};
    
    // Role-based filtering
    if (req.user.role === 'doctor') {
      query.doctor_id = req.user.doctor_id;
    } else if (req.user.role === 'receptionist') {
      // Can see all in clinic
      query.clinic_id = req.user.clinic_id;
    }
    
    if (status) query.status = status;
    if (patient_id) query.patient_id = patient_id;
    if (doctor_id) query.doctor_id = doctor_id;
    
    const appointments = await Appointment.find(query)
      .populate('patient_id', 'name phone email')
      .populate('doctor_id', 'name specialty')
      .sort({ scheduled_date: 1 });
    
    res.json(appointments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/appointments', async (req, res) => {
  try {
    const { patient_id, doctor_id, clinic_id, scheduled_date, scheduled_time, reason, symptoms, booking_source } = req.body;
    
    // Create appointment
    const appointment = new Appointment({
      patient_id,
      doctor_id,
      clinic_id,
      scheduled_date,
      scheduled_time,
      reason,
      symptoms,
      booking_source: booking_source || 'whatsapp',
      status: 'confirmed'
    });
    
    await appointment.save();
    
    // Get patient info
    const patient = await Patient.findById(patient_id);
    const doctor = await Doctor.findById(doctor_id);
    
    // Send confirmation message
    const message = `✅ Your appointment is confirmed!\n\nDoctor: Dr. ${doctor.name}\nDate: ${new Date(scheduled_date).toLocaleDateString()}\nTime: ${scheduled_time}\nSpecialty: ${doctor.specialty}\n\nPlease arrive 10 minutes early. Reply with any questions!`;
    
    await sendWhatsAppMessage(patient.phone, message);
    
    // Schedule reminders
    const appointmentTime = new Date(`${scheduled_date}T${scheduled_time}`);
    const reminder24h = new Date(appointmentTime.getTime() - 24 * 60 * 60 * 1000);
    const reminder2h = new Date(appointmentTime.getTime() - 2 * 60 * 60 * 1000);
    
    await reminderQueue.add(
      { appointment_id: appointment._id, type: '24h' },
      { delay: Math.max(0, reminder24h.getTime() - Date.now()) }
    );
    
    await reminderQueue.add(
      { appointment_id: appointment._id, type: '2h' },
      { delay: Math.max(0, reminder2h.getTime() - Date.now()) }
    );
    
    // Broadcast to dashboard
    io.emit('appointment-created', appointment);
    
    res.json(appointment);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/appointments/:id', authMiddleware, async (req, res) => {
  try {
    const appointment = await Appointment.findByIdAndUpdate(req.params.id, req.body, { new: true });
    
    io.emit('appointment-updated', appointment);
    res.json(appointment);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/appointments/:id', authMiddleware, async (req, res) => {
  try {
    const appointment = await Appointment.findById(req.params.id);
    const patient = await Patient.findById(appointment.patient_id);
    
    await Appointment.findByIdAndDelete(req.params.id);
    
    // Notify patient
    await sendWhatsAppMessage(patient.phone, `Your appointment has been cancelled. Please book another slot if needed.`);
    
    io.emit('appointment-deleted', { appointment_id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- WhatsApp Webhook (Incoming Messages) ---
app.post('/api/whatsapp/webhook', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const incomingMessage = req.body.Body;
    const from = req.body.From.replace('whatsapp:', '');
    
    // Log inbound message
    await MessageLog.create({
      phone: from,
      direction: 'inbound',
      message_type: 'booking',
      content: incomingMessage
    });
    
    // Get or create patient
    let patient = await Patient.findOne({ phone: from });
    if (!patient) {
      patient = new Patient({ phone: from, name: 'Customer' });
      await patient.save();
    }
    
    // Simple bot logic - in production, use NLP
    const msg = incomingMessage.toLowerCase();
    
    let response = '';
    
    if (msg.includes('book') || msg.includes('appointment') || msg.includes('schedule')) {
      // Get available clinics
      const clinics = await Clinic.find({ is_active: true });
      response = `Hi ${patient.name}! 👋\n\nWhich clinic would you like to book?\n`;
      clinics.forEach((c, i) => {
        response += `${i + 1}. ${c.name} (${c.type})\n`;
      });
      response += `\nReply with the number.`;
    } else if (msg.match(/^[1-9]$/)) {
      // They selected a clinic
      const clinics = await Clinic.find({ is_active: true });
      const clinicIndex = parseInt(msg) - 1;
      
      if (clinicIndex < clinics.length) {
        const clinic = clinics[clinicIndex];
        const doctors = await Doctor.find({ clinic_id: clinic._id, is_active: true });
        
        response = `Great! Available doctors at ${clinic.name}:\n`;
        doctors.forEach((d, i) => {
          response += `${i + 1}. Dr. ${d.name} (${d.specialty})\n`;
        });
        response += `\nReply with the number.`;
        
        // Store selection in session (simplified - use proper session management in production)
      } else {
        response = `Invalid selection. Please try again.`;
      }
    } else {
      response = `Hi! I can help you book an appointment. Just reply with:\n- "book appointment"\n- "schedule"\n- "appointment"`
    }
    
    // Send response
    await sendWhatsAppMessage(from, response);
    
    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('ERROR');
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date() });
});

// ============================================
// SOCKET.IO REAL-TIME UPDATES
// ============================================
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
  
  // Join room for specific clinic
  socket.on('join-clinic', (clinicId) => {
    socket.join(`clinic-${clinicId}`);
  });
  
  // Join room for specific doctor
  socket.on('join-doctor', (doctorId) => {
    socket.join(`doctor-${doctorId}`);
  });
});

// ============================================
// MESSAGE QUEUE PROCESSORS
// ============================================

reminderQueue.process(async (job) => {
  const { appointment_id, type } = job.data;
  
  try {
    const appointment = await Appointment.findById(appointment_id);
    const patient = await Patient.findById(appointment.patient_id);
    const doctor = await Doctor.findById(appointment.doctor_id);
    
    let reminderMsg;
    if (type === '24h') {
      reminderMsg = `⏰ Reminder: You have an appointment with Dr. ${doctor.name} tomorrow at ${appointment.scheduled_time}.\n\nReply:\n✅ CONFIRM\n📅 RESCHEDULE\n❌ CANCEL`;
      await Appointment.updateOne({ _id: appointment_id }, { reminder_24h_sent: true });
    } else {
      reminderMsg = `⏰ Your appointment with Dr. ${doctor.name} is in 2 hours at ${appointment.scheduled_time}. See you soon! 👋`;
      await Appointment.updateOne({ _id: appointment_id }, { reminder_2h_sent: true });
    }
    
    await sendWhatsAppMessage(patient.phone, reminderMsg);
  } catch (err) {
    console.error('Reminder job error:', err);
    throw err;
  }
});

// ============================================
// DATABASE CONNECTION & SERVER START
// ============================================

const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/clinic_booking';

mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => {
  console.log('✅ Connected to MongoDB');
  
  server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
  });
}).catch(err => {
  console.error('❌ MongoDB connection error:', err);
  process.exit(1);
});

module.exports = { app, io, Patient, Doctor, Clinic, Appointment, User };
