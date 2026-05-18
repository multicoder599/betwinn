/* =========================================================
   BETWINN SERVER.JS (Merged with SportyWins Production Logic)
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
   const API_URL = process.env.NODE_ENV === 'production' ? 'https://api.betwinn.co.ke/api' : `http://localhost:${PORT}/api`;
   const PARLAY_API_KEY = process.env.PARLAY_API_KEY || '627778f98df49b4c7d459b1760997abd';
   const ODDS_API_KEY = process.env.ODDS_API_KEY || '581547add320d504f22fd7454a1140df';
   
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
   
   const getCryptoAddresses = () => ({
       Bitcoin: process.env.BTC_ADDRESS || 'bc1q_configure_in_env',
       USDT: process.env.USDT_ADDRESS || '0x_configure_in_env',
       USDC: process.env.USDC_ADDRESS || '0x_configure_in_env',
       Solana: process.env.SOLANA_ADDRESS || 'sol_configure_in_env',
       Litecoin: process.env.LTC_ADDRESS || 'ltc_configure_in_env'
   });
   
   const getTimezoneFromCountry = (countryCode, phone = '') => {
       const map = { KE: 'Africa/Nairobi', UG: 'Africa/Kampala', TZ: 'Africa/Dar_es_Salaam', NG: 'Africa/Lagos', ZA: 'Africa/Johannesburg', GH: 'Africa/Accra', GB: 'Europe/London', US: 'America/New_York', CA: 'America/Toronto', AU: 'Australia/Sydney', IN: 'Asia/Kolkata', DE: 'Europe/Berlin', FR: 'Europe/Paris', ES: 'Europe/Madrid', IT: 'Europe/Rome', BR: 'America/Sao_Paulo', MX: 'America/Mexico_City', AE: 'Asia/Dubai' };
       const p = String(phone).replace(/\D/g, '');
       if (p.startsWith('254')) return 'Africa/Nairobi';
       if (p.startsWith('255')) return 'Africa/Dar_es_Salaam';
       if (p.startsWith('256')) return 'Africa/Kampala';
       if (p.startsWith('234')) return 'Africa/Lagos';
       if (p.startsWith('27'))  return 'Africa/Johannesburg';
       if (p.startsWith('233')) return 'Africa/Accra';
       if (p.startsWith('44'))  return 'Europe/London';
       if (p.startsWith('1'))   return 'America/New_York';
       return map[countryCode] || 'UTC';
   };
   
   function getMatchTimeStr(startTimeStr) {
       if (!startTimeStr) return "";
       const elapsedMs = new Date().getTime() - new Date(startTimeStr).getTime();
       const elapsedMins = Math.floor(elapsedMs / 60000);
       if (elapsedMins < 0) return "Upcoming";
       if (elapsedMins <= 45) return `${elapsedMins}'`;
       if (elapsedMins > 45 && elapsedMins <= 50) return `45+${elapsedMins - 45}'`;
       if (elapsedMins > 50 && elapsedMins <= 65) return "HT";
       if (elapsedMins > 65 && elapsedMins <= 110) return `${45 + (elapsedMins - 65)}'`;
       if (elapsedMins > 110 && elapsedMins <= 116) return `90+${elapsedMins - 110}'`;
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
       username: { type: String, required: true, unique: true },
       name: { type: String, default: 'Player' },
       email: { type: String, required: true, unique: true, lowercase: true },
       phone: { type: String, required: true, unique: true },
       password: { type: String, required: true },
       balance: { type: Number, default: 0 },
       totalBets: { type: Number, default: 0 },
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
       marketsCount: { type: Number, default: 99 },
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
           const { username, name, email, phone, password } = req.body;
           if (!username || !phone || !password) return res.status(400).json({ success: false, message: 'Missing required fields.' });
           if (await User.findOne({ username: { $regex: new RegExp('^' + username + '$', 'i') } })) return res.status(400).json({ success: false, message: 'Username taken.' });
           if (await User.findOne({ email: { $regex: new RegExp('^' + (email || '') + '$', 'i') } })) return res.status(400).json({ success: false, message: 'Email registered.' });
           if (await User.findOne({ phone })) return res.status(400).json({ success: false, message: 'Phone registered.' });
   
           const cleanPhone = phone.replace(/\D/g, '');
           const isKenyan = phone.startsWith('+254') || cleanPhone.startsWith('254') || (cleanPhone.length === 10 && (cleanPhone.startsWith('07') || cleanPhone.startsWith('01')));
           const currency = isKenyan ? 'KES' : 'USD';
           const countryCode = isKenyan ? 'KE' : 'US';
           const timezone = getTimezoneFromCountry(countryCode, phone);
   
           const user = new User({ username, name: name || username, email: email || `${phone}@betwinn.co.ke`, phone, password: await bcrypt.hash(password, 12), currency, countryCode, timezone });
           await user.save();
   
           await new Notification({ userId: user._id, title: "Welcome to BetWinn!", message: "Your account is ready. Start winning today!" }).save();
           sendTelegramMessage(`🎉 <b>NEW BETWINN USER</b>\n👤 ${username}\n📞 ${phone}\n💰 Currency: ${currency}`);
   
           const token = jwt.sign({ id: user._id, phone: user.phone }, JWT_SECRET, { expiresIn: '7d' });
           res.status(201).json({ success: true, token, user: { id: user._id, username: user.username, name: user.name, email: user.email, phone: user.phone, balance: user.balance, currency: user.currency, countryCode: user.countryCode, timezone: user.timezone, oddsFormat: user.oddsFormat, cryptoAddresses: getCryptoAddresses() } });
       } catch (err) { next(err); }
   });
   
   app.post('/api/auth/login', async (req, res, next) => {
       try {
           const { identifier, password } = req.body;
           if (!identifier || !password) return res.status(400).json({ success: false, message: 'Identifier and password required.' });
           const digitsOnly = identifier.replace(/\D/g, '');
           const phoneQuery = digitsOnly.length >= 9 ? { $regex: new RegExp(digitsOnly.slice(-9) + '$') } : identifier;
           const user = await User.findOne({ $or: [{ email: { $regex: new RegExp('^' + identifier + '$', 'i') } }, { username: { $regex: new RegExp('^' + identifier + '$', 'i') } }, { phone: phoneQuery }, { phone: identifier }] });
           if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ success: false, message: 'Invalid credentials.' });
           const token = jwt.sign({ id: user._id, phone: user.phone }, JWT_SECRET, { expiresIn: '7d' });
           res.json({ success: true, token, user: { id: user._id, username: user.username, name: user.name, email: user.email, phone: user.phone, balance: user.balance, currency: user.currency, countryCode: user.countryCode, timezone: user.timezone, oddsFormat: user.oddsFormat, cryptoAddresses: getCryptoAddresses() } });
       } catch (err) { next(err); }
   });
   
   app.get('/api/user', authenticate, async (req, res) => {
       const u = req.user.toObject();
       u.cryptoAddresses = getCryptoAddresses();
       res.json({ success: true, user: u });
   });
   
   app.get('/api/user/:id/profile', async (req, res) => {
       try { const user = await User.findById(req.params.id).select('-password'); if (!user) return res.status(404).send(); const u = user.toObject(); u.cryptoAddresses = getCryptoAddresses(); res.json(u); }
       catch (err) { res.status(500).send(); }
   });
   
   app.get('/api/user/:id/notifications', authenticate, async (req, res) => {
       try { res.json({ success: true, notifications: await Notification.find({ $or: [{ userId: req.params.id }, { userId: null }] }).sort({ createdAt: -1 }).limit(20) }); }
       catch (err) { res.status(500).send(); }
   });
   
   /* =========================================================
      SPORTS, COMPETITIONS & MATCHES
      ========================================================= */
   app.get('/api/sports', async (req, res) => {
       const sports = [
           { id: 'soccer', name: 'Football', icon: 'fa-futbol', color: '#3b82f6' },
           { id: 'basketball', name: 'Basketball', icon: 'fa-basketball', color: '#f97316' },
           { id: 'tennis', name: 'Tennis', icon: 'fa-table-tennis-paddle-ball', color: '#22c55e' },
           { id: 'mma', name: 'MMA', icon: 'fa-hand-fist', color: '#6b7280' },
           { id: 'cricket', name: 'Cricket', icon: 'fa-baseball-bat-ball', color: '#ef4444' },
           { id: 'rugby', name: 'Rugby', icon: 'fa-football', color: '#8b5cf6' },
           { id: 'baseball', name: 'Baseball', icon: 'fa-baseball', color: '#eab308' },
           { id: 'hockey', name: 'Ice Hockey', icon: 'fa-hockey-puck', color: '#06b6d4' },
           { id: 'volleyball', name: 'Volleyball', icon: 'fa-volleyball', color: '#ec4899' },
           { id: 'esports', name: 'Esports', icon: 'fa-gamepad', color: '#a855f7' }
       ];
       res.json({ success: true, sports });
   });
   
   app.get('/api/competitions', async (req, res) => {
       const competitions = [
           { name: 'Premier League', flag: 'https://flagcdn.com/w20/gb-eng.png', league: 'Premier League', country: 'gb-eng' },
           { name: 'La Liga', flag: 'https://flagcdn.com/w20/es.png', league: 'La Liga', country: 'es' },
           { name: 'NBA', flag: 'https://flagcdn.com/w20/us.png', league: 'NBA', country: 'us' },
           { name: 'Champions League', flag: '🏆', league: 'UEFA Champions League', country: 'gb-eng', special: true },
           { name: 'Bundesliga', flag: 'https://flagcdn.com/w20/de.png', league: 'Bundesliga', country: 'de' },
           { name: 'Serie A', flag: 'https://flagcdn.com/w20/it.png', league: 'Serie A', country: 'it' },
           { name: 'Ligue 1', flag: 'https://flagcdn.com/w20/fr.png', league: 'Ligue 1', country: 'fr' },
           { name: 'Europa League', flag: 'https://flagcdn.com/w20/eu.png', league: 'Europa League', country: 'eu' },
           { name: 'NFL', flag: 'https://flagcdn.com/w20/us.png', league: 'NFL', country: 'us' },
           { name: 'ATP Tour', flag: '🎾', league: 'ATP Tour', country: 'gb-eng' }
       ];
       res.json({ success: true, competitions });
   });
   
   app.get('/api/matches', async (req, res, next) => {
       try {
           const { sport, league, status, search, date, page = 1, limit = 50 } = req.query;
           let query = { status: { $in: ['upcoming', 'live'] } };
           if (sport) query.sport = sport;
           if (league) query.league = { $regex: league, $options: 'i' };
           if (status === 'live') query.status = 'live';
           if (date === 'today') { const s = new Date(); s.setHours(0,0,0,0); const e = new Date(); e.setHours(23,59,59,999); query.startTime = { $gte: s, $lte: e }; }
           else if (date === 'tomorrow') { const s = new Date(); s.setDate(s.getDate()+1); s.setHours(0,0,0,0); const e = new Date(); e.setDate(e.getDate()+1); e.setHours(23,59,59,999); query.startTime = { $gte: s, $lte: e }; }
           if (search) { query.$or = [{ homeTeam: { $regex: search, $options: 'i' } }, { awayTeam: { $regex: search, $options: 'i' } }, { league: { $regex: search, $options: 'i' } }]; }
   
           const matches = await Match.find(query).sort({ startTime: 1 }).limit(parseInt(limit)).skip((parseInt(page) - 1) * parseInt(limit));
           const formatted = matches.map(m => {
               const obj = m.toObject();
               if (m.status === 'live' && m.startTime) {
                   obj.score = getDeterministicScore(m._id.toString(), m.startTime.toISOString(), m.result);
                   obj.time = getMatchTimeStr(m.startTime.toISOString());
                   obj.isLive = true;
               }
               obj.id = m._id.toString();
               return obj;
           });
           res.json({ success: true, matches: formatted, page: parseInt(page), total: await Match.countDocuments(query) });
       } catch (err) { next(err); }
   });
   
   app.get('/api/matches/featured', async (req, res, next) => {
       try {
           const matches = await Match.find({ featured: true, status: { $in: ['upcoming', 'live'] } }).limit(10).sort({ startTime: 1 });
           const formatted = matches.map(m => {
               const obj = m.toObject(); obj.id = m._id.toString();
               if (m.status === 'live' && m.startTime) { obj.score = getDeterministicScore(m._id.toString(), m.startTime.toISOString(), m.result); obj.time = getMatchTimeStr(m.startTime.toISOString()); obj.isLive = true; }
               return obj;
           });
           res.json({ success: true, matches: formatted });
       } catch (err) { next(err); }
   });
   
   app.get('/api/live-matches', async (req, res) => {
       try {
           const now = new Date();
           let dbMatches = (await Match.find({ status: { $in: ['upcoming', 'live'] } }).sort({ startTime: 1 })).map(m => {
               const obj = m.toObject(); obj.id = m._id.toString();
               if (m.status === 'live' && m.startTime) { obj.score = getDeterministicScore(m._id.toString(), m.startTime.toISOString(), m.result); obj.time = getMatchTimeStr(m.startTime.toISOString()); obj.isLive = true; }
               obj.home = m.homeTeam; obj.away = m.awayTeam; obj.odds = [m.odds?.['1']||2.1, m.odds?.['X']||3.1, m.odds?.['2']||2.8];
               obj.marketCount = m.marketsCount || 50; obj.region = 'Global'; obj.country = m.country || 'gb-eng';
               return obj;
           });
   
           const tomorrow = new Date(); tomorrow.setDate(now.getDate()+1); tomorrow.setHours(0,0,0,0);
           const nextWeek = new Date(); nextWeek.setDate(now.getDate()+7);
           const fromDate = tomorrow.toISOString().split('.')[0]+'Z';
           const toDate = nextWeek.toISOString().split('.')[0]+'Z';
   
           const sportsToFetch = ['soccer_epl','soccer_uefa_champs_league','soccer_italy_serie_a','soccer_spain_la_liga','soccer_germany_bundesliga','soccer_france_ligue_one','basketball_nba','tennis_atp','icehockey_nhl','mma_mixed_martial_arts','americanfootball_nfl','baseball_mlb'];
           let allApi = [];
           await Promise.all(sportsToFetch.map(async (sk) => {
               try {
                   const r = await axios.get(`https://parlay-api.com/v1/sports/${sk}/odds?apiKey=${ODDS_API_KEY}&regions=uk,eu,us&markets=h2h&commenceTimeFrom=${fromDate}&commenceTimeTo=${toDate}`, { timeout: 8000 });
                   if (r.data) allApi = allApi.concat(r.data);
               } catch(e){}
           }));
   
           let apiMatches = allApi.map(m => {
               let md = new Date(m.commence_time);
               if (now.getTime() - md.getTime() >= 0) return null;
               const mk = m.bookmakers[0]?.markets[0];
               let h = 2.10, d = null, a = 2.80;
               if (mk && mk.outcomes) {
                   const ho = mk.outcomes.find(o => o.name === m.home_team);
                   const ao = mk.outcomes.find(o => o.name === m.away_team);
                   const dr = mk.outcomes.find(o => o.name === 'Draw' || (o.name !== m.home_team && o.name !== m.away_team));
                   if (ho) h = ho.price; if (ao) a = ao.price; if (dr) d = dr.price;
               }
               let sp = 'soccer';
               if (m.sport_key.includes('basketball')) sp = 'basketball';
               if (m.sport_key.includes('tennis')) sp = 'tennis';
               if (m.sport_key.includes('mma')) sp = 'mma';
               if (m.sport_key.includes('icehockey')) sp = 'hockey';
               if (m.sport_key.includes('americanfootball')) sp = 'rugby';
               if (m.sport_key.includes('baseball')) sp = 'baseball';
               if (sp === 'soccer' && !d) { d = parseFloat(((h+a)/1.5).toFixed(2)); if (d < 2.5) d = 3.10; }
               let cc = 'gb-eng'; if (m.sport_key.includes('germany')) cc='de'; else if (m.sport_key.includes('spain')) cc='es'; else if (m.sport_key.includes('italy')) cc='it'; else if (m.sport_key.includes('france')) cc='fr'; else if (m.sport_key.includes('usa')) cc='us';
               return { id: 'api_'+m.id, sport: sp, region: 'Global', league: m.sport_title||'League', country: cc, home: m.home_team, away: m.away_team, isLive: false, isFeatured: Math.random()>0.7, startTime: md.toISOString(), score: null, odds: [h,d,a], marketCount: Math.floor(Math.random()*150)+30, gradeScore: sp==='soccer'?80:50, status: 'upcoming', result: null, finalScore: null };
           }).filter(Boolean);
   
           const combined = [...dbMatches, ...apiMatches].sort((a,b) => (b.gradeScore||0) - (a.gradeScore||0));
           res.json({ success: true, matches: combined.slice(0,500) });
       } catch (err) { res.status(500).json({ error: "Fetch failed." }); }
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
       } catch (err) { next(err); }
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
           stake = parseFloat(stake); totalOdds = parseFloat(totalOdds);
           if (isNaN(stake) || stake <= 0) return res.status(400).json({ success: false, message: 'Invalid stake.' });
           if (isNaN(totalOdds) || totalOdds < 1) return res.status(400).json({ success: false, message: 'Invalid odds.' });
           potentialWin = parseFloat((stake * totalOdds).toFixed(2));
           if (!Array.isArray(selections) || selections.length === 0) return res.status(400).json({ success: false, message: 'No selections.' });
   
           const user = await User.findById(req.user._id);
           if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
           if (user.balance < stake) return res.status(400).json({ success: false, message: 'Insufficient balance.' });
   
           const tracked = await Promise.all(selections.map(async s => {
               let st = s.startTime ? new Date(s.startTime) : null;
               if (s.matchId && mongoose.Types.ObjectId.isValid(s.matchId)) {
                   const dbm = await Match.findById(s.matchId).select('startTime');
                   if (dbm && dbm.startTime) st = dbm.startTime;
               }
               if (!st) st = new Date(Date.now() + 2*60*60*1000);
               return { matchId: s.matchId, match: s.match || s.title, pick: s.pick, selection: s.selection || s.pick, marketType: s.marketType || '1x2', odds: parseFloat(s.odds)||0, startTime: st, status: 'Open', score: null, finalScore: null };
           }));
   
           const bet = new Bet({
               userId: user._id, ticketId: 'BW-'+Math.random().toString(36).substring(2,8).toUpperCase(),
               selections: tracked, stake, totalOdds, potentialWin,
               currency: currency || user.currency, userTimezone: user.timezone || 'Africa/Nairobi', bookingCode: bookingCode || undefined
           });
           await bet.save();
           user.balance -= stake; user.totalBets += 1; await user.save();
   
           await Transaction.create({ userId: user._id, type: 'Bet Placed', amount: -stake, currency: bet.currency, status: 'Completed' });
           sendTelegramMessage(`🎲 <b>NEW BETWINN BET</b>\n👤 ${user.username}\n💰 Stake: ${stake} ${bet.currency}\n🎯 Potential: ${potentialWin} ${bet.currency}`);
           res.json({ success: true, ticketId: bet.ticketId, newBalance: user.balance, bet });
       } catch (err) { next(err); }
   });
   
   app.get('/api/bets/my', authenticate, async (req, res, next) => {
       try { res.json({ success: true, bets: await Bet.find({ userId: req.user._id }).sort({ placedAt: -1 }).limit(50) }); }
       catch (err) { next(err); }
   });
   
   app.post('/api/bets/save-code', async (req, res) => {
       try {
           const { code, legs, stake, totalOdds, potentialReturn, currency } = req.body;
           await BookingSlip.findOneAndUpdate({ code: code.toUpperCase() }, { code: code.toUpperCase(), legs, stake, totalOdds, potentialReturn, currency }, { upsert: true, new: true });
           res.json({ success: true, message: 'Code saved.' });
       } catch (err) { res.status(500).send(); }
   });
   
   app.get('/api/bets/code/:code', async (req, res) => {
       try { const slip = await BookingSlip.findOne({ code: req.params.code.toUpperCase() }); if (!slip) return res.status(404).send(); res.json(slip); }
       catch (err) { res.status(500).send(); }
   });
   
   /* =========================================================
      WALLET, DEPOSIT & WITHDRAWAL
      ========================================================= */
   app.post('/api/deposit', async (req, res) => {
       try {
           const { userPhone, method } = req.body;
           const amount = parseFloat(req.body.amount);
           if (!userPhone) return res.status(400).json({ success: false, message: 'Phone required.' });
           if (isNaN(amount) || amount < 10) return res.status(400).json({ success: false, message: 'Minimum deposit KES 10.' });
           const user = await User.findOne({ phone: userPhone });
           if (!user) return res.status(404).json({ success: false, message: 'Account not found.' });
   
           let fp = userPhone.replace(/\D/g, '');
           if (fp.startsWith('0')) fp = '254' + fp.slice(1);
           else if (/^[71]/.test(fp)) fp = '254' + fp;
           else if (!fp.startsWith('254')) fp = '254' + fp;
           if (fp.length !== 12) return res.status(400).json({ success: false, message: 'Invalid phone format.' });
   
           const ref = 'DEP'+Date.now();
           const payload = {
               api_key: process.env.MEGAPAY_API_KEY || 'MGPYCVoPXv2P',
               email: process.env.MEGAPAY_EMAIL || 'gleah6423@gmail.com',
               amount: amount, msisdn: fp,
               callback_url: `${process.env.APP_URL || 'https://api.betwinn.co.ke'}/api/megapay/webhook`,
               description: 'BetWinn Deposit', reference: ref
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
   
           await Transaction.create({ refId: ref, userId: user._id, userPhone: user.phone, type: 'Deposit', method: method || 'M-Pesa', amount, currency: user.currency || 'KES', status: 'Pending' });
           res.json({ success: true, message: 'STK Push sent! Check your phone.', newBalance: user.balance, refId: ref });
       } catch (error) { res.status(500).json({ success: false, message: 'Internal error during deposit.' }); }
   });
   
   app.post('/api/megapay/webhook', async (req, res) => {
       res.status(200).send("OK");
       const data = req.body;
       try {
           if ((data.ResponseCode !== undefined ? data.ResponseCode : data.ResultCode) != 0) return;
           const amount = parseFloat(data.TransactionAmount || data.amount || data.Amount);
           const receipt = data.TransactionReceipt || data.MpesaReceiptNumber;
           const last9 = (data.Msisdn || data.phone || data.PhoneNumber || "").toString().replace(/\D/g, '').slice(-9);
           if (last9.length < 9) return;
           const user = await User.findOne({ phone: { $regex: new RegExp(last9 + '$') } });
           if (!user || await Transaction.findOne({ refId: receipt })) return;
           user.balance += amount; await user.save();
           await Transaction.create({ refId: receipt, userId: user._id, userPhone: user.phone, type: "Deposit", method: "M-Pesa", amount, status: "Success" });
           await new Notification({ userId: user._id, title: "Deposit Successful", message: `Your deposit of KES ${amount} has been credited. Receipt: ${receipt}` }).save();
           sendTelegramMessage(`💵 <b>BETWINN DEPOSIT</b>\n📱 ${user.phone}\n💰 KES ${amount}\n🧾 ${receipt}`);
       } catch (err) {}
   });
   
   app.post('/api/wallet/deposit/manual', authenticate, async (req, res) => {
       try {
           const { amount, currency, method, proofSubmitted } = req.body;
           await Transaction.create({ userId: req.user._id, type: 'Deposit', method, amount, currency, status: 'Pending', proofUrl: proofSubmitted ? 'Proof Submitted' : 'Pending' });
           sendTelegramMessage(`⏳ <b>BETWINN MANUAL DEPOSIT</b>\n👤 ${req.user.username}\n💳 ${method}\n💰 ${amount} ${currency}`);
           res.json({ success: true, message: 'Deposit submitted for review.' });
       } catch (err) { res.status(500).send(); }
   });
   
   app.post('/api/wallet/withdraw', authenticate, async (req, res) => {
       try {
           const { amount, currency, accountDetails, method } = req.body;
           const user = await User.findById(req.user._id);
           if (!user || user.balance < amount) return res.status(400).json({ success: false, message: 'Insufficient balance.' });
           user.balance -= parseFloat(amount); await user.save();
           await Transaction.create({ userId: user._id, type: 'Withdrawal', amount, currency, status: 'Pending', method: method || 'M-Pesa' });
           sendTelegramMessage(`💸 <b>BETWINN WITHDRAWAL</b>\n👤 ${user.username}\n💳 ${accountDetails}\n💰 ${amount} ${currency}`);
           res.json({ success: true, message: 'Withdrawal requested.', balance: user.balance });
       } catch (err) { res.status(500).send(); }
   });
   
   app.get('/api/wallet/transactions/:userId', authenticate, async (req, res) => {
       try { res.json({ success: true, transactions: await Transaction.find({ userId: req.params.userId }).sort({ date: -1 }) }); }
       catch (err) { res.status(500).send(); }
   });
   
   /* =========================================================
      ADMIN ROUTES
      ========================================================= */
   app.post('/api/admin/login', rateLimit({ windowMs: 15*60*1000, max: 10 }), (req, res) => {
       const { password } = req.body;
       if (password === (process.env.ADMIN_PASS || 'admin@26wins')) {
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
               if (txn.type === 'Withdrawal') { const user = await User.findById(txn.userId); user.balance += txn.amount; await user.save(); await new Notification({ userId: user._id, title: "Withdrawal Rejected", message: `Your withdrawal of ${txn.amount} ${txn.currency} was rejected. Funds returned.` }).save(); }
           }
           await txn.save(); res.json({ message: `Transaction ${action}d.` });
       } catch (err) { res.status(500).send(); }
   });
   
   app.get('/api/admin/matches', verifyAdminToken, async (req, res) => { try { res.json(await Match.find().sort({ startTime: -1 }).limit(500)); } catch (err) { res.status(500).send(); } });
   
   app.post('/api/admin/matches', verifyAdminToken, async (req, res) => {
       try {
           const md = req.body;
           const parsedStart = new Date(md.startTime);
           if (isNaN(parsedStart.getTime())) return res.status(400).send();
           const m = new Match({ ...md, status: 'upcoming', isLive: false, startTime: parsedStart, timezone: md.timezone || 'UTC', markets: md.markets || {}, result: md.result || null });
           await m.save(); res.status(201).json({ message: "Match injected!", match: m });
       } catch (err) { res.status(500).send(); }
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
           const now = new Date().getTime(); const start = new Date(match.startTime).getTime(); const elapsed = now - start; const twoHours = 2*60*60*1000;
           if (elapsed < 0) { updateData.status = 'upcoming'; updateData.isLive = false; }
           else if (elapsed >= 0 && elapsed < twoHours) { updateData.status = 'live'; updateData.isLive = true; }
           else { if (isLive !== undefined) updateData.isLive = isLive; if (status !== undefined) updateData.status = status; }
           const updated = await Match.findByIdAndUpdate(req.params.id, updateData, { new: true });
           res.json({ message: "Result updated.", match: updated });
       } catch (err) { res.status(500).send(); }
   });
   
   /* =========================================================
      BACKGROUND WORKERS (SMART SETTLEMENT)
      ========================================================= */
   setInterval(async () => {
       try {
           const now = new Date();
           await Match.updateMany({ status: 'upcoming', startTime: { $lte: now } }, { $set: { status: 'live', isLive: true } });
           const twoHoursAgo = new Date(now.getTime() - (2*60*60*1000));
           await Match.updateMany({ status: 'live', startTime: { $lte: twoHoursAgo } }, { $set: { status: 'completed', isLive: false } });
       } catch (err) {}
   }, 60000);
   
   setInterval(async () => {
       try {
           const openBets = await Bet.find({ status: { $in: ['Open', 'Partial'] } }).populate('userId');
           const now = new Date();
           for (let bet of openBets) {
               let betUpdated = false, allSettled = true, hasLost = false;
               for (let leg of bet.selections) {
                   if (leg.status !== 'Open') { if (leg.status === 'Lost') hasLost = true; continue; }
                   const settlementTime = new Date(new Date(leg.startTime).getTime() + (2*60*60*1000));
                   if (now < settlementTime) { allSettled = false; continue; }
                   let matchResult = null;
                   try { if (mongoose.Types.ObjectId.isValid(leg.matchId)) matchResult = await Match.findById(leg.matchId); if (!matchResult && leg.match) matchResult = await Match.findOne({ homeTeam: leg.match.split(' v ')[0], startTime: leg.startTime }); } catch(e){}
                   let resultObj = null;
                   if (matchResult) {
                       if (matchResult.result && matchResult.result.homeGoals !== undefined && matchResult.result.awayGoals !== undefined) resultObj = matchResult.result;
                       else { const sc = matchResult.finalScore || matchResult.score; if (typeof sc === 'string' && sc.includes('-')) { const p=sc.split('-').map(s=>parseInt(s.trim())); if (p.length===2 && !isNaN(p[0]) && !isNaN(p[1])) resultObj = { homeGoals: p[0], awayGoals: p[1], correctScore: sc }; } }
                   }
                   let isWin = false;
                   const pickStr = (leg.pick || '').toString().trim().toUpperCase();
                   const selStr = (leg.selection || '').toString().trim().toUpperCase();
                   if (resultObj) {
                       const hG = parseInt(resultObj.homeGoals) || 0; const aG = parseInt(resultObj.awayGoals) || 0; const total = hG + aG; const bothScored = (hG > 0 && aG > 0);
                       if (pickStr.match(/^\d+-\d+$/)) isWin = (pickStr === `${hG}-${aG}`);
                       else if (pickStr.includes('OVER') || pickStr.includes('UNDER') || selStr.includes('OVER') || selStr.includes('UNDER')) {
                           const matchNum = pickStr.match(/\d+(\.\d+)?/) || selStr.match(/\d+(\.\d+)?/);
                           if (matchNum) { const line = parseFloat(matchNum[0]); if ((pickStr.includes('OVER') || selStr.includes('OVER')) && total > line) isWin = true; if ((pickStr.includes('UNDER') || selStr.includes('UNDER')) && total < line) isWin = true; }
                       }
                       else if (pickStr === '1X' || selStr.includes('1X')) isWin = hG >= aG;
                       else if (pickStr === 'X2' || selStr.includes('X2')) isWin = aG >= hG;
                       else if (pickStr === '12' || selStr.includes('12')) isWin = hG !== aG;
                       else if (selStr.includes('BTTS') || pickStr === 'YES' || pickStr === 'NO') { if ((pickStr === 'YES' || selStr.includes('YES')) && bothScored) isWin = true; if ((pickStr === 'NO' || selStr.includes('NO')) && !bothScored) isWin = true; }
                       else if (pickStr === 'ODD' || selStr === 'ODD') isWin = (total % 2 !== 0);
                       else if (pickStr === 'EVEN' || selStr === 'EVEN') isWin = (total % 2 === 0);
                       else { if ((pickStr === '1' || selStr === '1' || pickStr.includes('HOME')) && hG > aG) isWin = true; else if ((pickStr === 'X' || pickStr === 'DRAW' || selStr.includes('DRAW')) && hG === aG) isWin = true; else if ((pickStr === '2' || selStr === '2' || pickStr.includes('AWAY')) && aG > hG) isWin = true; }
                   } else { isWin = Math.random() > 0.5; }
                   leg.status = isWin ? 'Won' : 'Lost';
                   leg.finalScore = matchResult ? (matchResult.finalScore || matchResult.score || `${resultObj?.homeGoals||0}-${resultObj?.awayGoals||0}`) : null;
                   betUpdated = true; if (leg.status === 'Lost') hasLost = true;
               }
               if (hasLost) { bet.status = 'Lost'; betUpdated = true; }
               else if (allSettled) {
                   bet.status = 'Won'; betUpdated = true;
                   const user = await User.findById(bet.userId);
                   if (user) { user.balance += bet.potentialWin; await user.save(); await Transaction.create({ userId: user._id, type: 'Win', amount: bet.potentialWin, currency: bet.currency, status: 'Success' }); await new Notification({ userId: user._id, title: "Bet Won! 🎉", message: `Your bet ${bet.ticketId} won! ${bet.potentialWin} ${bet.currency} credited.` }).save(); }
               } else if (betUpdated) { bet.status = 'Partial'; }
               if (betUpdated) { bet.markModified('selections'); await bet.save(); }
           }
       } catch (err) {}
   }, 60000);
   
   /* =========================================================
      PARLAY API BACKGROUND SYNC (BetWinn Original)
      ========================================================= */
   async function fetchAndCacheLiveOdds() {
       try {
           console.log("🔄 Fetching odds from parlay-api.com...");
           const sportsToFetch = ['soccer_epl','soccer_uefa_champs_league','soccer_spain_la_liga','soccer_italy_serie_a','basketball_nba','tennis_atp','mma_mixed_martial_arts'];
           let allApiMatches = [];
           for (const sport of sportsToFetch) {
               try {
                   const response = await axios.get(`https://parlay-api.com/v4/sports/${sport}/odds?apiKey=${PARLAY_API_KEY}&regions=us,eu,uk&markets=h2h,spreads`);
                   if (response.data && Array.isArray(response.data)) allApiMatches = allApiMatches.concat(response.data);
               } catch (e) { console.error(`❌ Failed sport ${sport}:`, e.response?.data?.message || e.message); }
           }
           const now = new Date(); let syncedCount = 0;
           for (const match of allApiMatches) {
               const matchDate = new Date(match.commence_time);
               if (now.getTime() - matchDate.getTime() >= 0) continue;
               const market = match.bookmakers[0]?.markets[0];
               let homeOdds = 1.90, drawOdds = null, awayOdds = 1.90;
               if (market && market.outcomes) {
                   const homeOutcome = market.outcomes.find(o => o.name === match.home_team);
                   const awayOutcome = market.outcomes.find(o => o.name === match.away_team);
                   const drawOutcome = market.outcomes.find(o => o.name === 'Draw' || (o.name !== match.home_team && o.name !== match.away_team));
                   if (homeOutcome) homeOdds = homeOutcome.price;
                   if (awayOutcome) awayOdds = awayOutcome.price;
                   if (drawOutcome) drawOdds = drawOutcome.price;
               }
               let mappedSport = 'soccer';
               if (match.sport_key.includes('basketball')) mappedSport = 'basketball';
               if (match.sport_key.includes('tennis')) mappedSport = 'tennis';
               if (match.sport_key.includes('mma')) mappedSport = 'mma';
               if (mappedSport === 'soccer' && !drawOdds) { drawOdds = parseFloat(((homeOdds + awayOdds) / 1.6).toFixed(2)); if (drawOdds < 2.5) drawOdds = 3.10; }
               await Match.findOneAndUpdate(
                   { apiId: match.id },
                   { apiId: match.id, sport: mappedSport, league: match.sport_title || 'League', homeTeam: match.home_team, awayTeam: match.away_team, startTime: matchDate, isLive: false, odds: { '1': parseFloat(homeOdds)||0, 'X': parseFloat(drawOdds)||0, '2': parseFloat(awayOdds)||0 }, oddsArr: [parseFloat(homeOdds)||0, parseFloat(drawOdds)||0, parseFloat(awayOdds)||0], marketsCount: Math.floor(Math.random()*150)+50, featured: Math.random()>0.8 },
                   { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
               );
               syncedCount++;
           }
           console.log(`✅ Synced ${syncedCount} matches from Parlay API`);
       } catch (e) { console.error("🔥 Odds Fetch Error:", e.message); }
   }
   
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
           try { await mongoose.connection.collection('bets').dropIndex('bookingCode_1'); console.log('Cleared legacy index.'); } catch(e){}
           fetchAndCacheLiveOdds();
           setInterval(fetchAndCacheLiveOdds, 30 * 60 * 1000);
           app.listen(PORT, () => { console.log(`BetWinn API running on port ${PORT}`); console.log(`API Base: ${API_URL}`); });
       })
       .catch(err => { console.error('MongoDB connection failed:', err); process.exit(1); });