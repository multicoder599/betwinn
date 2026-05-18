/* =========================================================
   BETWINN SERVER.JS (Production Edition)
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
       const p = String(phone).replace(/\D/g, '');
       if (p.startsWith('254')) return 'Africa/Nairobi';
       return 'UTC';
   };
   
   function getCountryCodeFromSportKey(sportKey) {
       if (!sportKey) return 'gb';
       const map = {
           'soccer_epl': 'gb',
           'soccer_spain': 'es',
           'soccer_italy': 'it',
           'soccer_germany': 'de',
           'soccer_france': 'fr',
           'soccer_uefa': 'eu',
           'soccer_usa': 'us',
           'basketball_nba': 'us',
           'tennis': 'gb',
           'mma': 'us'
       };
       for (const [prefix, code] of Object.entries(map)) {
           if (sportKey.toLowerCase().startsWith(prefix)) return code;
       }
       return 'gb';
   }
   
   function getTeamFlagUrl(teamName, countryCode) {
       const cc = countryCode || 'gb';
       const encoded = encodeURIComponent(teamName || 'Team');
       return {
           flag: `https://flagcdn.com/w40/${cc}.png`,
           logo: `https://ui-avatars.com/api/?name=${encoded}&background=2563eb&color=fff&size=128&bold=true&font-size=0.4`
       };
   }
   
   function enrichMatchWithFlags(matchObj) {
       let cc = matchObj.country || getCountryCodeFromSportKey(matchObj.sport_key || matchObj.sport || 'soccer');
       
       // SAFETY CHECK: Remove emojis so flagcdn.com doesn't 404
       if (/[^\x00-\x7F]/.test(cc) || cc.length > 3) {
           cc = 'gb';
       }
   
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
       country: { type: String, default: 'gb' },
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
       result: { homeGoals: Number, awayGoals: Number, correctScore: String, btts: String, winner: String },
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
           if (!token) return res.status(401).json({ success: false, message: 'Access denied.' });
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
      ROUTES
      ========================================================= */
   app.get('/api/health', (req, res) => { res.json({ success: true, message: "API is online!" }); });
   
   app.post('/api/auth/register', authLimiter, async (req, res, next) => {
       try {
           const { username, name, email, phone, password } = req.body;
           if (!username || !phone || !password) return res.status(400).json({ success: false, message: 'Missing fields.' });
           if (await User.findOne({ username: { $regex: new RegExp('^' + username + '$', 'i') } })) return res.status(400).json({ success: false, message: 'Username taken.' });
           if (await User.findOne({ phone })) return res.status(400).json({ success: false, message: 'Phone registered.' });
   
           const user = new User({ username, name: name || username, email: email || `${phone}@betwinn.co.ke`, phone, password: await bcrypt.hash(password, 12), currency: 'KES', countryCode: 'KE' });
           await user.save();
           const token = jwt.sign({ id: user._id, phone: user.phone }, JWT_SECRET, { expiresIn: '7d' });
           res.status(201).json({ success: true, token, user: { id: user._id, username: user.username, name: user.name, phone: user.phone, balance: user.balance } });
       } catch (err) { next(err); }
   });
   
   app.post('/api/auth/login', async (req, res, next) => {
       try {
           const { identifier, password } = req.body;
           const user = await User.findOne({ $or: [{ phone: identifier }, { username: identifier }, { email: identifier }] });
           if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ success: false, message: 'Invalid credentials.' });
           const token = jwt.sign({ id: user._id, phone: user.phone }, JWT_SECRET, { expiresIn: '7d' });
           res.json({ success: true, token, user: { id: user._id, username: user.username, name: user.name, phone: user.phone, balance: user.balance } });
       } catch (err) { next(err); }
   });
   
   app.get('/api/user', authenticate, async (req, res) => { res.json({ success: true, user: req.user }); });
   
   /* =========================================================
      MATCH ROUTES
      ========================================================= */
   app.get('/api/matches', async (req, res, next) => {
       try {
           const { sport, league, status, search, page = 1, limit = 50 } = req.query;
           let query = { status: { $in: ['upcoming', 'live'] } };
           if (sport) query.sport = sport;
           if (league) query.league = { $regex: league, $options: 'i' };
           if (status === 'live') query.status = 'live';
           if (search) query.$or = [{ homeTeam: { $regex: search, $options: 'i' } }, { awayTeam: { $regex: search, $options: 'i' } }, { league: { $regex: search, $options: 'i' } }];
   
           const matches = await Match.find(query).sort({ startTime: 1 }).limit(parseInt(limit)).skip((parseInt(page) - 1) * parseInt(limit)).lean();
           let formatted = matches.map(m => {
               if (m.status === 'live' && m.startTime) {
                   m.score = getDeterministicScore(m._id.toString(), m.startTime.toISOString(), m.result);
                   m.time = getMatchTimeStr(m.startTime.toISOString());
                   m.isLive = true;
               }
               m.id = m._id.toString();
               return enrichMatchWithFlags(m);
           });
           res.json({ success: true, matches: formatted, page: parseInt(page), total: await Match.countDocuments(query) });
       } catch (err) { next(err); }
   });
   
   app.get('/api/live-matches', async (req, res) => {
       try {
           const matches = await Match.find({ status: { $in: ['upcoming', 'live'] } }).sort({ startTime: 1 }).limit(500).lean();
           let formatted = matches.map(m => {
               m.id = m._id.toString();
               if (m.status === 'live' && m.startTime) {
                   m.score = getDeterministicScore(m._id.toString(), m.startTime.toISOString(), m.result);
                   m.time = getMatchTimeStr(m.startTime.toISOString());
                   m.isLive = true;
               }
               m.home = m.homeTeam; m.away = m.awayTeam;
               m.odds = [m.odds?.['1']||2.1, m.odds?.['X']||3.1, m.odds?.['2']||2.8];
               return enrichMatchWithFlags(m);
           });
           res.json({ success: true, matches: formatted });
       } catch (err) { res.status(500).json({ error: "Fetch failed." }); }
   });
   
   app.get('/api/matches/featured', async (req, res, next) => {
       try {
           const matches = await Match.find({ featured: true, status: { $in: ['upcoming', 'live'] } }).limit(10).sort({ startTime: 1 }).lean();
           let formatted = matches.map(m => {
               m.id = m._id.toString();
               if (m.status === 'live' && m.startTime) { 
                   m.score = getDeterministicScore(m._id.toString(), m.startTime.toISOString(), m.result); 
                   m.time = getMatchTimeStr(m.startTime.toISOString()); 
                   m.isLive = true; 
               }
               return enrichMatchWithFlags(m);
           });
           res.json({ success: true, matches: formatted });
       } catch (err) { next(err); }
   });
   
   app.get('/api/sports', (req, res) => {
       const sports = [
           { id: 'soccer', name: 'Football', icon: 'fa-futbol', color: '#3b82f6' },
           { id: 'basketball', name: 'Basketball', icon: 'fa-basketball', color: '#f97316' },
           { id: 'tennis', name: 'Tennis', icon: 'fa-table-tennis-paddle-ball', color: '#22c55e' }
       ];
       res.json({ success: true, sports });
   });
   
   app.get('/api/competitions', (req, res) => {
       const comps = [ { name: 'Premier League', flag: 'https://flagcdn.com/w20/gb.png', league: 'Premier League' } ];
       res.json({ success: true, competitions: comps });
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
       } catch (err) { console.error('Match status worker error:', err.message); }
   }, 60000);
   
   setInterval(async () => {
       try {
           const openBets = await Bet.find({ status: { $in: ['Open', 'Partial'] } }).populate('userId');
           const now = new Date();
           
           for (let bet of openBets) {
               let betUpdated = false, allSettled = true, hasLost = false;
               
               for (let leg of bet.selections) {
                   if (leg.status !== 'Open') { 
                       if (leg.status === 'Lost') hasLost = true; 
                       continue; 
                   }
                   
                   const settlementTime = new Date(new Date(leg.startTime).getTime() + (2 * 60 * 60 * 1000));
                   if (now < settlementTime) { 
                       allSettled = false; 
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
                   } catch(e) {}
                   
                   let resultObj = null;
                   if (matchResult) {
                       if (matchResult.result && matchResult.result.homeGoals !== undefined && matchResult.result.awayGoals !== undefined) {
                           resultObj = matchResult.result;
                       } else { 
                           const sc = matchResult.finalScore || matchResult.score; 
                           if (typeof sc === 'string' && sc.includes('-')) { 
                               const p = sc.split('-').map(s => parseInt(s.trim())); 
                               if (p.length === 2 && !isNaN(p[0]) && !isNaN(p[1])) {
                                   resultObj = { homeGoals: p[0], awayGoals: p[1], correctScore: sc }; 
                               }
                           } 
                       }
                   }
                   
                   let isWin = false;
                   const pickStr = (leg.pick || '').toString().trim().toUpperCase();
                   const selStr = (leg.selection || '').toString().trim().toUpperCase();
                   
                   if (resultObj) {
                       const hG = parseInt(resultObj.homeGoals) || 0; 
                       const aG = parseInt(resultObj.awayGoals) || 0; 
                       const total = hG + aG; 
                       const bothScored = (hG > 0 && aG > 0);
                       
                       if (pickStr.match(/^\d+-\d+$/)) {
                           isWin = (pickStr === `${hG}-${aG}`);
                       } else if (pickStr.includes('OVER') || pickStr.includes('UNDER') || selStr.includes('OVER') || selStr.includes('UNDER')) {
                           const matchNum = pickStr.match(/\d+(\.\d+)?/) || selStr.match(/\d+(\.\d+)?/);
                           if (matchNum) { 
                               const line = parseFloat(matchNum[0]); 
                               if ((pickStr.includes('OVER') || selStr.includes('OVER')) && total > line) isWin = true; 
                               if ((pickStr.includes('UNDER') || selStr.includes('UNDER')) && total < line) isWin = true; 
                           }
                       } else if (pickStr === '1X' || selStr.includes('1X')) {
                           isWin = hG >= aG;
                       } else if (pickStr === 'X2' || selStr.includes('X2')) {
                           isWin = aG >= hG;
                       } else if (pickStr === '12' || selStr.includes('12')) {
                           isWin = hG !== aG;
                       } else if (selStr.includes('BTTS') || pickStr === 'YES' || pickStr === 'NO') { 
                           if ((pickStr === 'YES' || selStr.includes('YES')) && bothScored) isWin = true; 
                           if ((pickStr === 'NO' || selStr.includes('NO')) && !bothScored) isWin = true; 
                       } else if (pickStr === 'ODD' || selStr === 'ODD') {
                           isWin = (total % 2 !== 0);
                       } else if (pickStr === 'EVEN' || selStr === 'EVEN') {
                           isWin = (total % 2 === 0);
                       } else { 
                           if ((pickStr === '1' || selStr === '1' || pickStr.includes('HOME')) && hG > aG) isWin = true; 
                           else if ((pickStr === 'X' || pickStr === 'DRAW' || selStr.includes('DRAW')) && hG === aG) isWin = true; 
                           else if ((pickStr === '2' || selStr === '2' || pickStr.includes('AWAY')) && aG > hG) isWin = true; 
                       }
                   } else { 
                       isWin = Math.random() > 0.5; 
                   }
                   
                   leg.status = isWin ? 'Won' : 'Lost';
                   leg.finalScore = matchResult ? (matchResult.finalScore || matchResult.score || `${resultObj?.homeGoals||0}-${resultObj?.awayGoals||0}`) : null;
                   betUpdated = true; 
                   if (leg.status === 'Lost') hasLost = true;
               }
               
               if (hasLost) { 
                   bet.status = 'Lost'; 
                   betUpdated = true; 
               } else if (allSettled) {
                   bet.status = 'Won'; 
                   betUpdated = true;
                   const user = await User.findById(bet.userId);
                   if (user) { 
                       user.balance += bet.potentialWin; 
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
       } catch (err) {
           console.error('Settlement worker error:', err.message);
       }
   }, 60000);
   
   
   /* =========================================================
      THE ODDS API BACKGROUND SYNC
      ========================================================= */
   async function getOddsApiActiveSports() {
       try {
           const r = await axios.get('https://api.the-odds-api.com/v4/sports/', { params: { apiKey: ODDS_API_KEY }, timeout: 10000 });
           if (r.data && Array.isArray(r.data)) {
               // Block all outrights and winner markets to prevent the 400 errors
               return r.data
                   .filter(s => s.active && !s.key.includes('_outrights') && !s.key.includes('_winner'))
                   .map(s => s.key);
           }
       } catch (e) { console.error('Failed to fetch sports:', e.message); }
       return [];
   }
   
   async function fetchAndCacheLiveOdds() {
       try {
           console.log("🔄 Fetching odds from the-odds-api.com...");
           const activeSports = await getOddsApiActiveSports();
           const prioritySports = ['soccer_epl','soccer_uefa_champs_league','soccer_spain_la_liga','soccer_italy_serie_a','basketball_nba'];
           
           let sportsToFetch = [];
           for (const s of prioritySports) { if (activeSports.includes(s) && !sportsToFetch.includes(s)) sportsToFetch.push(s); }
           for (const s of activeSports) { if (!sportsToFetch.includes(s)) { sportsToFetch.push(s); if (sportsToFetch.length >= 10) break; } }
           
           if (sportsToFetch.length === 0) return console.error("❌ No active sports available");
   
           let allApiMatches = [];
           for (const sport of sportsToFetch) {
               try {
                   const response = await axios.get(`https://api.the-odds-api.com/v4/sports/${sport}/odds/`, {
                       params: { apiKey: ODDS_API_KEY, regions: 'eu,uk', markets: 'h2h', oddsFormat: 'decimal' }, timeout: 10000
                   });
                   if (response.data && Array.isArray(response.data)) allApiMatches = allApiMatches.concat(response.data);
               } catch (e) { } 
           }
   
           const uniqueMap = new Map();
           allApiMatches.forEach(m => { if (!uniqueMap.has(m.id)) uniqueMap.set(m.id, m); });
           
           const now = new Date(); let syncedCount = 0;
           for (const match of uniqueMap.values()) {
               const matchDate = new Date(match.commence_time);
               const diffMins = Math.floor((now - matchDate) / 60000);
               if (diffMins > 120) continue;
   
               let homeOdds = 0, drawOdds = 0, awayOdds = 0;
               if (match.bookmakers?.[0]?.markets?.[0]?.outcomes) {
                   const outcomes = match.bookmakers[0].markets[0].outcomes;
                   const outHome = outcomes.find(o => o.name === match.home_team);
                   const outAway = outcomes.find(o => o.name === match.away_team);
                   const outDraw = outcomes.find(o => o.name.toLowerCase() === 'draw');
                   if (outHome) homeOdds = parseFloat(outHome.price);
                   if (outAway) awayOdds = parseFloat(outAway.price);
                   if (outDraw) drawOdds = parseFloat(outDraw.price);
               }
               if (homeOdds < 1.05 || awayOdds < 1.05) continue;
   
               let mappedSport = 'soccer';
               if (match.sport_key.includes('basketball')) mappedSport = 'basketball';
               else if (match.sport_key.includes('tennis')) mappedSport = 'tennis';
   
               if (mappedSport === 'soccer' && !drawOdds) { 
                   drawOdds = parseFloat(((homeOdds + awayOdds) / 1.6).toFixed(2)); 
                   if (drawOdds < 2.5) drawOdds = 3.10; 
               }
   
               let cc = getCountryCodeFromSportKey(match.sport_key);
               if (/[^\x00-\x7F]/.test(cc) || cc.length > 3) {
                   cc = 'gb'; // Safety sanitize emoji flags
               }
   
               const status = diffMins >= 0 && diffMins <= 115 ? 'live' : 'upcoming';
   
               await Match.findOneAndUpdate(
                   { apiId: match.id },
                   { apiId: match.id, sport: mappedSport, league: match.sport_title || 'League', homeTeam: match.home_team, awayTeam: match.away_team, startTime: matchDate, isLive: status === 'live', status, country: cc, odds: { '1': homeOdds, 'X': drawOdds, '2': awayOdds }, oddsArr: [homeOdds, drawOdds, awayOdds], marketsCount: Math.floor(Math.random()*150)+50, featured: Math.random()>0.8 },
                   { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
               );
               syncedCount++;
           }
           console.log(`✅ Synced ${syncedCount} matches from The-Odds-API`);
       } catch (e) { console.error("🔥 Odds Fetch Error:", e.message); }
   }
   
   /* =========================================================
      GLOBAL ERROR HANDLER
      ========================================================= */
   app.use((err, req, res, next) => {
       console.error("🔥 EXPRESS ERROR:", err.stack);
       res.status(500).json({ success: false, message: "Internal server error." });
   });
   
   /* =========================================================
      START SERVER
      ========================================================= */
   mongoose.connect(MONGO_URI)
       .then(async () => {
           console.log('MongoDB connected');
           fetchAndCacheLiveOdds();
           setInterval(fetchAndCacheLiveOdds, 10 * 60 * 1000);
           app.listen(PORT, () => { 
               console.log(`BetWinn API running on port ${PORT}`); 
               console.log('✅ Route registered: GET /api/live-matches');
           });
       })
       .catch(err => { console.error('MongoDB connection failed:', err); process.exit(1); });