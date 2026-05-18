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
   const ODDS_API_KEY = process.env.ODDS_API_KEY || 'e74fb850fc80d42a467adf602d6e0e0b';
   
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
   
   function getCountryCodeFromSportKey(sportKey) {
    if (!sportKey) return 'gb';
    const map = {
        'soccer_epl': 'gb',           // changed from 'gb-eng'
        'soccer_spain': 'es',
        'soccer_italy': 'it',
        'soccer_germany': 'de',
        'soccer_france': 'fr',
        'soccer_uefa': 'eu',          // flagcdn handles 'eu' beautifully
        'soccer_netherlands': 'nl',
        'soccer_portugal': 'pt',
        'soccer_belgium': 'be',
        'soccer_turkey': 'tr',
        'soccer_usa': 'us',
        'soccer_canada': 'ca',
        'soccer_australia': 'au',
        'soccer_kenya': 'ke',
        'soccer_tanzania': 'tz',
        'soccer_uganda': 'ug',
        'basketball_nba': 'us',
        'tennis_atp': 'gb',
        'tennis_wta': 'gb',
        'mma_ufc': 'us'
    };
    for (const [prefix, code] of Object.entries(map)) {
        if (sportKey.toLowerCase().startsWith(prefix)) return code;
    }
    return 'gb'; // fallback code string
}

function getTeamFlagUrl(teamName, countryCode) {
    // Use country flag as base, with team initials overlay concept via ui-avatars for team-specific look
    const cc = countryCode || 'gb-eng';
    const encoded = encodeURIComponent(teamName || 'Team');
    return {
        flag: `https://flagcdn.com/w40/${cc}.png`,
        logo: `https://ui-avatars.com/api/?name=${encoded}&background=2563eb&color=fff&size=128&bold=true&font-size=0.4`,
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
       try {
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
                   floorball: 'fa-hockey-puck', bandy: 'fa-hockey-puck', biathlon: 'fa-person-skiing',
                   skiing: 'fa-person-skiing', formula1: 'fa-flag-checkered', nascar: 'fa-flag-checkered',
                   rugbyunion: 'fa-football', rugbyleague: 'fa-football', fieldhockey: 'fa-hockey-puck',
                   lacrosse: 'fa-baseball', softball: 'fa-baseball', netball: 'fa-volleyball',
                   pesapallo: 'fa-baseball-bat-ball', surfing: 'fa-water', sailing: 'fa-sailboat',
                   rowing: 'fa-water', canoeing: 'fa-water', triathlon: 'fa-person-swimming',
                   tabletennis: 'fa-table-tennis-paddle-ball', badminton: 'fa-feather', squash: 'fa-circle',
                   racquetball: 'fa-circle', polo: 'fa-horse', chess: 'fa-chess-knight',
                   archery: 'fa-bullseye', shooting: 'fa-crosshairs', weightlifting: 'fa-dumbbell',
                   gymnastics: 'fa-person-falling', athletics: 'fa-person-running', swimming: 'fa-person-swimming',
                   diving: 'fa-water', equestrian: 'fa-horse', fencing: 'fa-khanda', judo: 'fa-hand-fist',
                   taekwondo: 'fa-hand-fist', karate: 'fa-hand-fist', wrestling: 'fa-hand-fist',
                   kickboxing: 'fa-hand-fist', muaythai: 'fa-hand-fist', sumo: 'fa-hand-fist',
                   brazilianjiujitsu: 'fa-hand-fist', parkour: 'fa-person-running', climbing: 'fa-mountain',
                   skateboarding: 'fa-person-skating', snowboarding: 'fa-person-skiing', curling: 'fa-circle',
                   bobsleigh: 'fa-sleigh', luge: 'fa-sleigh', skeleton: 'fa-skull', skijumping: 'fa-person-skiing',
                   alpine: 'fa-person-skiing', crosscountry: 'fa-person-skiing', freestyle: 'fa-person-skiing',
                   nordiccombined: 'fa-person-skiing', shorttrack: 'fa-person-skating', speedskating: 'fa-person-skating',
                   figure: 'fa-person-skating', synchronizedswimming: 'fa-person-swimming', marathon: 'fa-person-running',
                   race: 'fa-flag-checkered', horseracing: 'fa-horse', dogracing: 'fa-dog', camelracing: 'fa-hippo',
                   greyhound: 'fa-dog', harness: 'fa-horse', trotting: 'fa-horse', endurance: 'fa-horse',
                   rally: 'fa-car', motogp: 'fa-motorcycle', superbike: 'fa-motorcycle', motocross: 'fa-motorcycle',
                   atv: 'fa-truck-monster', truck: 'fa-truck', tractor: 'fa-tractor', drifter: 'fa-car',
                   drag: 'fa-car', karting: 'fa-car', speedway: 'fa-motorcycle', grasstrack: 'fa-motorcycle',
                   ice_racing: 'fa-car', snowmobile: 'fa-sleigh', jetboat: 'fa-ship', powerboat: 'fa-ship',
                   yachting: 'fa-sailboat', windsurfing: 'fa-water', kitesurfing: 'fa-wind', wakeboarding: 'fa-water',
                   waterskiing: 'fa-water', paddleboarding: 'fa-water', kayaking: 'fa-water', rafting: 'fa-water',
                   fishing: 'fa-fish', hunting: 'fa-paw', shooting_sports: 'fa-crosshairs', billiards: 'fa-circle',
                   pool: 'fa-circle', carrom: 'fa-circle', bocce: 'fa-circle', petanque: 'fa-circle',
                   boules: 'fa-circle', croquet: 'fa-circle', shuffleboard: 'fa-circle', horseshoes: 'fa-circle',
                   discgolf: 'fa-circle', ultimate: 'fa-flying-disc', kabaddi: 'fa-hand-fist', sepaktakraw: 'fa-futbol',
                   wushu: 'fa-hand-fist', sambo: 'fa-hand-fist', pankration: 'fa-hand-fist', bareknuckle: 'fa-hand-fist',
                   lethwei: 'fa-hand-fist'
               };
               const colorMap = {
                   soccer: '#3b82f6', basketball: '#f97316', tennis: '#22c55e', mma: '#6b7280', cricket: '#ef4444',
                   rugby: '#8b5cf6', baseball: '#eab308', icehockey: '#06b6d4', volleyball: '#ec4899', esports: '#a855f7',
                   americanfootball: '#f97316', golf: '#22c55e', boxing: '#ef4444', motorsports: '#f97316', cycling: '#22c55e',
                   darts: '#ef4444', snooker: '#22c55e', handball: '#f97316', waterpolo: '#06b6d4', futsal: '#3b82f6',
                   aussierules: '#eab308', floorball: '#06b6d4', bandy: '#06b6d4', biathlon: '#22c55e', skiing: '#22c55e',
                   formula1: '#ef4444', nascar: '#ef4444', rugbyunion: '#8b5cf6', rugbyleague: '#8b5cf6', fieldhockey: '#06b6d4',
                   lacrosse: '#eab308', softball: '#eab308', netball: '#ec4899', pesapallo: '#ef4444', surfing: '#06b6d4',
                   sailing: '#06b6d4', rowing: '#06b6d4', canoeing: '#06b6d4', triathlon: '#22c55e', tabletennis: '#22c55e',
                   badminton: '#22c55e', squash: '#22c55e', racquetball: '#22c55e', polo: '#eab308', chess: '#a855f7',
                   archery: '#ef4444', shooting: '#ef4444', weightlifting: '#6b7280', gymnastics: '#ec4899', athletics: '#f97316',
                   swimming: '#06b6d4', diving: '#06b6d4', equestrian: '#eab308', fencing: '#a855f7', judo: '#6b7280',
                   taekwondo: '#6b7280', karate: '#6b7280', wrestling: '#6b7280', kickboxing: '#ef4444', muaythai: '#ef4444',
                   sumo: '#6b7280', brazilianjiujitsu: '#6b7280', parkour: '#f97316', climbing: '#22c55e', skateboarding: '#ec4899',
                   snowboarding: '#22c55e', curling: '#06b6d4', bobsleigh: '#06b6d4', luge: '#06b6d4', skeleton: '#a855f7',
                   skijumping: '#22c55e', alpine: '#22c55e', crosscountry: '#22c55e', freestyle: '#22c55e', nordiccombined: '#22c55e',
                   shorttrack: '#06b6d4', speedskating: '#06b6d4', figure: '#ec4899', synchronizedswimming: '#06b6d4', marathon: '#f97316',
                   race: '#ef4444', horseracing: '#eab308', dogracing: '#a855f7', camelracing: '#eab308', greyhound: '#a855f7',
                   harness: '#eab308', trotting: '#eab308', endurance: '#eab308', rally: '#ef4444', motogp: '#ef4444',
                   superbike: '#ef4444', motocross: '#ef4444', atv: '#f97316', truck: '#f97316', tractor: '#f97316',
                   drifter: '#ef4444', drag: '#ef4444', karting: '#ef4444', speedway: '#ef4444', grasstrack: '#ef4444',
                   ice_racing: '#06b6d4', snowmobile: '#06b6d4', jetboat: '#06b6d4', powerboat: '#06b6d4', yachting: '#06b6d4',
                   windsurfing: '#06b6d4', kitesurfing: '#06b6d4', wakeboarding: '#06b6d4', waterskiing: '#06b6d4',
                   paddleboarding: '#06b6d4', kayaking: '#06b6d4', rafting: '#06b6d4', fishing: '#22c55e', hunting: '#22c55e',
                   shooting_sports: '#ef4444', billiards: '#22c55e', pool: '#22c55e', carrom: '#22c55e', bocce: '#22c55e',
                   petanque: '#22c55e', boules: '#22c55e', croquet: '#22c55e', shuffleboard: '#22c55e', horseshoes: '#22c55e',
                   discgolf: '#22c55e', ultimate: '#22c55e', kabaddi: '#ef4444', sepaktakraw: '#3b82f6', wushu: '#ef4444',
                   sambo: '#ef4444', pankration: '#ef4444', bareknuckle: '#ef4444', lethwei: '#ef4444'
               };
               const mapped = response.data.filter(s => s.active).map(s => {
                   const key = s.key || 'unknown';
                   const baseKey = key.split('_')[0];
                   return {
                       id: baseKey,
                       name: s.title || s.group || key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                       icon: iconMap[baseKey] || 'fa-trophy',
                       color: colorMap[baseKey] || '#2563eb',
                       key: key,
                       group: s.group || 'Other',
                       hasOutrights: s.has_outrights || false
                   };
               });
               const seen = new Set();
               const deduped = mapped.filter(s => { if (seen.has(s.id)) return false; seen.add(s.id); return true; });
               return res.json({ success: true, sports: deduped.slice(0, 60), source: 'the-odds-api', total: deduped.length });
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
           { id: 'floorball', name: 'Floorball', icon: 'fa-hockey-puck', color: '#06b6d4' },
           { id: 'formula1', name: 'Formula 1', icon: 'fa-flag-checkered', color: '#ef4444' },
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
           { name: 'ATP Tour', flag: 'https://flagcdn.com/w20/gb-eng.png', league: 'ATP Tour', country: 'gb-eng' },
           { name: 'La Liga 2', flag: 'https://flagcdn.com/w20/es.png', league: 'Segunda División', country: 'es' },
           { name: 'Serie B', flag: 'https://flagcdn.com/w20/it.png', league: 'Serie B', country: 'it' },
           { name: 'Bundesliga 2', flag: 'https://flagcdn.com/w20/de.png', league: '2. Bundesliga', country: 'de' },
           { name: 'Ligue 2', flag: 'https://flagcdn.com/w20/fr.png', league: 'Ligue 2', country: 'fr' },
           { name: 'Eredivisie', flag: 'https://flagcdn.com/w20/nl.png', league: 'Eredivisie', country: 'nl' },
           { name: 'Primeira Liga', flag: 'https://flagcdn.com/w20/pt.png', league: 'Primeira Liga', country: 'pt' },
           { name: 'Belgian Pro', flag: 'https://flagcdn.com/w20/be.png', league: 'Belgian Pro League', country: 'be' },
           { name: 'Scottish Prem', flag: 'https://flagcdn.com/w20/gb-sct.png', league: 'Scottish Premiership', country: 'gb-sct' },
           { name: 'Turkish Süper', flag: 'https://flagcdn.com/w20/tr.png', league: 'Süper Lig', country: 'tr' },
           { name: 'Russian Prem', flag: 'https://flagcdn.com/w20/ru.png', league: 'Russian Premier League', country: 'ru' }
       ];
       res.json({ success: true, competitions, source: 'fallback' });
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
   
           const matches = await Match.find(query).sort({ startTime: 1 }).limit(parseInt(limit)).skip((parseInt(page) - 1) * parseInt(limit)).lean();
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
       } catch (err) { next(err); }
   });
   
   app.get('/api/matches/featured', async (req, res, next) => {
       try {
        const matches = await Match.find({ featured: true, status: { $in: ['upcoming', 'live'] } }).limit(10).sort({ startTime: 1 }).lean();
           let formatted = matches.map(m => {
               const obj = m.toObject(); obj.id = m._id.toString();
               if (m.status === 'live' && m.startTime) { obj.score = getDeterministicScore(m._id.toString(), m.startTime.toISOString(), m.result); obj.time = getMatchTimeStr(m.startTime.toISOString()); obj.isLive = true; }
               return obj;
           });
           formatted = formatted.map(m => enrichMatchWithFlags(m));
           res.json({ success: true, matches: formatted });
       } catch (err) { next(err); }
   });
   
   app.get('/api/live-matches', async (req, res) => {
       try {
           const now = new Date();
           const matches = await Match.find({ apiId: { $exists: true }, status: { $in: ['upcoming', 'live'] } }).sort({ startTime: 1 }).limit(500).lean();

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
               obj.marketCount = m.marketsCount || 50;
               obj.region = 'Global';
               obj.country = m.country || 'gb-eng';
               return obj;
           });

           formatted = formatted.map(m => enrichMatchWithFlags(m));
           res.json({ success: true, matches: formatted });
       } catch (err) { 
           console.error("Live matches error:", err);
           res.status(500).json({ error: "Fetch failed." }); 
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
   
   app.get('/api/admin/matches', verifyAdminToken, async (req, res) => {
       try {
           const matches = await Match.find().sort({ startTime: -1 }).limit(500);
           const enriched = matches.map(m => {
               const obj = m.toObject();
               obj.id = m._id.toString();
               return enrichMatchWithFlags(obj);
           });
           res.json(enriched);
       } catch (err) { res.status(500).send(); }
   });
   
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
      ODDS API HELPERS
      ========================================================= */
async function getOddsApiActiveSports() {
    try {
        const r = await axios.get('https://api.the-odds-api.com/v4/sports/', {
            params: { apiKey: ODDS_API_KEY },
            timeout: 10000
        });
        if (r.data && Array.isArray(r.data)) {
            return r.data.filter(s => s.active && !s.key.includes('_outrights')).map(s => s.key);
        }
    } catch (e) {
        console.error('Failed to fetch sports list:', e.message);
    }
    return [];
}

/* =========================================================
      PARLAY API BACKGROUND SYNC (BetWinn Original)
      ========================================================= */
   async function fetchAndCacheLiveOdds() {
       try {
           console.log("🔄 Fetching odds from the-odds-api.com...");
           const activeSports = await getOddsApiActiveSports();

           const prioritySports = [
               'soccer_epl','soccer_uefa_champs_league','soccer_spain_la_liga','soccer_italy_serie_a',
               'soccer_germany_bundesliga','soccer_france_ligue_one','basketball_nba',
               'icehockey_nhl','mma_mixed_martial_arts','americanfootball_nfl','baseball_mlb',
               'tennis_atp','tennis_wta','cricket_international','rugby_six_nations','golf_pga'
           ];

           let sportsToFetch = [];
           for (const s of prioritySports) {
               if (activeSports.includes(s) && !sportsToFetch.includes(s)) sportsToFetch.push(s);
           }
           for (const s of activeSports) {
               if (!sportsToFetch.includes(s)) {
                   sportsToFetch.push(s);
                   if (sportsToFetch.length >= 18) break;
               }
           }
           if (sportsToFetch.length === 0) {
               console.error("❌ No active sports available from The-Odds-API");
               return;
           }
           console.log(`📋 Fetching odds for ${sportsToFetch.length} sports:`, sportsToFetch.slice(0,20).join(', ') + (sportsToFetch.length>20?'...':''));

           let allApiMatches = [];
           for (const sport of sportsToFetch) {
               try {
                   const response = await axios.get(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`, {
                       params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h', oddsFormat: 'decimal' },
                       timeout: 15000
                   });
                   if (response.data && Array.isArray(response.data)) allApiMatches = allApiMatches.concat(response.data);
               } catch (e) {
                   const msg = e.response?.data?.message || e.response?.data || e.message;
                   if (msg?.includes?.('Unknown sport') || msg?.includes?.('does not exist')) {
                       console.warn(`⚠️ Skipping ${sport}: not available on The-Odds-API`);
                   } else if (e.response?.status === 403) {
                       console.error(`❌ ${sport}: API key invalid or quota exceeded (403)`);
                   } else {
                       console.error(`❌ Failed sport ${sport}:`, msg);
                   }
               }
           }

           try {
               const upcoming = await axios.get('https://api.the-odds-api.com/v4/sports/upcoming/odds/', {
                   params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h', oddsFormat: 'decimal' },
                   timeout: 15000
               });
               if (upcoming.data && Array.isArray(upcoming.data)) allApiMatches = allApiMatches.concat(upcoming.data);
           } catch (e) { console.error('❌ Failed upcoming:', e.message); }

           const uniqueMap = new Map();
           allApiMatches.forEach(m => { if (!uniqueMap.has(m.id)) uniqueMap.set(m.id, m); });
           const uniqueMatches = Array.from(uniqueMap.values());

           const now = new Date(); let syncedCount = 0;
           for (const match of uniqueMatches) {
               const matchDate = new Date(match.commence_time);
               const diffMins = Math.floor((now - matchDate) / 60000);
               if (diffMins > 120) continue;

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
               const status = diffMins >= 0 && diffMins <= 115 ? 'live' : 'upcoming';

               await Match.findOneAndUpdate(
                   { apiId: match.id },
                   { apiId: match.id, sport: mappedSport, league: match.sport_title || 'League', homeTeam: match.home_team, awayTeam: match.away_team, startTime: matchDate, isLive: status === 'live', status, country: cc, odds: { '1': homeOdds, 'X': drawOdds, '2': awayOdds }, oddsArr: [homeOdds, drawOdds, awayOdds], marketsCount: Math.floor(Math.random()*150)+50, featured: Math.random()>0.8 },
                   { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
               );
               syncedCount++;
           }
           console.log(`✅ Synced ${syncedCount} matches from The-Odds-API`);

           const cleanupResult = await Match.deleteMany({
               apiId: { $exists: false },
               status: 'upcoming',
               createdAt: { $lt: new Date(Date.now() - 6*60*60*1000) }
           });
           if (cleanupResult.deletedCount > 0) {
               console.log(`🗑️ Cleaned up ${cleanupResult.deletedCount} old dummy matches`);
           }
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
           setInterval(fetchAndCacheLiveOdds, 10 * 60 * 1000);
           app.listen(PORT, () => { 
           console.log(`BetWinn API running on port ${PORT}`); 
           console.log(`API Base: ${API_URL}`);
           console.log('✅ Route registered: GET /api/live-matches');
       });
       })
       .catch(err => { console.error('MongoDB connection failed:', err); process.exit(1); });