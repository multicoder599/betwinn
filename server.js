/* =========================================================
   BETWINN SERVER.JS
   Express + MongoDB + JWT + bcrypt
   ========================================================= */

   require('dotenv').config();
   const express = require('express');
   const cors = require('cors');
   const helmet = require('helmet');
   const rateLimit = require('express-rate-limit');
   const mongoSanitize = require('express-mongo-sanitize');
   const mongoose = require('mongoose');
   const bcrypt = require('bcrypt');
   const jwt = require('jsonwebtoken');
   
   const app = express();
   const PORT = process.env.PORT || 3000;
   const JWT_SECRET = process.env.JWT_SECRET || 'betwinn_secret_key_2026';
   const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/betwinn';
   
   /* =========================================================
      MIDDLEWARE
      ========================================================= */
   app.use(helmet());
   app.use(cors({
    origin: ['https://betwinn.co.ke', 'https://www.betwinn.co.ke'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
}));

   app.use(express.json({ limit: '10mb' }));
   app.use(mongoSanitize());
   
   const limiter = rateLimit({
       windowMs: 15 * 60 * 1000, // 15 minutes
       max: 100, // limit each IP to 100 requests per windowMs
       message: { success: false, message: 'Too many requests, please try again later.' }
   });
   app.use('/api/', limiter);
   
   const authLimiter = rateLimit({
       windowMs: 60 * 60 * 1000, // 1 hour
       max: 10,
       message: { success: false, message: 'Too many auth attempts, please try again later.' }
   });
   app.use('/api/auth/', authLimiter);
   
   /* =========================================================
      DATABASE MODELS
      ========================================================= */
   
   // User Schema
   const userSchema = new mongoose.Schema({
       name: { type: String, required: true },
       email: { type: String, required: true, unique: true, lowercase: true },
       phone: { type: String, required: true, unique: true },
       password: { type: String, required: true },
       balance: { type: Number, default: 0 },
       totalBets: { type: Number, default: 0 },
       isVerified: { type: Boolean, default: false },
       createdAt: { type: Date, default: Date.now }
   });
   
   const User = mongoose.model('User', userSchema);
   
   // Match Schema
   const matchSchema = new mongoose.Schema({
       league: { type: String, required: true },
       homeTeam: { type: String, required: true },
       awayTeam: { type: String, required: true },
       startTime: { type: Date, required: true },
       isLive: { type: Boolean, default: false },
       homeScore: { type: Number, default: 0 },
       awayScore: { type: Number, default: 0 },
       statusText: { type: String, default: '' },
       sport: { type: String, default: 'soccer' },
       odds: {
           '1': { type: Number, default: 0 },
           'X': { type: Number, default: 0 },
           '2': { type: Number, default: 0 }
       },
       marketsCount: { type: Number, default: 99 },
       featured: { type: Boolean, default: false },
       createdAt: { type: Date, default: Date.now }
   });
   
   const Match = mongoose.model('Match', matchSchema);
   
   // Bet Schema
   const betSchema = new mongoose.Schema({
       userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
       selections: [{
           matchId: { type: Number, required: true },
           pick: { type: String, required: true },
           odd: { type: Number, required: true },
           title: { type: String }
       }],
       stake: { type: Number, required: true },
       totalOdds: { type: Number, required: true },
       potentialWin: { type: Number, required: true },
       status: { type: String, enum: ['pending', 'won', 'lost'], default: 'pending' },
       placedAt: { type: Date, default: Date.now }
   });
   
   const Bet = mongoose.model('Bet', betSchema);
   
   // Notification Schema
   const notificationSchema = new mongoose.Schema({
       userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
       title: { type: String, required: true },
       message: { type: String, required: true },
       icon: { type: String, default: 'fa-bell' },
       read: { type: Boolean, default: false },
       createdAt: { type: Date, default: Date.now }
   });
   
   const Notification = mongoose.model('Notification', notificationSchema);
   
   /* =========================================================
      AUTH MIDDLEWARE
      ========================================================= */
   const authenticate = async (req, res, next) => {
       try {
           const token = req.headers.authorization?.split(' ')[1];
           if (!token) return res.status(401).json({ success: false, message: 'Access denied. No token provided.' });
   
           const decoded = jwt.verify(token, JWT_SECRET);
           const user = await User.findById(decoded.id).select('-password');
           if (!user) return res.status(401).json({ success: false, message: 'User not found.' });
   
           req.user = user;
           next();
       } catch (err) {
           res.status(401).json({ success: false, message: 'Invalid token.' });
       }
   };
   
   /* =========================================================
      AUTH ROUTES
      ========================================================= */
   
   // Register
   app.post('/api/auth/register', async (req, res) => {
       try {
           const { name, email, phone, password } = req.body;
           if (!name || !phone || !password) {
               return res.status(400).json({ success: false, message: 'Name, phone and password are required.' });
           }
   
           const existingUser = await User.findOne({ $or: [{ phone }, { email }] });
           if (existingUser) {
               return res.status(400).json({ success: false, message: 'User with this phone or email already exists.' });
           }
   
           const hashedPassword = await bcrypt.hash(password, 12);
           const user = new User({ name, email: email || `${phone}@betwinn.co.ke`, phone, password: hashedPassword });
           await user.save();
   
           const token = jwt.sign({ id: user._id, phone: user.phone }, JWT_SECRET, { expiresIn: '7d' });
   
           res.status(201).json({
               success: true,
               token,
               user: {
                   id: user._id,
                   name: user.name,
                   phone: user.phone,
                   email: user.email,
                   balance: user.balance,
                   totalBets: user.totalBets
               }
           });
       } catch (err) {
           console.error('Register error:', err);
           res.status(500).json({ success: false, message: 'Server error during registration.' });
       }
   });
   
   // Login
   app.post('/api/auth/login', async (req, res) => {
       try {
           const { phone, password } = req.body;
           if (!phone || !password) {
               return res.status(400).json({ success: false, message: 'Phone and password are required.' });
           }
   
           const user = await User.findOne({ phone });
           if (!user) {
               return res.status(400).json({ success: false, message: 'Invalid credentials.' });
           }
   
           const isMatch = await bcrypt.compare(password, user.password);
           if (!isMatch) {
               return res.status(400).json({ success: false, message: 'Invalid credentials.' });
           }
   
           const token = jwt.sign({ id: user._id, phone: user.phone }, JWT_SECRET, { expiresIn: '7d' });
   
           res.json({
               success: true,
               token,
               user: {
                   id: user._id,
                   name: user.name,
                   phone: user.phone,
                   email: user.email,
                   balance: user.balance,
                   totalBets: user.totalBets
               }
           });
       } catch (err) {
           console.error('Login error:', err);
           res.status(500).json({ success: false, message: 'Server error during login.' });
       }
   });
   
   /* =========================================================
      USER ROUTES
      ========================================================= */
   app.get('/api/user', authenticate, async (req, res) => {
       res.json({
           success: true,
           user: {
               id: req.user._id,
               name: req.user.name,
               phone: req.user.phone,
               email: req.user.email,
               balance: req.user.balance,
               totalBets: req.user.totalBets
           }
       });
   });
   
   /* =========================================================
      SPORTS & COMPETITIONS
      ========================================================= */
   app.get('/api/sports', async (req, res) => {
       const sports = [
           { id: 'soccer', name: 'Football', icon: 'fa-futbol', color: '#3b82f6' },
           { id: 'basketball', name: 'Basketball', icon: 'fa-basketball', color: '#f97316' },
           { id: 'tennis', name: 'Tennis', icon: 'fa-table-tennis-paddle-ball', color: '#22c55e' },
           { id: 'cricket', name: 'Cricket', icon: 'fa-baseball-bat-ball', color: '#ef4444' },
           { id: 'icehockey', name: 'Ice Hockey', icon: 'fa-hockey-puck', color: '#06b6d4' },
           { id: 'volleyball', name: 'Volleyball', icon: 'fa-volleyball', color: '#8b5cf6' },
           { id: 'baseball', name: 'Baseball', icon: 'fa-baseball', color: '#eab308' },
           { id: 'rugby', name: 'Rugby', icon: 'fa-football', color: '#ec4899' },
           { id: 'mma', name: 'MMA', icon: 'fa-hand-fist', color: '#6b7280' }
       ];
       res.json({ success: true, sports });
   });
   
   app.get('/api/competitions', async (req, res) => {
       const competitions = [
           { name: 'Premier League', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', league: 'Premier League' },
           { name: 'La Liga', flag: '🇪🇸', league: 'La Liga' },
           { name: 'Serie A', flag: '🇮🇹', league: 'Serie A' },
           { name: 'Bundesliga', flag: '🇩🇪', league: 'Bundesliga' },
           { name: 'Ligue 1', flag: '🇫🇷', league: 'Ligue 1' },
           { name: 'Champions League', flag: '🏆', league: 'UEFA Champions', special: true }
       ];
       res.json({ success: true, competitions });
   });
   
   /* =========================================================
      MATCHES ROUTES
      ========================================================= */
   app.get('/api/matches', async (req, res) => {
       try {
           const { sport, league, status, date, search, page = 1, limit = 30 } = req.query;
           let query = {};
   
           if (sport) query.sport = sport;
           if (league) query.league = league;
           if (status === 'live') query.isLive = true;
           if (search) {
               query.$or = [
                   { homeTeam: { $regex: search, $options: 'i' } },
                   { awayTeam: { $regex: search, $options: 'i' } },
                   { league: { $regex: search, $options: 'i' } }
               ];
           }
           if (date === 'today') {
               const today = new Date(); today.setHours(0,0,0,0);
               const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate()+1);
               query.startTime = { $gte: today, $lt: tomorrow };
           }
           if (date === 'tomorrow') {
               const tomorrow = new Date(); tomorrow.setHours(0,0,0,0); tomorrow.setDate(tomorrow.getDate()+1);
               const dayAfter = new Date(tomorrow); dayAfter.setDate(dayAfter.getDate()+1);
               query.startTime = { $gte: tomorrow, $lt: dayAfter };
           }
   
           const matches = await Match.find(query)
               .sort({ startTime: 1 })
               .limit(parseInt(limit))
               .skip((parseInt(page) - 1) * parseInt(limit));
   
           res.json({ success: true, matches, page: parseInt(page), total: await Match.countDocuments(query) });
       } catch (err) {
           console.error('Matches error:', err);
           res.status(500).json({ success: false, message: 'Failed to fetch matches.' });
       }
   });
   
   app.get('/api/matches/featured', async (req, res) => {
       try {
           const matches = await Match.find({ featured: true }).limit(10);
           res.json({ success: true, matches });
       } catch (err) {
           res.status(500).json({ success: false, message: 'Failed to fetch featured matches.' });
       }
   });
   
   app.get('/api/match/:id/markets', async (req, res) => {
       try {
           const match = await Match.findById(req.params.id);
           if (!match) return res.status(404).json({ success: false, message: 'Match not found.' });
   
           // Return default markets structure
           const markets = [
               { name: '1X2', selections: [
                   { name: '1', odd: match.odds['1'] },
                   { name: 'X', odd: match.odds['X'] },
                   { name: '2', odd: match.odds['2'] }
               ]},
               { name: 'Over/Under 2.5', selections: [
                   { name: 'Over', odd: 1.85 },
                   { name: 'Under', odd: 1.95 }
               ]},
               { name: 'Both Teams To Score', selections: [
                   { name: 'Yes', odd: 1.75 },
                   { name: 'No', odd: 2.05 }
               ]}
           ];
           res.json({ success: true, markets });
       } catch (err) {
           res.status(500).json({ success: false, message: 'Failed to fetch markets.' });
       }
   });
   
   /* =========================================================
      NOTIFICATIONS
      ========================================================= */
   app.get('/api/notifications', authenticate, async (req, res) => {
       try {
           const notifications = await Notification.find({ userId: req.user._id })
               .sort({ createdAt: -1 })
               .limit(20);
           res.json({ success: true, notifications });
       } catch (err) {
           res.status(500).json({ success: false, message: 'Failed to fetch notifications.' });
       }
   });
   
   /* =========================================================
      BETTING ROUTES
      ========================================================= */
   app.post('/api/bets/place', authenticate, async (req, res) => {
       try {
           const { selections, stake, totalOdds, potentialWin } = req.body;
           if (!selections || !selections.length || !stake || !totalOdds) {
               return res.status(400).json({ success: false, message: 'Invalid bet data.' });
           }
   
           if (stake < 10) {
               return res.status(400).json({ success: false, message: 'Minimum stake is KES 10.' });
           }
           if (stake > req.user.balance) {
               return res.status(400).json({ success: false, message: 'Insufficient balance.' });
           }
   
           const bet = new Bet({
               userId: req.user._id,
               selections,
               stake,
               totalOdds,
               potentialWin
           });
           await bet.save();
   
           // Deduct balance
           req.user.balance -= stake;
           req.user.totalBets += 1;
           await req.user.save();
   
           res.json({
               success: true,
               betId: bet._id,
               message: 'Bet placed successfully.',
               potentialWin
           });
       } catch (err) {
           console.error('Place bet error:', err);
           res.status(500).json({ success: false, message: 'Failed to place bet.' });
       }
   });
   
   app.get('/api/bets/my', authenticate, async (req, res) => {
       try {
           const bets = await Bet.find({ userId: req.user._id })
               .sort({ placedAt: -1 })
               .limit(50);
           res.json({ success: true, bets });
       } catch (err) {
           res.status(500).json({ success: false, message: 'Failed to fetch bets.' });
       }
   });
   
   /* =========================================================
      SEED DATA (Development)
      ========================================================= */
   async function seedMatches() {
       const count = await Match.countDocuments();
       if (count > 0) return;
   
       const leagues = ['Premier League', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'UEFA Champions', 'Kenya Premier League'];
       const teams = [
           'Gor Mahia', 'AFC Leopards', 'Tusker FC', 'Arsenal', 'Chelsea', 'Man City', 'Liverpool',
           'Real Madrid', 'Barcelona', 'Atletico Madrid', 'Bayern Munich', 'Dortmund', 'Juventus',
           'Inter Milan', 'PSG', 'Ajax', 'Napoli', 'Roma'
       ];
   
       const matches = [];
       for (let i = 1; i <= 50; i++) {
           const home = teams[Math.floor(Math.random() * teams.length)];
           let away;
           do { away = teams[Math.floor(Math.random() * teams.length)]; } while (away === home);
           const isLive = Math.random() > 0.7;
           const league = leagues[Math.floor(Math.random() * leagues.length)];
   
           matches.push({
               league,
               homeTeam: home,
               awayTeam: away,
               startTime: isLive ? new Date(Date.now() - Math.random()*5400000) : new Date(Date.now() + Math.random()*86400000*3),
               isLive,
               homeScore: isLive ? Math.floor(Math.random()*4) : 0,
               awayScore: isLive ? Math.floor(Math.random()*4) : 0,
               statusText: isLive ? `${Math.floor(Math.random()*90)}'` : '',
               odds: {
                   '1': (Math.random()*6 + 1.2).toFixed(2),
                   'X': (Math.random()*10 + 2.5).toFixed(2),
                   '2': (Math.random()*30 + 1.2).toFixed(2)
               },
               marketsCount: Math.floor(Math.random()*150) + 50,
               featured: Math.random() > 0.8
           });
       }
       await Match.insertMany(matches);
       console.log('Seeded 50 matches');
   }
   
   /* =========================================================
      START SERVER
      ========================================================= */
   mongoose.connect(MONGO_URI)
       .then(() => {
           console.log('MongoDB connected');
           seedMatches();
           app.listen(PORT, () => {
               console.log(`BetWinn API running on port ${PORT}`);
               console.log(`API Base: http://localhost:${PORT}/api`);
           });
       })
       .catch(err => {
           console.error('MongoDB connection failed:', err);
           process.exit(1);
       });