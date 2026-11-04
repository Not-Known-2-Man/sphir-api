/**
 * Sphir Local API — Node.js + Express + MySQL
 * Port: 3000
 *
 * Start:  npm start
 * Seed:   npm run seed
 */

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const mysql   = require('mysql2/promise');
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

// ── Database pool ─────────────────────────────────────────────────────────────

const pool = mysql.createPool({
  host:             process.env.DB_HOST     || 'localhost',
  user:             process.env.DB_USER     || 'root',
  password:         process.env.DB_PASSWORD || '',
  database:         process.env.DB_NAME     || 'sphir_local',
  waitForConnections: true,
  connectionLimit:  10,
});

// ── Auth middleware ───────────────────────────────────────────────────────────

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing Authorization header' });
    }

    const token  = authHeader.slice(7).trim();
    const uid    = req.headers['uid']    || '';

    // Guest bypass — uid field is optional for guests
    if (token === 'guest_token') {
      req.user = { id: null, uid: 'guest', first_name: 'Guest', last_name: '', is_guest: true };
      return next();
    }

    const [[user]] = await pool.query(
      'SELECT * FROM users WHERE token = ? AND uid = ?',
      [token, uid]
    );
    if (!user) return res.status(401).json({ error: 'Invalid or expired token' });

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseTags(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { /* fall through */ }
    return raw.split(',').map(t => t.trim()).filter(Boolean);
  }
  return [];
}

function formatBusiness(row) {
  return { ...row, tags: parseTags(row.tags) };
}

// ── Error handler ─────────────────────────────────────────────────────────────

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

// ═════════════════════════════════════════════════════════════════════════════
//  AUTH ENDPOINTS
// ═════════════════════════════════════════════════════════════════════════════

// POST /api/v1/auth/sign_in
app.post('/api/v1/auth/sign_in', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(422).json({ error: 'email and password are required' });
    }

    const [[user]] = await pool.query(
      'SELECT * FROM users WHERE email = ? AND is_guest = 0', [email]
    );
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const tokenToUse  = user.token  || uuidv4();
    const clientToUse = user.client || uuidv4();
    const uidToUse    = user.email;

    if (!user.token) {
      await pool.query(
        'UPDATE users SET token = ?, uid = ?, client = ? WHERE id = ?',
        [tokenToUse, uidToUse, clientToUse, user.id]
      );
    }

    res.json({
      token:      tokenToUse,
      uid:        uidToUse,
      client:     clientToUse,
      first_name: user.first_name,
      last_name:  user.last_name,
    });
  } catch (err) { next(err); }
});

// POST /api/v1/auth  AND  /api/v1/auth/sign_up  (sign-up)
async function handleSignUp(req, res, next) {
  try {
    const { email, password, password_confirmation,
            first_name, last_name, account_type, domain } = req.body;

    if (!email || !password) {
      return res.status(422).json({ error: 'email and password are required' });
    }
    if (password_confirmation && password !== password_confirmation) {
      return res.status(422).json({ error: 'Passwords do not match' });
    }

    const [[existing]] = await pool.query(
      'SELECT id FROM users WHERE email = ?', [email]
    );
    if (existing) return res.status(422).json({ error: 'Email already registered' });

    const hash   = await bcrypt.hash(password, 10);
    const token  = uuidv4();
    const client = uuidv4();
    const uid    = email;

    const [result] = await pool.query(
      'INSERT INTO users (email, password_hash, first_name, last_name, token, uid, client, is_guest) VALUES (?,?,?,?,?,?,?,0)',
      [email, hash, first_name || '', last_name || '', token, uid, client]
    );

    res.status(201).json({
      token,
      uid,
      client,
      first_name: first_name || '',
      last_name:  last_name  || '',
    });
  } catch (err) { next(err); }
}

app.post('/api/v1/auth',         handleSignUp);
app.post('/api/v1/auth/sign_up', handleSignUp);

// GET /api/v1/auth/guest  — returns a static guest token; no account needed
app.get('/api/v1/auth/guest', (_req, res) => {
  res.json({ token: 'guest_token', uid: 'guest', client: 'guest' });
});

// DELETE /api/v1/auth/sign_out
app.delete('/api/v1/auth/sign_out', authenticate, async (req, res, next) => {
  try {
    if (!req.user.is_guest) {
      await pool.query(
        'UPDATE users SET token = NULL, uid = NULL, client = NULL WHERE id = ?',
        [req.user.id]
      );
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  FOLDERS (Collections)
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/v1/folders
app.get('/api/v1/folders', authenticate, async (req, res, next) => {
  try {
    if (req.user.is_guest) return res.json([]);
    const [rows] = await pool.query(
      'SELECT * FROM folders WHERE user_id = ? ORDER BY created_at ASC',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/v1/folders
app.post('/api/v1/folders', authenticate, async (req, res, next) => {
  try {
    const { name, description = '', privacy = 'private' } = req.body;
    if (!name) return res.status(422).json({ error: 'name is required' });

    const userId = req.user.is_guest ? null : req.user.id;
    const [result] = await pool.query(
      'INSERT INTO folders (user_id, name, description, privacy) VALUES (?,?,?,?)',
      [userId, name, description, privacy]
    );
    const [[row]] = await pool.query('SELECT * FROM folders WHERE id = ?', [result.insertId]);
    res.status(201).json(row);
  } catch (err) { next(err); }
});

// PUT /api/v1/folders/:id
app.put('/api/v1/folders/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, description, privacy } = req.body;
    await pool.query(
      `UPDATE folders SET
         name        = COALESCE(?, name),
         description = COALESCE(?, description),
         privacy     = COALESCE(?, privacy)
       WHERE id = ? AND user_id = ?`,
      [name, description, privacy, id, req.user.id]
    );
    const [[row]] = await pool.query('SELECT * FROM folders WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Folder not found' });
    res.json(row);
  } catch (err) { next(err); }
});

// DELETE /api/v1/folders/:id
app.delete('/api/v1/folders/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query(
      'DELETE FROM folders WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Folder not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  BUSINESSES (Cards)
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/v1/users/get_businesses
app.get('/api/v1/users/get_businesses', authenticate, async (req, res, next) => {
  try {
    if (req.user.is_guest) return res.json([]);

    const page    = Math.max(1, parseInt(req.query.page    || '1',  10));
    const perPage = Math.min(100, parseInt(req.query.per_page || '50', 10));
    const offset  = (page - 1) * perPage;

    const [rows] = await pool.query(
      'SELECT * FROM businesses WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [req.user.id, perPage, offset]
    );
    res.json(rows.map(formatBusiness));
  } catch (err) { next(err); }
});

// POST /api/v1/businesses
app.post('/api/v1/businesses', authenticate, async (req, res, next) => {
  try {
    const { title, description = '', website = '', email = '',
            tags = [], folder_id = null } = req.body;
    if (!title) return res.status(422).json({ error: 'title is required' });

    const userId   = req.user.is_guest ? null : req.user.id;
    const tagsJson = JSON.stringify(parseTags(tags));

    const [result] = await pool.query(
      'INSERT INTO businesses (user_id, folder_id, title, description, website, email, tags) VALUES (?,?,?,?,?,?,?)',
      [userId, folder_id, title, description, website, email, tagsJson]
    );
    const [[row]] = await pool.query('SELECT * FROM businesses WHERE id = ?', [result.insertId]);
    res.status(201).json(formatBusiness(row));
  } catch (err) { next(err); }
});

// PUT /api/v1/businesses/:id
app.put('/api/v1/businesses/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, description, website, email, tags, folder_id } = req.body;
    const tagsJson = tags !== undefined ? JSON.stringify(parseTags(tags)) : undefined;

    await pool.query(
      `UPDATE businesses SET
         title       = COALESCE(?, title),
         description = COALESCE(?, description),
         website     = COALESCE(?, website),
         email       = COALESCE(?, email),
         tags        = COALESCE(?, tags),
         folder_id   = COALESCE(?, folder_id)
       WHERE id = ? AND user_id = ?`,
      [title, description, website, email, tagsJson, folder_id, id, req.user.id]
    );
    const [[row]] = await pool.query('SELECT * FROM businesses WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Business not found' });
    res.json(formatBusiness(row));
  } catch (err) { next(err); }
});

// DELETE /api/v1/businesses/:id
app.delete('/api/v1/businesses/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const [result] = await pool.query(
      'DELETE FROM businesses WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Business not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── URL Preview ───────────────────────────────────────────────────────────────

app.get('/api/v1/preview', async (req, res) => {
  try {
    const axios   = require('axios');
    const cheerio = require('cheerio');
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });
    const response = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 5000,
    });
    const $ = cheerio.load(response.data);
    res.json({
      title:       $('meta[property="og:title"]').attr('content')       || $('title').text()                                          || '',
      description: $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content')              || '',
      image:       $('meta[property="og:image"]').attr('content')       || '',
      url,
    });
  } catch (e) {
    res.status(422).json({ error: 'Could not fetch metadata' });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✓ Sphir API running on http://localhost:${PORT}`);
  console.log('  Endpoints:');
  console.log('    POST   /api/v1/auth/sign_in');
  console.log('    POST   /api/v1/auth  (sign_up)');
  console.log('    GET    /api/v1/auth/guest');
  console.log('    DELETE /api/v1/auth/sign_out');
  console.log('    GET    /api/v1/folders');
  console.log('    POST   /api/v1/folders');
  console.log('    PUT    /api/v1/folders/:id');
  console.log('    DELETE /api/v1/folders/:id');
  console.log('    GET    /api/v1/users/get_businesses');
  console.log('    POST   /api/v1/businesses');
  console.log('    PUT    /api/v1/businesses/:id');
  console.log('    DELETE /api/v1/businesses/:id');
});
