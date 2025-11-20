// server.js - Postgres-backed leaderboard with plausibility checks
// Usage: set process.env.DATABASE_URL to your Supabase / Postgres connection string
// Example: postgresql://postgres:YOUR_PASS@db.xxxx.supabase.co:5432/postgres

const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const cors = require('cors');
const { Pool } = require('pg');
const { URL } = require('url');

const app = express();
app.use(helmet());
// In production set cors origin to your domain; wildcard used here for simplicity
app.use(cors());
app.use(bodyParser.json({ limit: '250kb' }));

// Read and parse DATABASE_URL, create pg Pool forcing IPv4 to avoid ENETUNREACH IPv6 issues
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('ERROR: DATABASE_URL env var is not set');
  process.exit(1);
}

let pool;
try {
  const u = new URL(connectionString);
  const user = decodeURIComponent(u.username || '');
  const password = decodeURIComponent(u.password || '');
  const host = u.hostname;
  const port = u.port ? parseInt(u.port, 10) : 5432;
  const database = u.pathname ? u.pathname.replace(/^\//, '') : 'postgres';

  // Build config object for Pool. Using ssl.rejectUnauthorized=false for hosted DBs like Supabase.
  const poolConfig = {
    host,
    port,
    user,
    password,
    database,
    ssl: { rejectUnauthorized: false },
    // Hint to prefer IPv4 (helps avoid ENETUNREACH when environment doesn't support IPv6)
    family: 4,
    // keep connectionString for compatibility
    connectionString
  };

  pool = new Pool(poolConfig);

  // Optional: log pool errors
  pool.on('error', (err) => {
    console.error('Unexpected pg pool error', err);
  });

} catch (err) {
  console.error('Failed to create DB pool from connection string', err);
  process.exit(1);
}

// Initialize DB (create table if missing)
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS scores (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        score INTEGER NOT NULL,
        runMs INTEGER NOT NULL,
        eventsCount INTEGER NOT NULL,
        ip TEXT,
        createdAt BIGINT NOT NULL
      );
    `);
    console.log('DB initialized (table ready)');
  } catch (err) {
    console.error('Failed to init DB:', err);
    process.exit(1);
  }
})();

// Rate limiter (per IP)
const ipCounter = {};
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 6;
function checkRateLimit(ip) {
  const now = Date.now();
  if (!ipCounter[ip]) ipCounter[ip] = [];
  // keep timestamps only within window
  ipCounter[ip] = ipCounter[ip].filter(ts => ts > now - RATE_LIMIT_WINDOW_MS);
  if (ipCounter[ip].length >= RATE_LIMIT_MAX) return false;
  ipCounter[ip].push(now);
  return true;
}

function isValidName(name){
  if (!name || typeof name !== 'string') return false;
  name = name.trim();
  if (name.length < 2 || name.length > 20) return false;
  // allow letters, numbers, spaces, underscore and hyphen
  return /^[A-Za-z0-9_\- ]{2,20}$/.test(name);
}

// Plausibility check - same rules as before
function plausibilityCheck(claimedScore, runMs, events){
  if (typeof runMs !== 'number' || isNaN(runMs)) return { ok:false, reason:'bad runMs' };
  if (runMs < 500) return { ok:false, reason:'run too short' };
  if (runMs > 1000 * 60 * 60) return { ok:false, reason:'run too long' };
  if (!Array.isArray(events)) return { ok:false, reason:'invalid events' };
  if (events.length > 2000) return { ok:false, reason:'too many events' };

  let lastT = -1;
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

  // estimate maximum entities that could have been spawned (approx)
  const maxEntities = Math.ceil(runMs / 200);
  const maxPossibleScore = maxEntities * 5; // each entity maximum 5
  // allow a small multiplier to account for any legit differences
  if (typeof claimedScore !== 'number' || claimedScore < 0 || claimedScore > maxPossibleScore * 2) {
    return { ok:false, reason:'score implausible', debug:{claimedScore, maxEntities, maxPossibleScore} };
  }

  return { ok:true, debug:{movesPerSec, maxEntities, maxPossibleScore} };
}

// Helpers
function getIp(req){
  return (req.headers['x-forwarded-for'] || req.ip || 'unknown').toString();
}

// Submit endpoint
app.post('/api/submit', async (req, res) => {
  try {
    const ip = getIp(req);
    if (!checkRateLimit(ip)) return res.status(429).json({ error:'rate_limited' });

    const { name, claimedScore, runMs, events } = req.body;
    if (!isValidName(name)) return res.status(400).json({ error:'bad_name' });
    if (typeof claimedScore !== 'number' || typeof runMs !== 'number') return res.status(400).json({ error:'bad_payload' });

    const p = plausibilityCheck(claimedScore, runMs, events);
    if (!p.ok) return res.status(400).json({ error:'plausibility_failed', reason:p.reason, debug:p.debug });

    const now = Date.now();
    const result = await pool.query(
      `INSERT INTO scores (name, score, runMs, eventsCount, ip, createdAt)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [name.trim(), Math.floor(claimedScore), Math.floor(runMs), Array.isArray(events) ? events.length : 0, ip, now]
    );

    return res.json({ ok:true, id: result.rows[0].id });
  } catch (err) {
    console.error('Submit error', err);
    return res.status(500).json({ error:'server_error' });
  }
});

// Leaderboard endpoint
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = Math.min(50, Math.max(5, parseInt(req.query.limit || '10', 10)));
    const q = await pool.query(
      `SELECT name, score, runMs, createdAt FROM scores
       ORDER BY score DESC, createdAt ASC LIMIT $1`,
      [limit]
    );
    res.json({ rows: q.rows });
  } catch (err) {
    console.error('Leaderboard error', err);
    res.status(500).json({ error:'db' });
  }
});

app.get('/api/ping', (req, res) => res.json({ ok:true }));

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('listening', PORT));
