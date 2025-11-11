// server.js
const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const helmet = require('helmet');
const cors = require('cors');
const app = express();
app.use(helmet());
app.use(cors()); // In production set to your origin instead of "*"
app.use(bodyParser.json({ limit: '250kb' }));

// Simple DB
const db = new sqlite3.Database('./leaderboard.db');
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    score INTEGER,
    runMs INTEGER,
    eventsCount INTEGER,
    ip TEXT,
    createdAt INTEGER
  )`);
});

// Basic in-memory rate limiter (per IP)
const ipCounter = {};
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 6;
function checkRateLimit(ip) {
  const now = Date.now();
  if (!ipCounter[ip]) ipCounter[ip] = [];
  ipCounter[ip] = ipCounter[ip].filter(ts => ts > now - RATE_LIMIT_WINDOW_MS);
  if (ipCounter[ip].length >= RATE_LIMIT_MAX) return false;
  ipCounter[ip].push(now);
  return true;
}

function isValidName(name){
  if(!name || typeof name !== 'string') return false;
  name = name.trim();
  if(name.length < 2 || name.length > 20) return false;
  return /^[A-Za-z0-9_\- ]{2,20}$/.test(name);
}

function plausibilityCheck(claimedScore, runMs, events){
  if (runMs < 500) return { ok:false, reason:'run too short' };
  if (runMs > 1000 * 60 * 60) return { ok:false, reason:'run too long' };
  if (!Array.isArray(events)) return { ok:false, reason:'invalid events' };
  if (events.length > 2000) return { ok:false, reason:'too many events' };

  let lastT = 0;
  let moves = 0;
  for (const ev of events) {
    if (!ev || typeof ev.t !== 'number') return { ok:false, reason:'bad event format' };
    if (ev.t < lastT) return { ok:false, reason:'events timestamps not monotonic' };
    lastT = ev.t;
    if (ev.type === 'move') moves++;
  }
  const secs = Math.max(0.001, runMs / 1000);
  const movesPerSec = moves / secs;
  if (movesPerSec > 12) return { ok:false, reason:'too many moves per second' };

  const maxEntities = Math.ceil(runMs / 200);
  const maxPossibleScore = maxEntities * 5;
  if (claimedScore < 0 || claimedScore > maxPossibleScore * 2) {
    return { ok:false, reason:'score implausible' };
  }
  return { ok:true, debug:{movesPerSec, maxEntities, maxPossibleScore} };
}

// Submit endpoint
app.post('/api/submit', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
  if (!checkRateLimit(ip)) return res.status(429).json({ error:'rate_limited' });

  const { name, claimedScore, runMs, events } = req.body;
  if (!isValidName(name)) return res.status(400).json({ error:'bad_name' });
  if (typeof claimedScore !== 'number' || typeof runMs !== 'number') return res.status(400).json({ error:'bad_payload' });

  const p = plausibilityCheck(claimedScore, runMs, events);
  if (!p.ok) return res.status(400).json({ error:'plausibility_failed', reason:p.reason, debug:p.debug });

  const now = Date.now();
  db.run(`INSERT INTO scores(name,score,runMs,eventsCount,ip,createdAt) VALUES(?,?,?,?,?,?)`,
    [name.trim(), Math.floor(claimedScore), Math.floor(runMs), Array.isArray(events) ? events.length : 0, ip, now],
    function(err){
      if (err) return res.status(500).json({ error:'db' });
      return res.json({ ok:true, id:this.lastID });
    }
  );
});

// Leaderboard
app.get('/api/leaderboard', (req, res) => {
  const limit = Math.min(50, Math.max(5, parseInt(req.query.limit || '10', 10)));
  db.all(`SELECT name,score,runMs,createdAt FROM scores ORDER BY score DESC, createdAt ASC LIMIT ?`, [limit], (err, rows) => {
    if (err) return res.status(500).json({ error:'db' });
    res.json({ rows });
  });
});

app.get('/api/ping', (req,res)=>res.json({ok:true}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log('listening', PORT));
