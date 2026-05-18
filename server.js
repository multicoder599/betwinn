/* =========================================================
   BETWINN SERVER.JS (Bulletproof Edition)
   Express + MongoDB + JWT + bcrypt + axios
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
   
   // CRITICAL FOR PRODUCTION: Tells Express it is behind a reverse proxy (Nginx). 
   app.set('trust proxy', 1);
   
   const PORT = process.env.PORT || 3012; 
   const JWT_SECRET = process.env.JWT_SECRET || 'betwinn_secret_key_2026';
   const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/betwinn';
   const API_URL = process.env.NODE_ENV === 'production' ? 'https://api.betwinn.co.ke/api' : `http://localhost:${PORT}/api`;
   const ODDS_API_KEY = process.env.ODDS_API_KEY || '581547add320d504f22fd7454a1140df';
   
   /* =========================================================
      MIDDLEWARE
      ========================================================= */
   app.use(helmet());
   
   app.use(cors({
       origin: [
           'https://betwinn.co.ke', 
           'https://www.betwinn.co.ke',
           'http://localhost:3012', 
           'http://127.0.0.1:3012'
       ],
       methods: ['GET', 'POST', 'PUT', 'DELETE'],
       credentials: true
   }));
   
   app.use(express.json({ limit: '10mb' }));
   
   const limiter = rateLimit({
       windowMs: 15 * 60 * 1000,
       max: 200,
       message: { success: false, message: 'Too many requests, please try again later.' }
   });
   app.use('/api/', limiter);
   
   const authLimiter = rateLimit({
       windowMs: 60 * 60 * 1000,
       max: 15,
       message: { success: false, message: 'Too many auth attempts, please try again later.' }
   });
   app.use('/api/auth/', authLimiter);
   
   /* =========================================================
      DATABASE MODELS
      ========================================================= */
   
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
   
   const matchSchema = new mongoose.Schema({
       apiId: { type: String, unique: true, sparse: true }, 
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
      HEALTH CHECK ROUTE
      ========================================================= */
   app.get('/api/health', (req, res) => {
       res.json({ success: true, message: "API is online and running smoothly!" });
   });
   
   /* =========================================================
      AUTH & USER ROUTES
      ========================================================= */
   app.post('/api/auth/register', async (req, res, next) => {
       try {
           const { name, email, phone, password } = req.body;
           if (!name || !phone || !password) return res.status(400).json({ success: false, message: 'Missing fields.' });
   
           const existingUser = await User.findOne({ $or: [{ phone }, { email }] });
           if (existingUser) return res.status(400).json({ success: false, message: 'User exists.' });
   
           const hashedPassword = await bcrypt.hash(password, 12);
           const user = new User({ name, email: email || `${phone}@betwinn.co.ke`, phone, password: hashedPassword });
           await user.save();
   
           const token = jwt.sign({ id: user._id, phone: user.phone }, JWT_SECRET, { expiresIn: '7d' });
           res.status(201).json({ success: true, token, user: { id: user._id, name: user.name, phone: user.phone, balance: user.balance } });
       } catch (err) { next(err); }
   });
   
   app.post('/api/auth/login', async (req, res, next) => {
       try {
           const { phone, password } = req.body;
           const user = await User.findOne({ phone });
           if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ success: false, message: 'Invalid credentials.' });
   
           const token = jwt.sign({ id: user._id, phone: user.phone }, JWT_SECRET, { expiresIn: '7d' });
           res.json({ success: true, token, user: { id: user._id, name: user.name, phone: user.phone, balance: user.balance } });
       } catch (err) { next(err); }
   });
   
   app.get('/api/user', authenticate, async (req, res) => {
       res.json({ success: true, user: { id: req.user._id, name: req.user.name, phone: req.user.phone, email: req.user.email, balance: req.user.balance, totalBets: req.user.totalBets } });
   });
   
   /* =========================================================
      SPORTS, MATCHES & MARKETS
      ========================================================= */
   app.get('/api/sports', async (req, res) => {
       const sports = [
           { id: 'soccer', name: 'Football', icon: 'fa-futbol', color: '#3b82f6' },
           { id: 'basketball', name: 'Basketball', icon: 'fa-basketball', color: '#f97316' },
           { id: 'tennis', name: 'Tennis', icon: 'fa-table-tennis-paddle-ball', color: '#22c55e' },
           { id: 'mma', name: 'MMA', icon: 'fa-hand-fist', color: '#6b7280' }
       ];
       res.json({ success: true, sports });
   });
   
   app.get('/api/competitions', async (req, res) => {
       const competitions = [
           { name: 'Premier League', flag: '🏴󠁧󠁢󠁥󠁮󠁧󠁿', league: 'Premier League' },
           { name: 'La Liga', flag: '🇪🇸', league: 'La Liga' },
           { name: 'NBA', flag: '🇺🇸', league: 'NBA' },
           { name: 'Champions League', flag: '🏆', league: 'UEFA Champions League', special: true }
       ];
       res.json({ success: true, competitions });
   });
   
   app.get('/api/matches', async (req, res, next) => {
       try {
           const { sport, league, status, search, page = 1, limit = 50 } = req.query;
           let query = {};
   
           if (sport) query.sport = sport;
           if (league) query.league = { $regex: league, $options: 'i' };
           if (status === 'live') query.isLive = true;
           
           if (search) {
               query.$or = [
                   { homeTeam: { $regex: search, $options: 'i' } },
                   { awayTeam: { $regex: search, $options: 'i' } },
                   { league: { $regex: search, $options: 'i' } }
               ];
           }
   
           const matches = await Match.find(query)
               .sort({ startTime: 1 })
               .limit(parseInt(limit))
               .skip((parseInt(page) - 1) * parseInt(limit));
   
           res.json({ success: true, matches, page: parseInt(page), total: await Match.countDocuments(query) });
       } catch (err) { next(err); }
   });
   
   app.get('/api/matches/featured', async (req, res, next) => {
       try {
           const matches = await Match.find({ featured: true, startTime: { $gte: new Date() } }).limit(10).sort({ startTime: 1 });
           res.json({ success: true, matches });
       } catch (err) { next(err); }
   });
   
   app.get('/api/match/:id/markets', async (req, res, next) => {
       try {
           const match = await Match.findById(req.params.id);
           if (!match) return res.status(404).json({ success: false, message: 'Match not found.' });
   
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
       } catch (err) { next(err); }
   });
   
   /* =========================================================
      BETTING & NOTIFICATIONS
      ========================================================= */
   app.get('/api/notifications', authenticate, async (req, res, next) => {
       try {
           const notifications = await Notification.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(20);
           res.json({ success: true, notifications });
       } catch (err) { next(err); }
   });
   
   app.post('/api/bets/place', authenticate, async (req, res, next) => {
       try {
           const { selections, stake, totalOdds, potentialWin } = req.body;
           if (!selections || !selections.length || !stake || !totalOdds) return res.status(400).json({ success: false, message: 'Invalid bet data.' });
           if (stake < 10) return res.status(400).json({ success: false, message: 'Minimum stake is KES 10.' });
           if (stake > req.user.balance) return res.status(400).json({ success: false, message: 'Insufficient balance.' });
   
           const bet = new Bet({ userId: req.user._id, selections, stake, totalOdds, potentialWin });
           await bet.save();
   
           req.user.balance -= stake;
           req.user.totalBets += 1;
           await req.user.save();
   
           res.json({ success: true, betId: bet._id, message: 'Bet placed successfully.', potentialWin });
       } catch (err) { next(err); }
   });
   
   app.get('/api/bets/my', authenticate, async (req, res, next) => {
       try {
           const bets = await Bet.find({ userId: req.user._id }).sort({ placedAt: -1 }).limit(50);
           res.json({ success: true, bets });
       } catch (err) { next(err); }
   });
   
   /* =========================================================
      THE ODDS API BACKGROUND SYNC
      ========================================================= */
   async function fetchAndCacheLiveOdds() {
       try {
           console.log("🔄 Fetching live odds from api.the-odds-api.com...");
           const sportsToFetch = [
               'soccer_epl', 'soccer_uefa_champs_league', 'soccer_spain_la_liga', 'soccer_italy_serie_a',
               'basketball_nba', 'tennis_atp', 'mma_mixed_martial_arts'
           ];
           
           let allApiMatches = [];
           
           for (const sport of sportsToFetch) {
               try {
                const response = await axios.get(`https://parlay-api.com/v4/sports/${sport}/odds?apiKey=${ODDS_API_KEY}&regions=us,eu,uk&markets=h2h,spreads`);
                   if (response.data && Array.isArray(response.data)) {
                       allApiMatches = allApiMatches.concat(response.data);
                   }
               } catch (e) {
                   // Improved Error Logging for the API
                   const apiErrorMsg = e.response?.data?.message || e.message;
                   console.error(`❌ Failed to fetch sport ${sport}:`, apiErrorMsg);
               }
           }
           
           const now = new Date();
           let syncedCount = 0;
   
           for (const match of allApiMatches) {
               const matchDate = new Date(match.commence_time);
               if (now.getTime() - matchDate.getTime() >= 0) continue; // Only process upcoming games
   
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
               if (match.sport_key.includes('mma') || match.sport_key.includes('ufc')) mappedSport = 'mma';
   
               // Fake a draw odds for soccer if the API didn't provide one
               if (mappedSport === 'soccer' && !drawOdds) {
                   drawOdds = parseFloat(((homeOdds + awayOdds) / 1.6).toFixed(2));
                   if (drawOdds < 2.5) drawOdds = 3.10;
               }
   
               // Sync with BetWinn Match Schema
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
                       odds: {
                           '1': parseFloat(homeOdds) || 0,
                           'X': parseFloat(drawOdds) || 0,
                           '2': parseFloat(awayOdds) || 0
                       },
                       marketsCount: Math.floor(Math.random() * 150) + 50, 
                       featured: Math.random() > 0.8
                   },
                   { upsert: true, new: true, setDefaultsOnInsert: true }
               );
               syncedCount++;
           }
   
           console.log(`✅ Synced ${syncedCount} upcoming matches from The Odds API to MongoDB`);
       } catch (e) {
           console.error("🔥 Master Odds Fetch Error:", e.message);
       }
   }
   
   /* =========================================================
      GLOBAL ERROR HANDLER (Catches silent crashes)
      ========================================================= */
   app.use((err, req, res, next) => {
       console.error("🔥 FATAL EXPRESS ERROR:", err.stack);
       res.status(500).json({ 
           success: false, 
           message: "Server crashed internally.", 
           error_details: err.message 
       });
   });
   
   /* =========================================================
      START SERVER
      ========================================================= */
   mongoose.connect(MONGO_URI)
       .then(() => {
           console.log('MongoDB connected');
           
           // Trigger API sync immediately on startup, then every 30 minutes
           fetchAndCacheLiveOdds();
           setInterval(fetchAndCacheLiveOdds, 30 * 60 * 1000); 
   
           app.listen(PORT, () => {
               console.log(`BetWinn API running on port ${PORT}`);
               console.log(`API Base: ${API_URL}`);
           });
       })
       .catch(err => {
           console.error('MongoDB connection failed:', err);
           process.exit(1);
       });