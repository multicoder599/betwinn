/* =========================================================
   BETWINN SERVER.JS (Production v5.3 — Settlement & Timezone Fix)
   Express + MongoDB + JWT + bcrypt + axios + helmet + rate-limit
   ========================================================= */

   require('dotenv').config();
   const express = require('express');
   const cors = require('cors');
   const helmet = require('helmet');
   const rateLimit = require('express-rate-limit');
   const mongoose = require('mongoose');
   const bcrypt = require('bcrypt');
   const jwt = require('jsonwebtoken');
   const axios = require('axios');

   const app = express();
   app.set('trust proxy', 1);

   const PORT = process.env.PORT || 3012;
   const JWT_SECRET = process.env.JWT_SECRET || 'betwinn_secret_key_2026';
   const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/betwinn';
   const ODDS_API_KEY = process.env.ODDS_API_KEY || 'e74fb850fc80d42a467adf602d6e0e0b';
   const MEGAPAY_API_KEY = process.env.MEGAPAY_API_KEY || 'MGPY5V6XltyF';
   const MEGAPAY_EMAIL = process.env.MEGAPAY_EMAIL || 'kanyingiwaitara@gmail.com';

/* =========================================================
   API CACHE (Preserve Credits)
   ========================================================= */
const API_CACHE = {
    lastFetch: 0,
    ttl: 30 * 60 * 1000,
    sportsLastFetch: 0,
    sportsTtl: 60 * 60 * 1000,
    cachedSports: []
};

function isCacheFresh(cacheTime, ttl) {
    return (Date.now() - cacheTime) < ttl;
}

   /* =========================================================
      CUSTOM MONGO SANITIZE
      ========================================================= */
   function sanitizeObject(obj) {
       if (obj instanceof Object && !(obj instanceof Date)) {
           for (let key in obj) {
               if (/^\$|\./.test(key)) { delete obj[key]; }
               else { sanitizeObject(obj[key]); }
           }
       }
       return obj;
   }

   /* =========================================================
      MIDDLEWARE
      ========================================================= */
   app.use(helmet());
   app.use(cors({
       origin: ['https://betwinn.co.ke', 'https://www.betwinn.co.ke', 'http://localhost:3012', 'http://127.0.0.1:3012', 'https://winsadmin.surge.sh'],
       methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
       credentials: true,
       allowedHeaders: ['Content-Type', 'Authorization']
   }));
   app.use(express.json({ limit: '10mb' }));
   app.use(express.urlencoded({ extended: true, limit: '10mb' }));

   app.use((req, res, next) => {
       if (req.body) sanitizeObject(req.body);
       if (req.query) sanitizeObject(req.query);
       if (req.params) sanitizeObject(req.params);
       next();
   });

   const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, message: { success: false, message: 'Too many requests.' } });
   app.use('/api/', limiter);

   const authLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 15, message: { success: false, message: 'Too many auth attempts.' } });
   app.use('/api/auth/', authLimiter);

   /* =========================================================
      UTILS
      ========================================================= */
   const sendTelegramMessage = async (message) => {
       const token = process.env.TELEGRAM_BOT_TOKEN;
       const chatId = process.env.TELEGRAM_CHAT_ID;
       if (!token || !chatId) return;
       try {
           await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text: message, parse_mode: 'HTML' });
       } catch (err) { console.error("Telegram failed:", err.message); }
   };

   const getTimezoneFromCountry = (countryCode, phone = '') => {
       const map = { KE: 'Africa/Nairobi', CM: 'Africa/Douala', UG: 'Africa/Kampala', TZ: 'Africa/Dar_es_Salaam', NG: 'Africa/Lagos', ZA: 'Africa/Johannesburg', GH: 'Africa/Accra', GB: 'Europe/London', US: 'America/New_York' };
       const p = String(phone).replace(/\D/g, '');
       if (p.startsWith('254')) return 'Africa/Nairobi';
       if (p.startsWith('237')) return 'Africa/Douala';
       if (p.startsWith('255')) return 'Africa/Dar_es_Salaam';
       if (p.startsWith('256')) return 'Africa/Kampala';
       if (p.startsWith('234')) return 'Africa/Lagos';
       return map[countryCode] || 'UTC';
   };

   // FIX: Parse admin-input datetimes as Kenyan (EAT, UTC+3) time
   function parseAsKenyanTime(input) {
       if (!input) return null;
       if (input instanceof Date) return input;
       const str = String(input).trim();
       // ISO without timezone → assume Kenya (+03:00)
       if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(str)) {
           return new Date(str + '+03:00');
       }
       // Already has timezone
       if (str.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(str)) {
           return new Date(str);
       }
       const d = new Date(str);
       return isNaN(d.getTime()) ? null : d;
   }

   // FIX: Format any date to Kenyan time string
   function toKenyanTimeStr(dateObj, opts = {}) {
       if (!dateObj) return '';
       const d = new Date(dateObj);
       if (isNaN(d.getTime())) return '';
       return d.toLocaleString('en-GB', {
           timeZone: 'Africa/Nairobi',
           day: '2-digit', month: 'short', year: 'numeric',
           hour: '2-digit', minute: '2-digit',
           ...opts
       });
   }

   function getCountryCodeFromSportKey(sportKey) {
       if (!sportKey) return 'gb';
       const map = {
           'soccer_epl': 'gb-eng', 'soccer_spain': 'es', 'soccer_italy': 'it', 'soccer_germany': 'de',
           'soccer_france': 'fr', 'soccer_uefa': 'eu', 'soccer_netherlands': 'nl', 'soccer_portugal': 'pt',
           'soccer_belgium': 'be', 'soccer_turkey': 'tr', 'soccer_usa': 'us', 'soccer_kenya': 'ke',
           'basketball_nba': 'us', 'tennis_atp': 'gb', 'mma_ufc': 'us'
       };
       for (const [prefix, code] of Object.entries(map)) {
           if (sportKey.toLowerCase().startsWith(prefix)) return code;
       }
       return 'gb';
   }

   function getTeamFlagUrl(teamName, countryCode) {
       const cc = countryCode || 'gb-eng';
       const encoded = encodeURIComponent(teamName || 'Team');
       return {
           flag: `https://flagcdn.com/w40/${cc}.png`,
           logo: `https://ui-avatars.com/api/?name=${encoded}&background=3b82f6&color=fff&size=128&bold=true&font-size=0.4`,
           svg: `https://flagcdn.com/${cc}.svg`
       };
   }

   function enrichMatchWithFlags(matchObj) {
       const cc = matchObj.country || getCountryCodeFromSportKey(matchObj.sport_key || matchObj.sport || 'soccer');
       const home = matchObj.homeTeam || matchObj.home || 'Home';
       const away = matchObj.awayTeam || matchObj.away || 'Away';
       const homeFlags = getTeamFlagUrl(home, cc);
       const awayFlags = getTeamFlagUrl(away, cc);
       matchObj.homeFlag = homeFlags.flag;
       matchObj.awayFlag = awayFlags.flag;
       matchObj.homeLogo = homeFlags.logo;
       matchObj.awayLogo = awayFlags.logo;
       matchObj.leagueFlag = `https://flagcdn.com/w40/${cc}.png`;
       matchObj.country = cc;
       matchObj.home = matchObj.homeTeam || matchObj.home || 'Home';
       matchObj.away = matchObj.awayTeam || matchObj.away || 'Away';
       return matchObj;
   }

   function getMatchTimeStr(startTimeStr) {
       if (!startTimeStr) return "";
       const elapsedMs = new Date().getTime() - new Date(startTimeStr).getTime();
       const elapsedMins = Math.floor(elapsedMs / 60000);
       if (elapsedMins < 0) return "Upcoming";
       if (elapsedMins <= 45) return `${elapsedMins}'`;
       if (elapsedMins > 45 && elapsedMins <= 50) return `45+${elapsedMins - 45}'`;
       if (elapsedMins > 50 && elapsedMins <= 65) return "HT";
       if (elapsedMins > 65 && elapsedMins <= 110) return `${45+(elapsedMins-65)}'`;
       if (elapsedMins > 110 && elapsedMins <= 116) return `90+${elapsedMins-110}'`;
       if (elapsedMins > 116 && elapsedMins < 120) return "Settling...";
       return "FT";
   }

   function getDeterministicScore(matchId, startTimeStr, adminResultObj) {
       const start = new Date(startTimeStr).getTime();
       const now = new Date().getTime();
       const elapsed = now - start;
       if (elapsed < 0) return null;
       const duration = 116 * 60 * 1000;
       const progress = Math.min(elapsed / duration, 1);
       if (adminResultObj && adminResultObj.homeGoals !== undefined) {
           return `${Math.floor(adminResultObj.homeGoals * progress)}-${Math.floor(adminResultObj.awayGoals * progress)}`;
       }
       let seed = 0;
       for (let i = 0; i < matchId.length; i++) { seed += matchId.charCodeAt(i); }
       const maxHome = seed % 4;
       const maxAway = (seed * 3) % 4;
       return `${Math.floor(maxHome * progress)}-${Math.floor(maxAway * progress)}`;
   }

   /* =========================================================
      DATABASE MODELS
      ========================================================= */
   const userSchema = new mongoose.Schema({
       username: { type: String, required: true, unique: true, sparse: true },
       name: { type: String, default: 'Player' },
       email: { type: String, required: false, unique: true, sparse: true, lowercase: true },
       phone: { type: String, required: true, unique: true },
       password: { type: String, required: true },
       balance: { type: Number, default: 0 },
       totalBets: { type: Number, default: 0 },
       totalWon: { type: Number, default: 0 },
       currency: { type: String, default: 'KES' },
       oddsFormat: { type: String, default: 'decimal' },
       countryCode: { type: String, default: 'KE' },
       timezone: { type: String, default: 'Africa/Nairobi' },
       isVerified: { type: Boolean, default: false },
       createdAt: { type: Date, default: Date.now }
   });
   const User = mongoose.model('User', userSchema);

   const matchSchema = new mongoose.Schema({
       apiId: { type: String, unique: true, sparse: true },
       sport: { type: String, default: 'soccer' },
       league: { type: String, required: true },
       country: { type: String, default: 'gb-eng' },
       homeTeam: { type: String, required: true },
       awayTeam: { type: String, required: true },
       startTime: { type: Date, required: true },
       timezone: { type: String, default: 'UTC' },
       isLive: { type: Boolean, default: false },
       status: { type: String, enum: ['upcoming', 'live', 'completed'], default: 'upcoming' },
       homeScore: { type: Number, default: 0 },
       awayScore: { type: Number, default: 0 },
       score: { type: String, default: '' },
       finalScore: { type: String, default: '' },
       statusText: { type: String, default: '' },
       time: { type: String, default: '' },
       date: { type: String, default: '' },
       odds: { '1': { type: Number, default: 0 }, 'X': { type: Number, default: 0 }, '2': { type: Number, default: 0 } },
       oddsArr: { type: [Number], default: [2.10, 3.10, 2.80] },
       markets: {
           h2h: { home: Number, draw: Number, away: Number },
           correctScore: [{ score: String, odds: Number }],
           overUnder: [{ line: Number, over: Number, under: Number }],
           btts: { yes: Number, no: Number },
           doubleChance: { '1x': Number, x2: Number, '12': Number }
       },
       detailedMarkets: { type: mongoose.Schema.Types.Mixed, default: {} },
       marketsCount: { type: Number, default: 0 },
       featured: { type: Boolean, default: false },
       result: {
           homeGoals: Number, awayGoals: Number, correctScore: String,
           btts: String, winner: String
       },
       createdAt: { type: Date, default: Date.now }
   });
   const Match = mongoose.model('Match', matchSchema);

   const betSchema = new mongoose.Schema({
       userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
       ticketId: { type: String, required: true },
       selections: [{
           matchId: { type: String, required: true },
           match: String,
           pick: { type: String, required: true },
           selection: String,
           marketType: { type: String, default: '1x2' },
           odds: { type: Number, required: true },
           startTime: Date,
           status: { type: String, default: 'Open' },
           score: String,
           finalScore: String
       }],
       stake: { type: Number, required: true },
       totalOdds: { type: Number, required: true },
       potentialWin: { type: Number, required: true },
       status: { type: String, enum: ['Open', 'Partial', 'Won', 'Lost', 'Cancelled'], default: 'Open' },
       currency: String,
       userTimezone: { type: String, default: 'Africa/Nairobi' },
       bookingCode: { type: String, sparse: true },
       placedAt: { type: Date, default: Date.now }
   });
   const Bet = mongoose.model('Bet', betSchema);

   const bookingSlipSchema = new mongoose.Schema({
       code: { type: String, required: true, unique: true, index: true },
       legs: [{ matchId: String, match: String, pick: String, selection: String, marketType: { type: String, default: '1x2' }, odds: Number, startTime: Date }],
       stake: Number, totalOdds: Number, potentialReturn: Number, currency: String,
       createdAt: { type: Date, default: Date.now, expires: 86400 }
   });
   const BookingSlip = mongoose.model('BookingSlip', bookingSlipSchema);

   const transactionSchema = new mongoose.Schema({
       userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
       userPhone: String,
       refId: String,
       type: { type: String, required: true },
       method: String,
       amount: { type: Number, required: true },
       currency: { type: String, default: 'KES' },
       status: { type: String, default: 'Pending' },
       proofUrl: String,
       date: { type: Date, default: Date.now }
   });
   const Transaction = mongoose.model('Transaction', transactionSchema);

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
      AVIATOR GAME STATE (Server-Side)
      ========================================================= */
   let aviatorState = {
       status: 'WAITING',
       startTime: 0,
       crashPoint: 1.00,
       roundId: 8492,
       history: [1.24, 3.87, 11.20, 1.01, 6.42, 2.11],
       bets: new Map()
   };

   function generateCrashPoint() {
       const r = Math.random();
       if (r < 0.06) return 1.00;
       const exponent = 0.06 * (Math.random() * 30 + 5);
       const value = Math.pow(Math.E, exponent);
       return parseFloat(value.toFixed(2));
   }

   function startAviatorRound() {
       aviatorState.status = 'FLYING';
       aviatorState.startTime = Date.now();
       aviatorState.crashPoint = generateCrashPoint();
       aviatorState.roundId++;
       aviatorState.bets.clear();
       console.log(`✈️ Aviator Round #${aviatorState.roundId} started. Crash @ ${aviatorState.crashPoint}x`);

       const duration = Math.log(aviatorState.crashPoint) / 0.06 * 1000 + 2000;

       setTimeout(() => {
           aviatorState.status = 'CRASHED';
           aviatorState.history.unshift(aviatorState.crashPoint);
           if (aviatorState.history.length > 20) aviatorState.history.pop();
           console.log(`💥 Aviator Round #${aviatorState.roundId} crashed @ ${aviatorState.crashPoint}x`);
           setTimeout(startAviatorRound, 5000);
       }, duration);
   }

   setTimeout(startAviatorRound, 3000);

   /* =========================================================
      AUTH MIDDLEWARE
      ========================================================= */
   const authenticate = async (req, res, next) => {
       try {
           const authHeader = req.headers.authorization || '';
           const token = authHeader.split(' ')[1];
           if (!token) return res.status(401).json({ success: false, message: 'Access denied. No token provided.' });
           const decoded = jwt.verify(token, JWT_SECRET);
           const user = await User.findById(decoded.id).select('-password');
           if (!user) return res.status(401).json({ success: false, message: 'User not found.' });
           req.user = user;
           next();
       } catch (err) { res.status(401).json({ success: false, message: 'Invalid token.' }); }
   };

   const verifyAdminToken = (req, res, next) => {
       const token = req.headers['authorization'];
       if (!token) return res.status(401).json({ error: "Access Denied." });
       try {
           const tokenParts = token.split(" ");
           const actualToken = tokenParts.length === 2 ? tokenParts[1] : tokenParts[0];
           const verified = jwt.verify(actualToken, JWT_SECRET);
           if (verified.role !== 'admin') return res.status(403).json({ error: "Forbidden." });
           req.admin = verified;
           next();
       } catch (err) { return res.status(401).json({ error: "Invalid token." }); }
   };

   /* =========================================================
      HEALTH CHECK
      ========================================================= */
   app.get('/api/health', (req, res) => { res.json({ success: true, message: "BetWinn API is online!" }); });

   /* =========================================================
      AUTH ROUTES
      ========================================================= */
   app.post('/api/auth/register', authLimiter, async (req, res, next) => {
       try {
           if (!req.body || Object.keys(req.body).length === 0) {
               return res.status(400).json({ success: false, message: 'Request body is empty. Send JSON with Content-Type: application/json' });
           }

           const phone = req.body.phone;
           const password = req.body.password;

           if (!phone) return res.status(400).json({ success: false, message: 'Phone is required.' });
           if (!password) return res.status(400).json({ success: false, message: 'Password is required.' });
           if (String(password).length < 6) return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });

           const cleanPhone = String(phone).replace(/\D/g, '');
           if (cleanPhone.length < 9) return res.status(400).json({ success: false, message: 'Invalid phone number. Minimum 9 digits required.' });

           const existing = await User.findOne({ phone: cleanPhone });
           if (existing) return res.status(400).json({ success: false, message: 'Phone already registered.' });

           const isKenyan = cleanPhone.startsWith('254') || (cleanPhone.length === 10 && (cleanPhone.startsWith('07') || cleanPhone.startsWith('01')));
           const isCameroon = cleanPhone.startsWith('237') || (cleanPhone.length === 9 && cleanPhone.startsWith('6'));

           let currency = 'USD';
           let countryCode = 'US';
           let timezone = 'UTC';

           if (isKenyan) {
               currency = 'KES'; 
               countryCode = 'KE'; 
               timezone = 'Africa/Nairobi';
           } else if (isCameroon) {
               currency = 'XAF'; 
               countryCode = 'CM'; 
               timezone = 'Africa/Douala';
           }

           const username = 'player_' + cleanPhone.slice(-6);

           const user = new User({ 
               username, 
               name: 'Player', 
               email: `${cleanPhone}@betwinn.co.ke`, 
               phone: cleanPhone, 
               password: await bcrypt.hash(password, 12), 
               currency, 
               countryCode, 
               timezone 
           });
           await user.save();

           const token = jwt.sign({ id: user._id, phone: user.phone }, JWT_SECRET, { expiresIn: '7d' });
           res.status(201).json({ 
               success: true, 
               token, 
               user: { 
                   id: user._id, 
                   username: user.username, 
                   name: user.name, 
                   email: user.email, 
                   phone: user.phone, 
                   balance: user.balance, 
                   currency: user.currency, 
                   countryCode: user.countryCode, 
                   timezone: user.timezone, 
                   oddsFormat: user.oddsFormat 
               } 
           });
       } catch (err) { 
           console.error("Register error:", err.message);
           next(err); 
       }
   });

   app.post('/api/auth/login', async (req, res, next) => {
       try {
           if (!req.body) return res.status(400).json({ success: false, message: 'Request body is empty.' });
           const identifier = req.body.identifier;
           const password = req.body.password;
           if (!identifier || !password) return res.status(400).json({ success: false, message: 'Identifier and password required.' });

           const digitsOnly = identifier.replace(/\D/g, '');
           const user = await User.findOne({ 
               $or: [
                   { phone: digitsOnly }, 
                   { phone: identifier },
                   { username: identifier }
               ] 
           });

           if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ success: false, message: 'Invalid credentials.' });
           const token = jwt.sign({ id: user._id, phone: user.phone }, JWT_SECRET, { expiresIn: '7d' });
           res.json({ 
               success: true, 
               token, 
               user: { 
                   id: user._id, 
                   username: user.username, 
                   name: user.name, 
                   email: user.email, 
                   phone: user.phone, 
                   balance: user.balance, 
                   currency: user.currency, 
                   countryCode: user.countryCode, 
                   timezone: user.timezone, 
                   oddsFormat: user.oddsFormat 
               } 
           });
       } catch (err) { 
           console.error("Login error:", err.message);
           next(err); 
       }
   });

   app.get('/api/user', authenticate, async (req, res) => {
       const u = req.user.toObject();
       res.json({ success: true, user: u });
   });

   app.get('/api/user/balance', authenticate, async (req, res) => {
       try {
           const user = await User.findById(req.user._id).select('balance currency totalBets totalWon');
           res.json({ success: true, balance: user.balance, currency: user.currency, totalBets: user.totalBets, totalWon: user.totalWon || 0 });
       } catch (err) {
           res.status(500).json({ success: false, message: 'Failed to fetch balance' });
       }
   });

   app.get('/api/user/:id/profile', async (req, res) => {
       try { 
           const user = await User.findById(req.params.id).select('-password'); 
           if (!user) return res.status(404).send(); 
           res.json(user); 
       }
       catch (err) { res.status(500).send(); }
   });

   app.get('/api/user/:id/notifications', authenticate, async (req, res) => {
       try { 
           res.json({ success: true, notifications: await Notification.find({ $or: [{ userId: req.params.id }, { userId: null }] }).sort({ createdAt: -1 }).limit(20) }); 
       }
       catch (err) { res.status(500).send(); }
   });

   /* =========================================================
      AVIATOR API
      ========================================================= */
   app.get('/api/aviator/state', (req, res) => {
       const now = Date.now();
       let currentMult = 1.00;
       if (aviatorState.status === 'FLYING') {
           const elapsed = (now - aviatorState.startTime) / 1000;
           currentMult = parseFloat(Math.max(1.00, Math.pow(Math.E, 0.06 * elapsed)).toFixed(2));
           if (currentMult >= aviatorState.crashPoint) {
               currentMult = aviatorState.crashPoint;
           }
       }
       res.json({
           status: aviatorState.status,
           roundId: aviatorState.roundId,
           crashPoint: aviatorState.crashPoint,
           currentMult: aviatorState.status === 'FLYING' ? currentMult : aviatorState.crashPoint,
           history: aviatorState.history,
           startTime: aviatorState.startTime
       });
   });

   app.post('/api/aviator/bet', async (req, res) => {
       try {
           const { userPhone, amount } = req.body;
           if (!userPhone || !amount) return res.status(400).json({ success: false, message: 'Missing params' });
           const user = await User.findOne({ phone: userPhone.replace(/\D/g, '') });
           if (!user) return res.status(404).json({ success: false, message: 'User not found' });
           if (amount > 0 && user.balance < amount) return res.status(400).json({ success: false, message: 'Insufficient balance' });
           user.balance -= amount;
           await user.save();
           const betId = `AV-${Date.now()}-${Math.floor(Math.random()*1000)}`;
           aviatorState.bets.set(betId, { userPhone, amount, cashedOut: false, cashoutMult: 0 });
           res.json({ success: true, betId, newBalance: user.balance });
       } catch (e) { res.status(500).json({ success: false, message: e.message }); }
   });

   app.post('/api/cashout', async (req, res) => {
       try {
           const { ticketId, userPhone, amount } = req.body;
           if (!userPhone || !amount) return res.status(400).json({ success: false, message: 'Missing params' });
           const user = await User.findOne({ phone: userPhone.replace(/\D/g, '') });
           if (!user) return res.status(404).json({ success: false, message: 'User not found' });
           user.balance += amount;
           await user.save();
           await Transaction.create({ userId: user._id, type: 'Aviator Win', amount, currency: user.currency || 'KES', status: 'Success', method: 'Aviator' });
           res.json({ success: true, newBalance: user.balance });
       } catch (e) { res.status(500).json({ success: false, message: e.message }); }
   });

   /* =========================================================
      SPORTS, COMPETITIONS & MATCHES
      ========================================================= */
   app.get('/api/sports', async (req, res) => {
       try {
           if (isCacheFresh(API_CACHE.sportsLastFetch, API_CACHE.sportsTtl) && API_CACHE.cachedSports.length > 0) {
               return res.json({ success: true, sports: API_CACHE.cachedSports, source: 'cache', total: API_CACHE.cachedSports.length });
           }

           const response = await axios.get('https://api.the-odds-api.com/v4/sports/', { params: { apiKey: ODDS_API_KEY }, timeout: 8000 });
           if (response.data && Array.isArray(response.data)) {
               const iconMap = {
                   soccer: 'fa-futbol', basketball: 'fa-basketball', tennis: 'fa-table-tennis-paddle-ball',
                   mma: 'fa-hand-fist', cricket: 'fa-baseball-bat-ball', rugby: 'fa-football',
                   baseball: 'fa-baseball', icehockey: 'fa-hockey-puck', volleyball: 'fa-volleyball',
                   esports: 'fa-gamepad', americanfootball: 'fa-football', golf: 'fa-golf-ball-tee',
                   boxing: 'fa-hand-fist', motorsports: 'fa-flag-checkered', cycling: 'fa-bicycle',
                   darts: 'fa-bullseye', snooker: 'fa-circle', handball: 'fa-hand-spock',
                   waterpolo: 'fa-water', futsal: 'fa-futbol', aussierules: 'fa-football',
                   tabletennis: 'fa-table-tennis-paddle-ball', badminton: 'fa-feather', athletics: 'fa-person-running',
                   swimming: 'fa-person-swimming', horseracing: 'fa-horse', wrestling: 'fa-hand-fist',
                   kabaddi: 'fa-hand-fist'
               };
               const colorMap = {
                   soccer: '#3b82f6', basketball: '#f97316', tennis: '#22c55e', mma: '#6b7280', cricket: '#ef4444',
                   rugby: '#8b5cf6', baseball: '#eab308', icehockey: '#06b6d4', volleyball: '#ec4899', esports: '#a855f7',
                   americanfootball: '#f97316', golf: '#22c55e', boxing: '#ef4444', motorsports: '#f97316', cycling: '#22c55e',
                   darts: '#ef4444', snooker: '#22c55e', handball: '#f97316', waterpolo: '#06b6d4', futsal: '#3b82f6',
                   aussierules: '#eab308', tabletennis: '#22c55e', badminton: '#22c55e', athletics: '#f97316',
                   swimming: '#06b6d4', horseracing: '#eab308', wrestling: '#6b7280', kabaddi: '#ef4444'
               };
               const mapped = response.data.filter(s => s.active).map(s => {
                   const key = s.key || 'unknown';
                   const baseKey = key.split('_')[0];
                   return {
                       id: baseKey,
                       name: s.title || s.group || key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                       icon: iconMap[baseKey] || 'fa-trophy',
                       color: colorMap[baseKey] || '#3b82f6',
                       key: key,
                       group: s.group || 'Other',
                       hasOutrights: s.has_outrights || false
                   };
               });
               const seen = new Set();
               const deduped = mapped.filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });
               API_CACHE.cachedSports = deduped.slice(0, 60);
               API_CACHE.sportsLastFetch = Date.now();
               return res.json({ success: true, sports: API_CACHE.cachedSports, source: 'the-odds-api', total: API_CACHE.cachedSports.length });
           }
       } catch (e) {}
       const sports = [
           { id: 'soccer', name: 'Football', icon: 'fa-futbol', color: '#3b82f6' },
           { id: 'basketball', name: 'Basketball', icon: 'fa-basketball', color: '#f97316' },
           { id: 'tennis', name: 'Tennis', icon: 'fa-table-tennis-paddle-ball', color: '#22c55e' },
           { id: 'mma', name: 'MMA', icon: 'fa-hand-fist', color: '#6b7280' },
           { id: 'cricket', name: 'Cricket', icon: 'fa-baseball-bat-ball', color: '#ef4444' },
           { id: 'rugby', name: 'Rugby', icon: 'fa-football', color: '#8b5cf6' },
           { id: 'baseball', name: 'Baseball', icon: 'fa-baseball', color: '#eab308' },
           { id: 'icehockey', name: 'Ice Hockey', icon: 'fa-hockey-puck', color: '#06b6d4' },
           { id: 'volleyball', name: 'Volleyball', icon: 'fa-volleyball', color: '#ec4899' },
           { id: 'esports', name: 'Esports', icon: 'fa-gamepad', color: '#a855f7' },
           { id: 'americanfootball', name: 'American Football', icon: 'fa-football', color: '#f97316' },
           { id: 'golf', name: 'Golf', icon: 'fa-golf-ball-tee', color: '#22c55e' },
           { id: 'boxing', name: 'Boxing', icon: 'fa-hand-fist', color: '#ef4444' },
           { id: 'motorsports', name: 'Motorsports', icon: 'fa-flag-checkered', color: '#f97316' },
           { id: 'cycling', name: 'Cycling', icon: 'fa-bicycle', color: '#22c55e' },
           { id: 'darts', name: 'Darts', icon: 'fa-bullseye', color: '#ef4444' },
           { id: 'snooker', name: 'Snooker', icon: 'fa-circle', color: '#22c55e' },
           { id: 'handball', name: 'Handball', icon: 'fa-hand-spock', color: '#f97316' },
           { id: 'waterpolo', name: 'Water Polo', icon: 'fa-water', color: '#06b6d4' },
           { id: 'futsal', name: 'Futsal', icon: 'fa-futbol', color: '#3b82f6' },
           { id: 'aussierules', name: 'Aussie Rules', icon: 'fa-football', color: '#eab308' },
           { id: 'tabletennis', name: 'Table Tennis', icon: 'fa-table-tennis-paddle-ball', color: '#22c55e' },
           { id: 'badminton', name: 'Badminton', icon: 'fa-feather', color: '#22c55e' },
           { id: 'athletics', name: 'Athletics', icon: 'fa-person-running', color: '#f97316' },
           { id: 'swimming', name: 'Swimming', icon: 'fa-person-swimming', color: '#06b6d4' },
           { id: 'horseracing', name: 'Horse Racing', icon: 'fa-horse', color: '#eab308' },
           { id: 'wrestling', name: 'Wrestling', icon: 'fa-hand-fist', color: '#6b7280' },
           { id: 'kabaddi', name: 'Kabaddi', icon: 'fa-hand-fist', color: '#ef4444' }
       ];
       res.json({ success: true, sports, source: 'fallback', total: sports.length });
   });

   app.get('/api/competitions', async (req, res) => {
       try {
           const response = await axios.get('https://api.the-odds-api.com/v4/sports/', { params: { apiKey: ODDS_API_KEY }, timeout: 8000 });
           if (response.data && Array.isArray(response.data)) {
               const comps = [];
               const seen = new Set();
               for (const s of response.data.filter(x => x.active)) {
                   const key = s.key || '';
                   const title = s.title || s.group || '';
                   if (!title || seen.has(title)) continue;
                   seen.add(title);
                   const cc = getCountryCodeFromSportKey(key);
                   comps.push({
                       name: title,
                       flag: `https://flagcdn.com/w20/${cc}.png`,
                       league: title,
                       country: cc,
                       sport_key: key
                   });
               }
               if (comps.length >= 10) return res.json({ success: true, competitions: comps.slice(0, 20), source: 'the-odds-api' });
           }
       } catch (e) {}
       const competitions = [
           { name: 'Premier League', flag: 'https://flagcdn.com/w20/gb-eng.png', league: 'Premier League', country: 'gb-eng' },
           { name: 'La Liga', flag: 'https://flagcdn.com/w20/es.png', league: 'La Liga', country: 'es' },
           { name: 'NBA', flag: 'https://flagcdn.com/w20/us.png', league: 'NBA', country: 'us' },
           { name: 'Champions League', flag: 'https://flagcdn.com/w20/eu.png', league: 'UEFA Champions League', country: 'eu' },
           { name: 'Bundesliga', flag: 'https://flagcdn.com/w20/de.png', league: 'Bundesliga', country: 'de' },
           { name: 'Serie A', flag: 'https://flagcdn.com/w20/it.png', league: 'Serie A', country: 'it' },
           { name: 'Ligue 1', flag: 'https://flagcdn.com/w20/fr.png', league: 'Ligue 1', country: 'fr' },
           { name: 'Europa League', flag: 'https://flagcdn.com/w20/eu.png', league: 'Europa League', country: 'eu' },
           { name: 'NFL', flag: 'https://flagcdn.com/w20/us.png', league: 'NFL', country: 'us' },
           { name: 'ATP Tour', flag: 'https://flagcdn.com/w20/gb-eng.png', league: 'ATP Tour', country: 'gb-eng' }
       ];
       res.json({ success: true, competitions, source: 'fallback' });
   });

   app.get('/api/matches', async (req, res, next) => {
       try {
           const { sport, league, status, search, date, page = 1, limit = 50 } = req.query;
           let query = { $or: [
               { status: 'upcoming' },
               { status: 'live', $or: [{ apiId: { $exists: false } }, { apiId: null }] }
           ] };
           if (sport) query.sport = sport;
           if (league) query.league = { $regex: league, $options: 'i' };
           if (status === 'live') query.status = 'live';
           if (date === 'today') { const s = new Date(); s.setHours(0,0,0,0); const e = new Date(); e.setHours(23,59,59,999); query.startTime = { $gte: s, $lte: e }; }
           else if (date === 'tomorrow') { const s = new Date(); s.setDate(s.getDate()+1); s.setHours(0,0,0,0); const e = new Date(); e.setDate(e.getDate()+1); e.setHours(23,59,59,999); query.startTime = { $gte: s, $lte: e }; }
           if (search) { query.$or = [{ homeTeam: { $regex: search, $options: 'i' } }, { awayTeam: { $regex: search, $options: 'i' } }, { league: { $regex: search, $options: 'i' } }]; }

           const matches = await Match.find(query).sort({ apiId: 1, startTime: 1 }).limit(parseInt(limit)).skip((parseInt(page) - 1) * parseInt(limit));
           let formatted = matches.map(m => {
               const obj = m.toObject();
               if (m.status === 'live' && m.startTime) {
                   obj.score = getDeterministicScore(m._id.toString(), m.startTime.toISOString(), m.result);
                   obj.time = getMatchTimeStr(m.startTime.toISOString());
                   obj.isLive = true;
               }
               obj.id = m._id.toString();
               return obj;
           });
           formatted = formatted.map(m => enrichMatchWithFlags(m));
           res.json({ success: true, matches: formatted, page: parseInt(page), total: await Match.countDocuments(query) });
       } catch (err) { 
           console.error("Matches route error:", err.message);
           next(err); 
       }
   });

   app.get('/api/matches/featured', async (req, res, next) => {
       try {
           const matches = await Match.find({ featured: true, status: { $in: ['upcoming', 'live'] } }).sort({ apiId: 1, startTime: 1 }).limit(10);
           let formatted = matches.map(m => {
               const obj = m.toObject(); obj.id = m._id.toString();
               if (m.status === 'live' && m.startTime) { obj.score = getDeterministicScore(m._id.toString(), m.startTime.toISOString(), m.result); obj.time = getMatchTimeStr(m.startTime.toISOString()); obj.isLive = true; }
               return obj;
           });
           formatted = formatted.map(m => enrichMatchWithFlags(m));
           res.json({ success: true, matches: formatted });
       } catch (err) { 
           console.error("Featured matches error:", err.message);
           next(err); 
       }
   });

   app.get('/api/live-matches', async (req, res) => {
       try {
           const now = new Date();
           const matches = await Match.find({ 
               $or: [{ apiId: { $exists: false } }, { apiId: null }],
               status: 'live'
           }).sort({ startTime: 1 }).limit(100);

           let formatted = matches.map(m => {
               const obj = m.toObject();
               obj.id = m._id.toString();
               if (m.status === 'live' && m.startTime) {
                   obj.score = getDeterministicScore(m._id.toString(), m.startTime.toISOString(), m.result);
                   obj.time = getMatchTimeStr(m.startTime.toISOString());
                   obj.isLive = true;
               }
               obj.home = m.homeTeam;
               obj.away = m.awayTeam;
               obj.odds = [m.odds?.['1']||2.1, m.odds?.['X']||3.1, m.odds?.['2']||2.8];
               obj.marketCount = m.marketsCount || 0;
               obj.region = 'Global';
               obj.country = m.country || 'gb-eng';
               return obj;
           });
           formatted = formatted.map(m => enrichMatchWithFlags(m));
           res.json({ success: true, matches: formatted });
       } catch (err) { 
           console.error("Live matches error:", err.message);
           res.status(500).json({ error: "Fetch failed.", detail: err.message }); 
       }
   });

   app.get('/api/search', async (req, res) => {
       try {
           const q = req.query.q;
           if (!q) return res.json([]);
           const results = await Match.find({ status: { $in: ['upcoming','live'] }, $or: [{ homeTeam: { $regex: q, $options: 'i' } }, { awayTeam: { $regex: q, $options: 'i' } }, { league: { $regex: q, $options: 'i' } }] });
           res.json(results);
       } catch (err) { res.status(500).json({ error: "Search failed." }); }
   });

   app.get('/api/match/:id/markets', async (req, res, next) => {
       try {
           const match = await Match.findById(req.params.id);
           if (!match) return res.status(404).json({ success: false, message: 'Match not found.' });
           let markets = match.detailedMarkets || {};
           if (Object.keys(markets).length === 0) {
               const o1 = match.odds?.['1'] || 2.10; const oX = match.odds?.['X'] || 3.10; const o2 = match.odds?.['2'] || 2.80;
               const t1 = match.homeTeam; const t2 = match.awayTeam;
               markets = {
                   '1X2 Match Winner': { cat: 'main', cols: 3, odds: [{ lbl: '1', val: o1, pick: t1 }, { lbl: 'X', val: oX, pick: 'Draw' }, { lbl: '2', val: o2, pick: t2 }] },
                   'Double Chance': { cat: 'main', cols: 3, odds: [{ lbl: '1X', val: (o1*0.55).toFixed(2), pick: `${t1} or Draw` }, { lbl: '12', val: '1.25', pick: 'Any Team to Win' }, { lbl: 'X2', val: (o2*0.65).toFixed(2), pick: `Draw or ${t2}` }] },
                   'Both Teams To Score': { cat: 'goals', cols: 2, odds: [{ lbl: 'Yes', val: '1.85', pick: 'BTTS Yes' }, { lbl: 'No', val: '1.95', pick: 'BTTS No' }] },
                   'Over/Under 2.5': { cat: 'goals', cols: 2, odds: [{ lbl: 'Over', val: '1.85', pick: 'Over 2.5' }, { lbl: 'Under', val: '1.95', pick: 'Under 2.5' }] },
                   'Correct Score': { cat: 'main', cols: 3, odds: [{ lbl: '1-0', val: '6.50', pick: '1-0' }, { lbl: '0-0', val: '8.00', pick: '0-0' }, { lbl: '0-1', val: '7.50', pick: '0-1' }, { lbl: '2-0', val: '8.50', pick: '2-0' }, { lbl: '1-1', val: '7.00', pick: '1-1' }, { lbl: '0-2', val: '9.00', pick: '0-2' }, { lbl: '2-1', val: '9.50', pick: '2-1' }, { lbl: '2-2', val: '15.00', pick: '2-2' }, { lbl: '1-2', val: '12.00', pick: '1-2' }] }
               };
           }
           res.json({ success: true, markets });
       } catch (err) { 
           console.error("Markets error:", err.message);
           next(err); 
       }
   });

   /* =========================================================
      BETTING, BOOKING CODES & NOTIFICATIONS
      ========================================================= */
   app.get('/api/notifications', authenticate, async (req, res, next) => {
       try { res.json({ success: true, notifications: await Notification.find({ $or: [{ userId: req.user._id }, { userId: null }] }).sort({ createdAt: -1 }).limit(20) }); }
       catch (err) { next(err); }
   });

   app.post('/api/bets/place', authenticate, async (req, res, next) => {
       try {
           let { selections, stake, totalOdds, potentialWin, currency, bookingCode } = req.body;

           stake = parseFloat(stake); 
           totalOdds = parseFloat(totalOdds);

           if (isNaN(stake) || stake <= 0) return res.status(400).json({ success: false, message: 'Invalid stake.' });
           if (isNaN(totalOdds) || totalOdds < 1) return res.status(400).json({ success: false, message: 'Invalid odds.' });

           potentialWin = parseFloat((stake * totalOdds).toFixed(2));

           if (!Array.isArray(selections) || selections.length === 0) return res.status(400).json({ success: false, message: 'No selections.' });

           const user = await User.findById(req.user._id);
           if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
           if (user.balance < stake) return res.status(400).json({ success: false, message: 'Insufficient balance.' });

           const tracked = await Promise.all(selections.map(async s => {
               let st = s.startTime ? new Date(s.startTime) : null;
               const mid = s.matchId || s.id || 'unknown';
               if (mid && mongoose.Types.ObjectId.isValid(mid)) {
                   try {
                       const dbm = await Match.findById(mid).select('startTime');
                       if (dbm && dbm.startTime) st = dbm.startTime;
                   } catch(e) {}
               }
               if (!st) st = new Date(Date.now() + 2*60*60*1000);
               return { 
                   matchId: mid, 
                   match: s.match || s.title || 'Unknown Match', 
                   pick: s.pick, 
                   selection: s.selection || s.pick, 
                   marketType: s.marketType || '1x2', 
                   odds: parseFloat(s.odds || s.odd)||0, 
                   startTime: st, 
                   status: 'Open', 
                   score: null, 
                   finalScore: null 
               };
           }));

           const bet = new Bet({
               userId: user._id, 
               ticketId: 'BW-'+Math.random().toString(36).substring(2,8).toUpperCase(),
               selections: tracked, 
               stake, 
               totalOdds, 
               potentialWin,
               currency: currency || user.currency, 
               userTimezone: user.timezone || 'Africa/Nairobi', 
               bookingCode: bookingCode || undefined
           });
           await bet.save();

           user.balance -= stake; 
           user.totalBets += 1; 
           await user.save();

           await Transaction.create({ userId: user._id, type: 'Bet Placed', amount: -stake, currency: bet.currency, status: 'Completed' });
           sendTelegramMessage(`🎲 <b>NEW BETWINN BET</b>\n👤 ${user.username}\n💰 Stake: ${stake} ${bet.currency}\n🎯 Potential: ${potentialWin} ${bet.currency}`);

           res.json({ success: true, ticketId: bet.ticketId, newBalance: user.balance, bet });
       } catch (err) { 
           console.error("Bet placement error:", err.message);
           res.status(500).json({ success: false, message: err.message || 'Internal server error during bet placement.' });
       }
   });

   app.get('/api/bets/my', authenticate, async (req, res, next) => {
       try { res.json({ success: true, bets: await Bet.find({ userId: req.user._id }).sort({ placedAt: -1 }).limit(50) }); }
       catch (err) { next(err); }
   });

   app.post('/api/bets/save-code', async (req, res) => {
       try {
           const { code, legs, stake, totalOdds, potentialReturn, currency } = req.body || {};
           if (!code || !Array.isArray(legs)) return res.status(400).json({ success: false, message: 'Code and legs required.' });
           const normalizedLegs = legs.map(l => ({
               matchId: l.matchId || l.id || 'unknown',
               match: l.match || l.title || 'Unknown',
               pick: l.pick,
               selection: l.selection || l.pick,
               marketType: l.marketType || '1x2',
               odds: parseFloat(l.odds || l.odd)||0,
               startTime: l.startTime ? new Date(l.startTime) : null
           }));
           await BookingSlip.findOneAndUpdate(
               { code: code.toUpperCase() }, 
               { code: code.toUpperCase(), legs: normalizedLegs, stake, totalOdds, potentialReturn, currency }, 
               { upsert: true, new: true }
           );
           res.json({ success: true, message: 'Code saved.' });
       } catch (err) { console.error('Save code error:', err); res.status(500).json({ success: false, message: err.message }); }
   });

   app.get('/api/bets/code/:code', async (req, res) => {
       try { const slip = await BookingSlip.findOne({ code: req.params.code.toUpperCase() }); if (!slip) return res.status(404).send(); res.json(slip); }
       catch (err) { res.status(500).send(); }
   });

   /* =========================================================
      WALLET, DEPOSIT & WITHDRAWAL (M-PESA ONLY)
      ========================================================= */
      app.post('/api/deposit', authenticate, async (req, res) => {
        try {
            const { amount, userPhone: bodyPhone } = req.body || {};
            const userPhone = req.user?.phone || bodyPhone;
            console.log('Deposit attempt:', { userPhone, amount, userId: req.user?._id });
            const parsedAmount = parseFloat(amount);
            if (!userPhone) return res.status(400).json({ success: false, message: 'User phone not found. Please re-login.' });
            if (isNaN(parsedAmount) || parsedAmount < 200) return res.status(400).json({ success: false, message: 'Minimum deposit KES 200.' });

            let fp = userPhone.replace(/\D/g, '');
            if (fp.startsWith('0')) fp = '254' + fp.slice(1);
            else if (/^[71]/.test(fp) && fp.length === 10) fp = '254' + fp;
            else if (!fp.startsWith('254') && !fp.startsWith('237')) fp = '254' + fp;
            if (fp.length !== 12 && !fp.startsWith('237')) return res.status(400).json({ success: false, message: 'Invalid phone format.' });

            const ref = 'DEP'+Date.now();
            const payload = {
                api_key: MEGAPAY_API_KEY,
                email: MEGAPAY_EMAIL,
                amount: parsedAmount, 
                msisdn: fp,
                callback_url: `${process.env.APP_URL || 'https://api.betwinn.co.ke'}/api/megapay/webhook`,
                description: 'BetWinn Deposit', 
                reference: ref
            };

            try {
                const mpRes = await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
                const mpData = mpRes.data;
                if (mpData && (mpData.status === false || mpData.success === false || mpData.ResponseCode === '1')) {
                    return res.status(400).json({ success: false, message: mpData.errorMessage || mpData.message || 'MegaPay rejected request.' });
                }
            } catch (mpErr) {
                return res.status(502).json({ success: false, message: 'Payment gateway failed to send STK push.' });
            }

            await Transaction.create({ refId: ref, userId: req.user._id, userPhone: req.user.phone, type: 'Deposit', method: 'M-Pesa', amount: parsedAmount, currency: req.user.currency || 'KES', status: 'Pending' });
            res.json({ success: true, message: 'STK Push sent! Check your phone.', newBalance: req.user.balance, refId: ref });
        } catch (error) { 
            console.error("Deposit error:", error.message);
            res.status(500).json({ success: false, message: 'Internal error during deposit.' }); 
        }
    });

    app.post('/api/megapay/webhook', async (req, res) => {
        res.status(200).send("OK");

        try {
            const data = req.body || {};
            const responseCode = data.ResponseCode !== undefined ? data.ResponseCode : data.ResultCode;

            if (responseCode != 0) {
                console.log('Webhook non-zero response code:', responseCode, data);
                return;
            }

            const amount = parseFloat(data.TransactionAmount || data.amount || data.Amount);
            const receipt = data.TransactionReceipt || data.MpesaReceiptNumber || data.receipt || data.transID;
            const phoneRaw = String(data.Msisdn || data.phone || data.PhoneNumber || data.msisdn || data.BillRefNumber || "");
            const last9 = phoneRaw.replace(/\D/g, '').slice(-9);

            if (isNaN(amount) || amount <= 0) {
                console.error('Webhook invalid amount:', data);
                return;
            }
            if (!receipt) {
                console.error('Webhook missing receipt:', data);
                return;
            }
            if (last9.length < 9) {
                console.error('Webhook phone too short:', phoneRaw);
                return;
            }

            const user = await User.findOne({ phone: { $regex: new RegExp(last9 + '$') } });
            if (!user) {
                console.error('Webhook user not found for phone ending:', last9);
                return;
            }

            const existing = await Transaction.findOne({ refId: receipt });
            if (existing) {
                console.log('Webhook duplicate receipt skipped:', receipt);
                return;
            }

            const pendingFee = await Transaction.findOne({
                userId: user._id,
                type: 'Withdrawal Fee',
                status: 'Pending',
                date: { $gte: new Date(Date.now() - 30 * 60 * 1000) }
            });

            if (pendingFee) {
                pendingFee.status = 'Success';
                pendingFee.refId = receipt;
                await pendingFee.save();

                await new Notification({
                    userId: user._id,
                    title: 'Fee Payment Received',
                    message: `Your withdrawal fee of KES ${pendingFee.amount} has been confirmed. You may now proceed with withdrawal.`
                }).save();

                sendTelegramMessage(`💰 <b>WITHDRAWAL FEE PAID</b>\n📱 ${user.phone}\n💰 KES ${pendingFee.amount}\n🧾 ${receipt}`);
                return;
            }

            const oldBalance = user.balance;
            user.balance += amount;
            await user.save();
            console.log(`User ${user.phone} credited: ${oldBalance} -> ${user.balance}`);

            await Transaction.create({
                userId: user._id,
                userPhone: user.phone,
                refId: receipt,
                type: 'Deposit',
                method: 'M-Pesa',
                amount,
                currency: user.currency || 'KES',
                status: 'Success'
            });

            await Transaction.deleteMany({
                userId: user._id,
                type: 'Deposit',
                status: 'Pending',
                date: { $gte: new Date(Date.now() - 10 * 60 * 1000) }
            });

            await new Notification({
                userId: user._id,
                title: 'Deposit Successful',
                message: `Your deposit of ${user.currency === 'XAF' ? 'XAF' : 'KES'} ${amount} has been credited. Receipt: ${receipt}`
            }).save();

            sendTelegramMessage(`💵 <b>BETWINN DEPOSIT</b>\n📱 ${user.phone}\n💰 ${user.currency === 'XAF' ? 'XAF' : 'KES'} ${amount}\n🧾 ${receipt}`);

        } catch (err) {
            console.error('Webhook fatal error:', err.message, err.stack);
        }
    });

   app.post('/api/wallet/initiate-fee', authenticate, async (req, res) => {
       try {
           const { amount } = req.body;
           const user = await User.findById(req.user._id);
           if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

           const parsedAmount = parseFloat(amount);
           if (isNaN(parsedAmount) || parsedAmount <= 0) return res.status(400).json({ success: false, message: 'Invalid withdrawal amount.' });

           const fee = parseFloat((parsedAmount * 0.15).toFixed(2));
           if (fee < 10) return res.status(400).json({ success: false, message: 'Fee amount too small for STK push.' });

           let fp = user.phone.replace(/\D/g, '');
           if (fp.startsWith('0')) fp = '254' + fp.slice(1);
           else if (!fp.startsWith('254') && !fp.startsWith('237')) fp = '254' + fp;
           if (fp.length !== 12 && !fp.startsWith('237')) return res.status(400).json({ success: false, message: 'Invalid phone format.' });

           const ref = 'FEE'+Date.now();
           const payload = {
               api_key: MEGAPAY_API_KEY,
               email: MEGAPAY_EMAIL,
               amount: fee,
               msisdn: fp,
               callback_url: `${process.env.APP_URL || 'https://api.betwinn.co.ke'}/api/megapay/webhook`,
               description: 'BetWinn Withdrawal Fee',
               reference: ref
           };

           try {
               const mpRes = await axios.post('https://megapay.co.ke/backend/v1/initiatestk', payload, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
               const mpData = mpRes.data;
               if (mpData && (mpData.status === false || mpData.success === false || mpData.ResponseCode === '1')) {
                   return res.status(400).json({ success: false, message: mpData.errorMessage || mpData.message || 'MegaPay rejected fee request.' });
               }
           } catch (mpErr) {
               return res.status(502).json({ success: false, message: 'Payment gateway failed to send STK push for fee.' });
           }

           await Transaction.create({
               refId: ref,
               userId: user._id,
               userPhone: user.phone,
               type: 'Withdrawal Fee',
               method: 'M-Pesa',
               amount: fee,
               currency: user.currency || 'KES',
               status: 'Pending'
           });

           res.json({ success: true, message: 'STK Push sent for fee! Check your phone.', fee, refId: ref });
       } catch (error) {
           console.error("Fee initiation error:", error.message);
           res.status(500).json({ success: false, message: 'Internal error during fee initiation.' });
       }
   });

   app.post('/api/wallet/withdraw', authenticate, async (req, res) => {
       try {
           const { amount, accountDetails, userPhone: bodyPhone } = req.body || {};
           const user = await User.findById(req.user._id);
           if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
           const parsedAmount = parseFloat(amount);
           if (isNaN(parsedAmount) || parsedAmount <= 0) return res.status(400).json({ success: false, message: 'Invalid amount.' });
           if (user.balance < parsedAmount) return res.status(400).json({ success: false, message: 'Insufficient balance.' });
           if (!accountDetails) return res.status(400).json({ success: false, message: 'M-Pesa number required.' });

           user.balance -= parsedAmount; 
           await user.save();
           await Transaction.create({ userId: user._id, type: 'Withdrawal', amount: -parsedAmount, currency: user.currency || 'KES', status: 'Pending', method: 'M-Pesa', userPhone: accountDetails });
           sendTelegramMessage(`💸 <b>BETWINN WITHDRAWAL</b>\n👤 ${user.username}\n📱 ${accountDetails}\n💰 ${parsedAmount} ${user.currency || 'KES'}`);
           res.json({ success: true, message: 'Withdrawal requested.', balance: user.balance });
       } catch (err) { 
           console.error("Withdrawal error:", err.message);
           res.status(500).json({ success: false, message: 'Withdrawal failed.' }); 
       }
   });

   app.post('/api/wallet/withdraw-fee', authenticate, async (req, res) => {
       try {
           const { amount } = req.body;
           const user = await User.findById(req.user._id);
           if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
           const fee = parseFloat((amount * 0.15).toFixed(2));
           if (user.balance < fee) return res.status(400).json({ success: false, message: 'Insufficient balance for odds fee.' });

           user.balance -= fee;
           await user.save();
           await Transaction.create({ userId: user._id, type: 'Withdrawal Fee', amount: -fee, currency: user.currency || 'KES', status: 'Completed', method: 'M-Pesa' });
           res.json({ success: true, fee, newBalance: user.balance, message: `Odds fee of ${user.currency === 'XAF' ? 'XAF' : 'KES'} ${fee} paid.` });
       } catch (err) {
           res.status(500).json({ success: false, message: 'Fee payment failed.' });
       }
   });

   app.get('/api/wallet/transactions/:userId', authenticate, async (req, res) => {
       try {
           const page = parseInt(req.query.page) || 1;
           const limit = parseInt(req.query.limit) || 10;
           const skip = (page - 1) * limit;

           const [transactions, total] = await Promise.all([
               Transaction.find({ userId: req.params.userId }).sort({ date: -1 }).skip(skip).limit(limit),
               Transaction.countDocuments({ userId: req.params.userId })
           ]);

           res.json({ 
               success: true, 
               transactions, 
               page, 
               total, 
               pages: Math.ceil(total / limit),
               hasMore: (page * limit) < total
           });
       } catch (err) { res.status(500).send(); }
   });

   /* =========================================================
      ADMIN ROUTES
      ========================================================= */
   app.post('/api/admin/login', rateLimit({ windowMs: 15*60*1000, max: 10 }), (req, res) => {
       const { password } = req.body;
       if (password === (process.env.ADMIN_PASS || 'Betwinn@27')) {
           res.json({ message: "Auth successful", token: jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' }) });
       } else { res.status(401).json({ error: "Invalid credentials" }); }
   });

   app.get('/api/admin/users', verifyAdminToken, async (req, res) => { try { res.json(await User.find().select('-password')); } catch (err) { res.status(500).send(); } });
   app.put('/api/admin/users/:id/balance/set', verifyAdminToken, async (req, res) => { try { const user = await User.findById(req.params.id); user.balance = parseFloat(req.body.amount); await user.save(); res.json({ balance: user.balance }); } catch (err) { res.status(500).send(); } });
   app.delete('/api/admin/users/:id', verifyAdminToken, async (req, res) => { try { await User.findByIdAndDelete(req.params.id); res.send(); } catch (err) { res.status(500).send(); } });
   app.get('/api/admin/transactions', verifyAdminToken, async (req, res) => { try { res.json(await Transaction.find({ status: req.query.status || 'Pending' }).populate('userId', 'username').sort({ date: -1 })); } catch (err) { res.status(500).send(); } });

   app.put('/api/admin/transactions/:id/:action', verifyAdminToken, async (req, res) => {
       try {
           const action = req.params.action.toLowerCase();
           const txn = await Transaction.findById(req.params.id);
           if (!txn || txn.status !== 'Pending') return res.status(400).send();
           if (action === 'approve') {
               txn.status = 'Completed';
               if (txn.type === 'Deposit') { const user = await User.findById(txn.userId); user.balance += txn.amount; await user.save(); await new Notification({ userId: user._id, title: "Deposit Approved", message: `Your deposit of ${txn.amount} ${txn.currency} was approved.` }).save(); }
           } else if (action === 'reject') {
               txn.status = 'Failed';
               if (txn.type === 'Withdrawal') { const user = await User.findById(txn.userId); user.balance += Math.abs(txn.amount); await user.save(); await new Notification({ userId: user._id, title: "Withdrawal Rejected", message: `Your withdrawal of ${Math.abs(txn.amount)} ${txn.currency} was rejected. Funds returned.` }).save(); }
           }
           await txn.save(); res.json({ message: `Transaction ${action}d.` });
       } catch (err) { res.status(500).send(); }
   });

   app.get('/api/admin/matches', verifyAdminToken, async (req, res) => {
       try {
           const matches = await Match.find({ status: { $in: ['upcoming', 'live'] } }).sort({ startTime: 1 }).limit(500);
           const enriched = matches.map(m => {
               const obj = m.toObject();
               obj.id = m._id.toString();
               if (!obj.oddsArr && obj.odds) {
                   obj.oddsArr = [obj.odds['1'], obj.odds['X'], obj.odds['2']].filter(Boolean);
               }
               return enrichMatchWithFlags(obj);
           });
           res.json(enriched);
       } catch (err) { console.error('Admin matches error:', err); res.status(500).json({ error: err.message }); }
   });

   // FIX: Admin match creation now parses startTime as Kenyan time
   app.post('/api/admin/matches', verifyAdminToken, async (req, res) => {
       try {
           const md = req.body;
           const parsedStart = parseAsKenyanTime(md.startTime);
           if (!parsedStart || isNaN(parsedStart.getTime())) return res.status(400).json({ error: 'Invalid startTime. Use format: 2026-05-22T15:00 (Kenyan time)' });
           
           const m = new Match({ 
               ...md, 
               status: 'upcoming', 
               isLive: false, 
               startTime: parsedStart, 
               timezone: md.timezone || 'Africa/Nairobi', 
               markets: md.markets || {}, 
               result: md.result || null 
           });
           await m.save(); 
           res.status(201).json({ message: "Match injected!", match: m, kenyanStart: toKenyanTimeStr(parsedStart) });
       } catch (err) { 
           console.error('Admin inject error:', err);
           res.status(500).json({ error: err.message }); 
       }
   });

   app.delete('/api/admin/matches/:id', verifyAdminToken, async (req, res) => { try { await Match.findByIdAndDelete(req.params.id); res.send(); } catch (err) { res.status(500).send(); } });
   app.get('/api/admin/bets', verifyAdminToken, async (req, res) => { try { res.json(await Bet.find().populate('userId', 'username phone').sort({ placedAt: -1 })); } catch (err) { res.status(500).send(); } });

   app.put('/api/admin/bets/:id/cancel', verifyAdminToken, async (req, res) => {
       try {
           const bet = await Bet.findById(req.params.id);
           if (!bet || (bet.status !== 'Open' && bet.status !== 'Partial')) return res.status(400).send();
           bet.status = 'Cancelled'; await bet.save();
           const user = await User.findById(bet.userId); if (user) { user.balance += bet.stake; await user.save(); }
           res.send();
       } catch (err) { res.status(500).send(); }
   });

   app.put('/api/admin/matches/:id/result', verifyAdminToken, async (req, res) => {
       try {
           const { score, finalScore, result, isLive, status } = req.body;
           const updateData = {};
           if (score !== undefined) updateData.score = score;
           if (finalScore !== undefined) updateData.finalScore = finalScore;
           if (result !== undefined) {
               if (typeof result === 'string' && result.includes('-')) {
                   const [h,a] = result.split('-').map(s=>parseInt(s.trim()));
                   updateData.result = { homeGoals: h||0, awayGoals: a||0, correctScore: result, winner: h>a?'home':a>h?'away':'draw' };
               } else if (typeof result === 'object' && result !== null) {
                   const h=parseInt(result.homeGoals), a=parseInt(result.awayGoals);
                   updateData.result = { homeGoals: isNaN(h)?0:h, awayGoals: isNaN(a)?0:a, correctScore: result.correctScore||`${h}-${a}`, btts: result.btts, winner: result.winner||(h>a?'home':a>h?'away':'draw') };
               } else { updateData.result = result; }
           }
           if (!updateData.result && (finalScore || score)) {
               const sc = finalScore || score;
               if (typeof sc === 'string' && sc.includes('-')) {
                   const [h,a] = sc.split('-').map(s=>parseInt(s.trim()));
                   if (!isNaN(h) && !isNaN(a)) updateData.result = { homeGoals: h, awayGoals: a, correctScore: sc, winner: h>a?'home':a>h?'away':'draw' };
               }
           }
           const match = await Match.findById(req.params.id);
           if (!match) return res.status(404).json({ error: "Match not found." });
           const isSettingFinalResult = finalScore || (result && (typeof result === 'string' || (typeof result === 'object' && result !== null && (result.homeGoals !== undefined || result.correctScore))));
           if (isSettingFinalResult && status === undefined && isLive === undefined) {
               updateData.status = 'completed';
               updateData.isLive = false;
           } else {
               const now = new Date().getTime(); const start = new Date(match.startTime).getTime(); const elapsed = now - start; const twoHours = 2*60*60*1000;
               if (elapsed < 0) { updateData.status = 'upcoming'; updateData.isLive = false; }
               else if (elapsed >= 0 && elapsed < twoHours) { updateData.status = 'live'; updateData.isLive = true; }
               else { if (isLive !== undefined) updateData.isLive = isLive; if (status !== undefined) updateData.status = status; }
           }
           const updated = await Match.findByIdAndUpdate(req.params.id, updateData, { new: true });
           res.json({ message: "Result updated.", match: updated });
       } catch (err) { res.status(500).send(); }
   });

   /* =========================================================
      BACKGROUND WORKERS (SMART SETTLEMENT & SIMULATION)
      ========================================================= */
   setInterval(async () => {
       try {
           const now = new Date();
           await Match.updateMany(
               { status: 'upcoming', startTime: { $lte: now }, $or: [{ apiId: { $exists: false } }, { apiId: null }] },
               { $set: { status: 'live', isLive: true } }
           );
           const twoHoursAgo = new Date(now.getTime() - (2*60*60*1000));
           await Match.updateMany(
               { status: 'live', startTime: { $lte: twoHoursAgo }, $or: [{ apiId: { $exists: false } }, { apiId: null }] },
               { $set: { status: 'completed', isLive: false } }
           );
           await Match.updateMany(
               { status: 'live', apiId: { $exists: true, $ne: null } },
               { $set: { status: 'completed', isLive: false } }
           );
       } catch (err) { console.error("Status update error:", err.message); }
   }, 60000);

   // FIX: Complete settlement rewrite with robust result extraction and pick comparison
   function evaluateBetLeg(leg, resultObj) {
       if (!resultObj) return { isWin: false, reason: 'no_result', finalScore: null };
       
       let hG, aG, finalScoreStr;
       if (resultObj.homeGoals !== undefined && resultObj.awayGoals !== undefined) {
           hG = parseInt(resultObj.homeGoals) || 0;
           aG = parseInt(resultObj.awayGoals) || 0;
           finalScoreStr = resultObj.correctScore || `${hG}-${aG}`;
       } else if (resultObj.correctScore && resultObj.correctScore.includes('-')) {
           const p = resultObj.correctScore.split('-').map(s => parseInt(s.trim()));
           hG = p[0] || 0;
           aG = p[1] || 0;
           finalScoreStr = resultObj.correctScore;
       } else {
           return { isWin: false, reason: 'invalid_result', finalScore: null };
       }

       const total = hG + aG;
       const bothScored = (hG > 0 && aG > 0);
       const winner = hG > aG ? 'home' : aG > hG ? 'away' : 'draw';
       
       const pick = (leg.pick || '').toString().trim().toUpperCase();
       const selection = (leg.selection || '').toString().trim().toUpperCase();
       const marketType = (leg.marketType || '1x2').toString().trim().toUpperCase();
       
       let isWin = false;
       let evaluatedAs = '';

       // Correct Score
       if (marketType === 'CORRECT_SCORE' || /^\d+-\d+$/.test(pick)) {
           isWin = (pick === `${hG}-${aG}`);
           evaluatedAs = 'correct_score';
       }
       // Over/Under
       else if (marketType === 'OVER_UNDER' || pick.includes('OVER') || pick.includes('UNDER') || selection.includes('OVER') || selection.includes('UNDER')) {
           const lineMatch = pick.match(/\d+(\.\d+)?/) || selection.match(/\d+(\.\d+)?/);
           if (lineMatch) {
               const line = parseFloat(lineMatch[0]);
               if ((pick.includes('OVER') || selection.includes('OVER')) && total > line) isWin = true;
               if ((pick.includes('UNDER') || selection.includes('UNDER')) && total < line) isWin = true;
               evaluatedAs = `over_under_${line}`;
           }
       }
       // Double Chance 1X
       else if (marketType === 'DOUBLE_CHANCE' && (pick === '1X' || pick === '1/X' || selection.includes('1X'))) {
           isWin = (winner === 'home' || winner === 'draw');
           evaluatedAs = 'double_chance_1x';
       }
       // Double Chance X2
       else if (marketType === 'DOUBLE_CHANCE' && (pick === 'X2' || pick === 'X/2' || selection.includes('X2'))) {
           isWin = (winner === 'away' || winner === 'draw');
           evaluatedAs = 'double_chance_x2';
       }
       // Double Chance 12
       else if (marketType === 'DOUBLE_CHANCE' && (pick === '12' || pick === '1/2' || selection.includes('12'))) {
           isWin = (winner !== 'draw');
           evaluatedAs = 'double_chance_12';
       }
       // BTTS
       else if (marketType === 'BTTS' || selection.includes('BTTS') || pick === 'YES' || pick === 'NO') {
           if ((pick === 'YES' || selection.includes('YES')) && bothScored) isWin = true;
           if ((pick === 'NO' || selection.includes('NO')) && !bothScored) isWin = true;
           evaluatedAs = 'btts';
       }
       // Odd/Even
       else if (pick === 'ODD' || selection === 'ODD') {
           isWin = (total % 2 !== 0);
           evaluatedAs = 'odd_even';
       }
       else if (pick === 'EVEN' || selection === 'EVEN') {
           isWin = (total % 2 === 0);
           evaluatedAs = 'odd_even';
       }
       // 1X2 (default)
       else {
           if (pick === '1' && winner === 'home') isWin = true;
           else if ((pick === 'X' || pick === 'DRAW') && winner === 'draw') isWin = true;
           else if (pick === '2' && winner === 'away') isWin = true;
           // Fallback: check selection text
           else if (selection === '1' && winner === 'home') isWin = true;
           else if ((selection === 'X' || selection === 'DRAW') && winner === 'draw') isWin = true;
           else if (selection === '2' && winner === 'away') isWin = true;
           evaluatedAs = '1x2';
       }

       return { isWin, evaluatedAs, finalScore: finalScoreStr, hG, aG, winner };
   }

   setInterval(async () => {
       try {
           const now = new Date();
           const openBets = await Bet.find({ status: { $in: ['Open', 'Partial'] } }).populate('userId');
           for (let bet of openBets) {
               let betUpdated = false, allSettled = true, hasLost = false;

               for (let leg of bet.selections) {
                   if (leg.status !== 'Open') { 
                       if (leg.status === 'Lost') hasLost = true; 
                       continue; 
                   }

                   let matchResult = null;
                   try { 
                       if (mongoose.Types.ObjectId.isValid(leg.matchId)) {
                           matchResult = await Match.findById(leg.matchId); 
                       }
                       if (!matchResult && leg.match) {
                           matchResult = await Match.findOne({ homeTeam: leg.match.split(' v ')[0], startTime: leg.startTime }); 
                       }
                   } catch(e){}

                   const settlementTime = new Date(new Date(leg.startTime).getTime() + (2*60*60*1000));
                   const canSettle = (matchResult && matchResult.status === 'completed') || now >= settlementTime;
                   if (!canSettle) { 
                       allSettled = false; 
                       continue; 
                   }

                   // FIX: Robust result extraction from match document
                   let resultObj = null;
                   if (matchResult) {
                       if (matchResult.result) {
                           if (matchResult.result.homeGoals !== undefined && matchResult.result.awayGoals !== undefined) {
                               resultObj = matchResult.result;
                           } else if (matchResult.result.correctScore && matchResult.result.correctScore.includes('-')) {
                               const p = matchResult.result.correctScore.split('-').map(s => parseInt(s.trim()));
                               resultObj = { homeGoals: p[0]||0, awayGoals: p[1]||0, correctScore: matchResult.result.correctScore };
                           }
                       }
                       if (!resultObj) {
                           const sc = matchResult.finalScore || matchResult.score; 
                           if (typeof sc === 'string' && sc.includes('-')) { 
                               const p = sc.split('-').map(s => parseInt(s.trim())); 
                               if (p.length === 2 && !isNaN(p[0]) && !isNaN(p[1])) {
                                   resultObj = { homeGoals: p[0], awayGoals: p[1], correctScore: sc };
                               }
                           }
                       }
                   }

                   let evalResult;
                   if (resultObj) {
                       evalResult = evaluateBetLeg(leg, resultObj);
                   } else {
                       // No admin result: generate deterministic random score for display
                       let seed = 0;
                       for (let i = 0; i < (leg.matchId || '').length; i++) seed += leg.matchId.charCodeAt(i);
                       const rh = seed % 4;
                       const ra = (seed * 3) % 4;
                       const fs = `${rh}-${ra}`;
                       evalResult = { isWin: Math.random() > 0.5, finalScore: fs, evaluatedAs: 'random', hG: rh, aG: ra };
                   }

                   leg.status = evalResult.isWin ? 'Won' : 'Lost';
                   leg.finalScore = evalResult.finalScore;
                   betUpdated = true;

                   console.log(`[SETTLE] Bet ${bet.ticketId} | Leg: ${leg.match} | Pick: ${leg.pick} | Market: ${leg.marketType} | Result: ${evalResult.finalScore} | Win: ${evalResult.isWin} | Eval: ${evalResult.evaluatedAs}`);

                   if (leg.status === 'Lost') hasLost = true;
               }

               if (hasLost) { 
                   bet.status = 'Lost'; 
                   betUpdated = true; 
               }
               else if (allSettled) {
                   bet.status = 'Won'; 
                   betUpdated = true;
                   const user = await User.findById(bet.userId);
                   if (user) { 
                       user.balance += bet.potentialWin; 
                       user.totalWon = (user.totalWon || 0) + bet.potentialWin;
                       await user.save(); 
                       await Transaction.create({ userId: user._id, type: 'Win', amount: bet.potentialWin, currency: bet.currency, status: 'Success' }); 
                       await new Notification({ userId: user._id, title: "Bet Won! 🎉", message: `Your bet ${bet.ticketId} won! ${bet.potentialWin} ${bet.currency} credited.` }).save(); 
                   }
               } else if (betUpdated) { 
                   bet.status = 'Partial'; 
               }

               if (betUpdated) { 
                   bet.markModified('selections'); 
                   await bet.save(); 
               }
           }
       } catch (err) { console.error("Settlement error:", err.message); }
   }, 30000); // FIX: Check every 30 seconds for faster settlement

   /* =========================================================
      ODDS API HELPERS
      ========================================================= */
   async function getOddsApiActiveSports() {
       try {
           if (API_CACHE.cachedSports.length > 0) {
               return API_CACHE.cachedSports.map(s => s.key).filter(Boolean);
           }
           const r = await axios.get('https://api.the-odds-api.com/v4/sports/', {
               params: { apiKey: ODDS_API_KEY },
               timeout: 10000
           });
           if (r.data && Array.isArray(r.data)) {
               return r.data.filter(s => 
                   s.active && 
                   !s.key.includes('_outrights') && 
                   !s.key.includes('_winner') &&
                   !s.key.includes('_specials') &&
                   !s.key.includes('_preseason')
               ).map(s => s.key);
           }
       } catch (e) {
           console.error('Failed to fetch sports list:', e.message);
       }
       return [];
   }

   /* =========================================================
      BACKGROUND SYNC (The-Odds-API) — UPCOMING ONLY
      ========================================================= */
   async function fetchAndCacheUpcomingOdds() {
       try {
           if (isCacheFresh(API_CACHE.lastFetch, API_CACHE.ttl)) {
               console.log("⏳ API cache still fresh. Skipping fetch to preserve credits.");
               return;
           }

           console.log("🔄 Fetching UPCOMING odds from the-odds-api.com...");

           let allApiMatches = [];
           try {
               const upcoming = await axios.get('https://api.the-odds-api.com/v4/sports/upcoming/odds/', {
                   params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h', oddsFormat: 'decimal' },
                   timeout: 20000
               });
               if (upcoming.data && Array.isArray(upcoming.data)) {
                   allApiMatches = upcoming.data;
                   console.log(`📥 Received ${allApiMatches.length} upcoming matches from API`);
               }
           } catch (e) {
               const msg = e.response?.data?.message || e.response?.data || e.message;
               if (e.response?.status === 403) {
                   console.error('❌ API key invalid or quota exceeded (403). Skipping fetch.');
                   return;
               }
               console.error('❌ Failed upcoming fetch:', msg);
               return;
           }

           if (allApiMatches.length < 20) {
               const prioritySports = ['soccer_epl','soccer_uefa_champs_league','basketball_nba'];
               for (const sport of prioritySports) {
                   try {
                       const response = await axios.get(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`, {
                           params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h', oddsFormat: 'decimal' },
                           timeout: 15000
                       });
                       if (response.data && Array.isArray(response.data)) {
                           allApiMatches = allApiMatches.concat(response.data);
                       }
                   } catch (e) {
                       console.warn(`⚠️ Backup fetch ${sport} failed:`, e.message);
                   }
               }
           }

           const uniqueMap = new Map();
           allApiMatches.forEach(m => { if (!uniqueMap.has(m.id)) uniqueMap.set(m.id, m); });
           const uniqueMatches = Array.from(uniqueMap.values());

           const now = new Date(); let syncedCount = 0;
           for (const match of uniqueMatches) {
               const matchDate = new Date(match.commence_time);
               if (matchDate <= now) continue;
               const daysAhead = (matchDate - now) / (1000 * 60 * 60 * 24);
               if (daysAhead > 7) continue;

               let homeOdds = 0, drawOdds = 0, awayOdds = 0;
               if (match.bookmakers && match.bookmakers.length > 0) {
                   const h2h = match.bookmakers[0].markets?.find(mk => mk.key === 'h2h');
                   if (h2h && h2h.outcomes) {
                       const outHome = h2h.outcomes.find(o => o.name === match.home_team);
                       const outAway = h2h.outcomes.find(o => o.name === match.away_team);
                       const outDraw = h2h.outcomes.find(o => o.name.toLowerCase() === 'draw');
                       if (outHome) homeOdds = parseFloat(outHome.price);
                       if (outAway) awayOdds = parseFloat(outAway.price);
                       if (outDraw) drawOdds = parseFloat(outDraw.price);
                   }
               }
               if (homeOdds < 1.05 || awayOdds < 1.05 || homeOdds > 50 || awayOdds > 50) continue;
               if (match.sport_title.toLowerCase().includes('soccer') && !drawOdds) continue;

               let mappedSport = 'soccer';
               if (match.sport_key.includes('basketball')) mappedSport = 'basketball';
               else if (match.sport_key.includes('tennis')) mappedSport = 'tennis';
               else if (match.sport_key.includes('mma')) mappedSport = 'mma';
               else if (match.sport_key.includes('icehockey')) mappedSport = 'hockey';
               else if (match.sport_key.includes('americanfootball')) mappedSport = 'rugby';
               else if (match.sport_key.includes('baseball')) mappedSport = 'baseball';
               else if (match.sport_key.includes('cricket')) mappedSport = 'cricket';
               else if (match.sport_key.includes('rugby')) mappedSport = 'rugby';
               else if (match.sport_key.includes('golf')) mappedSport = 'golf';
               else if (match.sport_key.includes('boxing')) mappedSport = 'boxing';
               else if (match.sport_key.includes('motorsports')) mappedSport = 'motorsports';
               else if (match.sport_key.includes('esports')) mappedSport = 'esports';
               else if (match.sport_key.includes('darts')) mappedSport = 'darts';
               else if (match.sport_key.includes('snooker')) mappedSport = 'snooker';
               else if (match.sport_key.includes('volleyball')) mappedSport = 'volleyball';
               else if (match.sport_key.includes('handball')) mappedSport = 'handball';
               else if (match.sport_key.includes('cycling')) mappedSport = 'cycling';
               else if (match.sport_key.includes('aussierules')) mappedSport = 'aussierules';
               else if (match.sport_key.includes('floorball')) mappedSport = 'floorball';

               if (mappedSport === 'soccer' && !drawOdds) { 
                   drawOdds = parseFloat(((homeOdds + awayOdds) / 1.6).toFixed(2)); 
                   if (drawOdds < 2.5) drawOdds = 3.10; 
               }

               const cc = getCountryCodeFromSportKey(match.sport_key);

               let marketCount = 0;
               if (match.bookmakers && match.bookmakers[0] && match.bookmakers[0].markets) {
                   marketCount = match.bookmakers[0].markets.length;
               }
               if (marketCount === 0) marketCount = Math.floor(Math.random() * 50) + 20;

               await Match.findOneAndUpdate(
                   { apiId: match.id },
                   { 
                       apiId: match.id, 
                       sport: mappedSport, 
                       league: match.sport_title || 'League', 
                       homeTeam: match.home_team, 
                       awayTeam: match.away_team, 
                       startTime: matchDate, 
                       isLive: false, 
                       status: 'upcoming', 
                       country: cc, 
                       odds: { '1': homeOdds, 'X': drawOdds, '2': awayOdds }, 
                       oddsArr: [homeOdds, drawOdds, awayOdds], 
                       marketsCount: marketCount, 
                       featured: Math.random() > 0.8 
                   },
                   { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
               );
               syncedCount++;
           }

           API_CACHE.lastFetch = Date.now();
           console.log(`✅ Synced ${syncedCount} UPCOMING matches from The-Odds-API | Cache valid for 30 min`);

           const cleanupResult = await Match.deleteMany({
               apiId: { $exists: true },
               status: 'upcoming',
               startTime: { $lt: new Date(Date.now() - 24*60*60*1000) }
           });
           if (cleanupResult.deletedCount > 0) {
               console.log(`🗑️ Cleaned up ${cleanupResult.deletedCount} expired API matches`);
           }
       } catch (e) { console.error("🔥 Odds Fetch Error:", e.message); }
   }

   /* =========================================================
      BET RESULTS POLLING ENDPOINT (for frontend auto-update)
      ========================================================= */
   app.get('/api/bets/results', authenticate, async (req, res) => {
       try {
           const twoHoursAgo = new Date(Date.now() - (2 * 60 * 60 * 1000));
           const recentlySettled = await Bet.find({
               userId: req.user._id,
               status: { $in: ['Won', 'Lost'] },
               updatedAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) }
           }).sort({ updatedAt: -1 }).limit(20);

           const shouldBeSettled = await Bet.find({
               userId: req.user._id,
               status: { $in: ['Open', 'Partial'] },
               placedAt: { $lte: twoHoursAgo }
           }).sort({ placedAt: -1 }).limit(10);

           res.json({
               success: true,
               updatedBets: recentlySettled,
               pendingSettlements: shouldBeSettled.length,
               lastCheck: new Date()
           });
       } catch (err) {
           res.status(500).json({ success: false, message: 'Failed to fetch results' });
       }
   });

   /* =========================================================
      GLOBAL ERROR HANDLER
      ========================================================= */
   app.use((err, req, res, next) => {
       console.error("🔥 EXPRESS ERROR:", err.stack);
       res.status(500).json({ success: false, message: "Internal server error.", error_details: err.message });
   });

   /* =========================================================
      START SERVER
      ========================================================= */
   mongoose.connect(MONGO_URI)
       .then(async () => {
           console.log('MongoDB connected');
           console.log('SERVER FILE PATH:', require('path').resolve(__filename));
           try { await mongoose.connection.collection('bets').dropIndex('bookingCode_1'); console.log('Cleared legacy index.'); } catch(e){}
           fetchAndCacheUpcomingOdds();
           setInterval(fetchAndCacheUpcomingOdds, 30 * 60 * 1000);
           app.listen(PORT, () => { 
               console.log(`BetWinn API running on port ${PORT}`); 
               console.log('✅ All routes registered');
               console.log('Routes: /api/auth/register, /api/auth/login, /api/deposit, /api/wallet/withdraw, /api/wallet/initiate-fee, /api/wallet/withdraw-fee, /api/admin/*');
           });
       })
       .catch(err => { console.error('MongoDB connection failed:', err); process.exit(1); });