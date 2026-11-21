/**
 * Sphir Local API — Node.js + Express + PostgreSQL
 * Port: 3000
 *
 * Start:  npm start
 * Seed:   npm run seed
 */

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const dns     = require('dns');
const http    = require('http');
const https   = require('https');
const net     = require('net');
const { extractMetadata } = require('./lib/extractMetadata');
const { mapOembed } = require('./lib/oembed');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────

app.use(cors());
// POST /api/v1/preview carries a page's HTML, so it gets its own larger body limit.
const jsonBody = express.json();
const previewBody = express.json({ limit: '2mb' });
app.use((req, res, next) => (req.path === '/api/v1/preview' ? previewBody : jsonBody)(req, res, next));

app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

// ── Database pool ─────────────────────────────────────────────────────────────

// DATABASE_URL wins (Render); otherwise the discrete DB_* variables are used.
const pool = new Pool(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, max: 10 }
  : {
      host:     process.env.DB_HOST     || 'localhost',
      user:     process.env.DB_USER     || process.env.USER,
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME     || 'sphir_dev',
      max:      10,
    });

// Lets queries keep MySQL-style `?` placeholders; they become $1, $2, ...
function query(sql, params = []) {
  let i = 0;
  return pool.query(sql.replace(/\?/g, () => `$${++i}`), params);
}

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

    const { rows: [user] } = await query(
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

// Guests share one public token, so they may read (empty lists) but never write.
function requireUser(req, res, next) {
  if (req.user.is_guest) {
    return res.status(403).json({ error: 'Sign up to save Sphirs and cards' });
  }
  next();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const MAX_INT4 = 2147483647;

function isValidId(value) {
  const s = String(value);
  return /^[1-9]\d*$/.test(s) && Number(s) <= MAX_INT4;
}

// Absent or empty folder_id means "no folder"; anything else must be a folder the user owns.
async function folderAllowed(folderId, userId) {
  if (folderId === undefined || folderId === null || folderId === '') return true;
  if (!isValidId(folderId)) return false;
  const { rows } = await query(
    'SELECT 1 FROM folders WHERE id = ? AND user_id = ?', [folderId, userId]
  );
  return rows.length > 0;
}

// Only http(s) image URLs are stored; anything else becomes '' (no image).
function sanitizeImageUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2000) return '';
  try {
    const { protocol } = new URL(raw);
    return protocol === 'http:' || protocol === 'https:' ? raw : '';
  } catch {
    return '';
  }
}

function parseTags(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { /* fall through */ }
    return raw.split(',').map(t => t.trim()).filter(Boolean);
  }
  return [];
}

// Display price such as "$29.99"; anything that is not a string is dropped.
function sanitizePrice(raw) {
  return typeof raw === 'string' ? raw.trim().slice(0, 50) : '';
}

// folder_ids lists every collection of the card: the primary folder_id first, then the extras.
function formatBusiness(row) {
  const { extra_folder_ids, ...rest } = row;
  const extras = (extra_folder_ids || []).filter(id => id !== row.folder_id);
  return {
    ...rest,
    tags: parseTags(row.tags),
    folder_ids: row.folder_id ? [row.folder_id, ...extras] : extras,
  };
}

const BUSINESS_SELECT = `SELECT b.*, COALESCE(
    (SELECT array_agg(bf.folder_id ORDER BY bf.position) FROM business_folders bf WHERE bf.business_id = b.id),
    '{}') AS extra_folder_ids
  FROM businesses b`;

async function loadBusiness(id, userId) {
  const { rows: [row] } = await query(`${BUSINESS_SELECT} WHERE b.id = ? AND b.user_id = ?`, [id, userId]);
  return row && formatBusiness(row);
}

// Non-numeric or out-of-range ids can never match a row; answer 404 instead of a pg error.
app.param('id', (req, res, next, id) => {
  if (!isValidId(id)) return res.status(404).json({ error: 'Not found' });
  next();
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

    const { rows: [user] } = await query(
      'SELECT * FROM users WHERE email = ? AND is_guest = false', [email]
    );
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const tokenToUse  = user.token  || uuidv4();
    const clientToUse = user.client || uuidv4();
    const uidToUse    = user.email;

    if (!user.token) {
      await query(
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

    const { rows: [existing] } = await query(
      'SELECT id FROM users WHERE email = ?', [email]
    );
    if (existing) return res.status(422).json({ error: 'Email already registered' });

    const hash   = await bcrypt.hash(password, 10);
    const token  = uuidv4();
    const client = uuidv4();
    const uid    = email;

    await query(
      'INSERT INTO users (email, password_hash, first_name, last_name, token, uid, client, is_guest) VALUES (?,?,?,?,?,?,?,false)',
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
      await query(
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
    const { rows } = await query(
      'SELECT * FROM folders WHERE user_id = ? ORDER BY created_at ASC, id ASC',
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/v1/folders
app.post('/api/v1/folders', authenticate, requireUser, async (req, res, next) => {
  try {
    const { name, description = '', privacy = 'private' } = req.body;
    if (!name) return res.status(422).json({ error: 'name is required' });

    const { rows: [row] } = await query(
      'INSERT INTO folders (user_id, name, description, privacy) VALUES (?,?,?,?) RETURNING *',
      [req.user.id, name, description, privacy]
    );
    res.status(201).json(row);
  } catch (err) { next(err); }
});

// PUT /api/v1/folders/:id
app.put('/api/v1/folders/:id', authenticate, requireUser, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { name, description, privacy } = req.body;
    await query(
      `UPDATE folders SET
         name        = COALESCE(?, name),
         description = COALESCE(?, description),
         privacy     = COALESCE(?, privacy)
       WHERE id = ? AND user_id = ?`,
      [name, description, privacy, id, req.user.id]
    );
    const { rows: [row] } = await query(
      'SELECT * FROM folders WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );
    if (!row) return res.status(404).json({ error: 'Folder not found' });
    res.json(row);
  } catch (err) { next(err); }
});

// DELETE /api/v1/folders/:id
app.delete('/api/v1/folders/:id', authenticate, requireUser, async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query(
      'DELETE FROM folders WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Folder not found' });
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

    const { rows } = await query(
      `${BUSINESS_SELECT} WHERE b.user_id = ? ORDER BY b.created_at DESC, b.id DESC LIMIT ? OFFSET ?`,
      [req.user.id, perPage, offset]
    );
    res.json(rows.map(formatBusiness));
  } catch (err) { next(err); }
});

// POST /api/v1/businesses
app.post('/api/v1/businesses', authenticate, requireUser, async (req, res, next) => {
  try {
    const { title, description = '', website = '', email = '',
            tags = [], folder_id = null, og_image, price } = req.body;
    if (!title) return res.status(422).json({ error: 'title is required' });
    if (!(await folderAllowed(folder_id, req.user.id))) {
      return res.status(422).json({ error: 'Folder not found' });
    }

    const tagsJson = JSON.stringify(parseTags(tags));

    const { rows: [row] } = await query(
      'INSERT INTO businesses (user_id, folder_id, title, description, website, email, tags, og_image, price) VALUES (?,?,?,?,?,?,?,?,?) RETURNING *',
      [req.user.id, folder_id || null, title, description, website, email, tagsJson, sanitizeImageUrl(og_image), sanitizePrice(price)]
    );
    res.status(201).json(formatBusiness(row));
  } catch (err) { next(err); }
});

// PUT /api/v1/businesses/:id
app.put('/api/v1/businesses/:id', authenticate, requireUser, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { title, description, website, email, tags, folder_id, og_image, price } = req.body;
    if (!(await folderAllowed(folder_id, req.user.id))) {
      return res.status(422).json({ error: 'Folder not found' });
    }
    const tagsJson = tags !== undefined ? JSON.stringify(parseTags(tags)) : undefined;
    // undefined keeps the stored image; '' (or an invalid URL) removes it.
    const ogImage  = og_image !== undefined ? sanitizeImageUrl(og_image) : undefined;
    const priceVal = price !== undefined ? sanitizePrice(price) : undefined;

    await query(
      `UPDATE businesses SET
         title       = COALESCE(?, title),
         description = COALESCE(?, description),
         website     = COALESCE(?, website),
         email       = COALESCE(?, email),
         tags        = COALESCE(?, tags),
         folder_id   = COALESCE(?, folder_id),
         og_image    = COALESCE(?, og_image),
         price       = COALESCE(?, price)
       WHERE id = ? AND user_id = ?`,
      [title, description, website, email, tagsJson, folder_id || null, ogImage, priceVal, id, req.user.id]
    );
    const card = await loadBusiness(id, req.user.id);
    if (!card) return res.status(404).json({ error: 'Business not found' });
    res.json(card);
  } catch (err) { next(err); }
});

// PUT /api/v1/businesses/:id/folders  { folder_ids: [primary, ...extras] }
// Replaces every collection of the card in one transaction; [] removes it from all of them.
app.put('/api/v1/businesses/:id/folders', authenticate, requireUser, async (req, res, next) => {
  const { id } = req.params;
  const raw = req.body?.folder_ids;
  if (!Array.isArray(raw) || raw.length > 50 || !raw.every(isValidId)) {
    return res.status(422).json({ error: 'folder_ids must be a list of folder ids' });
  }
  const folderIds = [...new Set(raw.map(Number))];
  let client;
  try {
    client = await pool.connect();
    const { rows: owned } = await client.query(
      'SELECT id FROM folders WHERE user_id = $1 AND id = ANY($2::int[])', [req.user.id, folderIds]
    );
    if (owned.length !== folderIds.length) return res.status(422).json({ error: 'Folder not found' });

    await client.query('BEGIN');
    const updated = await client.query(
      'UPDATE businesses SET folder_id = $1 WHERE id = $2 AND user_id = $3', [folderIds[0] ?? null, id, req.user.id]
    );
    if (!updated.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Business not found' });
    }
    await client.query('DELETE FROM business_folders WHERE business_id = $1', [id]);
    for (const [position, folderId] of folderIds.slice(1).entries()) {
      await client.query(
        'INSERT INTO business_folders (business_id, folder_id, position) VALUES ($1, $2, $3)', [id, folderId, position]
      );
    }
    await client.query('COMMIT');
    res.json(await loadBusiness(id, req.user.id));
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client?.release();
  }
});

// DELETE /api/v1/businesses/:id
app.delete('/api/v1/businesses/:id', authenticate, requireUser, async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await query(
      'DELETE FROM businesses WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );
    if (!result.rowCount) return res.status(404).json({ error: 'Business not found' });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── URL Preview ───────────────────────────────────────────────────────────────

// The server must never fetch its own network: loopback, private, link-local
// (cloud metadata), CGNAT, multicast and reserved ranges are refused.
const blockedAddresses = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blockedAddresses.addSubnet(addr, prefix, 'ipv4');
for (const [addr, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96],
]) blockedAddresses.addSubnet(addr, prefix, 'ipv6');

function isBlockedAddress(address) {
  const ip = address.replace(/^\[|\]$/g, '');
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return blockedAddresses.check(mapped[1], 'ipv4');
  if (net.isIPv4(ip)) return blockedAddresses.check(ip, 'ipv4');
  if (net.isIPv6(ip)) return blockedAddresses.check(ip, 'ipv6');
  return false;
}

// Checks the resolved address at connect time, so DNS rebinding cannot slip past.
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const list = Array.isArray(address) ? address : [{ address }];
    if (list.some(a => isBlockedAddress(a.address))) {
      return callback(Object.assign(new Error('Blocked address'), { code: 'EBLOCKED' }));
    }
    callback(null, address, family);
  });
}

// IP-literal hosts skip DNS lookup, so they are checked directly (also on each redirect).
function assertPublicUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported protocol');
  if (isBlockedAddress(parsed.hostname)) throw new Error('Blocked address');
  return parsed;
}

const previewAgents = {
  httpAgent:  new http.Agent({ lookup: safeLookup }),
  httpsAgent: new https.Agent({ lookup: safeLookup }),
};

app.get('/api/v1/preview', authenticate, requireUser, async (req, res) => {
  try {
    const axios   = require('axios');
    const { url } = req.query;
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL required' });
    assertPublicUrl(url);
    const limits = {
      ...previewAgents,
      timeout: 5000,
      maxRedirects: 3,
      maxContentLength: 2 * 1024 * 1024,
      beforeRedirect: (options) => {
        assertPublicUrl(`${options.protocol}//${options.hostname}`);
      },
    };
    const host = new URL(url).hostname.toLowerCase();
    const isYouTube = ['youtube.com', 'youtu.be'].some(d => host === d || host.endsWith(`.${d}`));
    const isInstagram = host === 'instagram.com' || host.endsWith('.instagram.com');
    let meta = null;
    try {
      const response = await axios.get(url, {
        ...limits,
        headers: { 'User-Agent': isInstagram ? 'facebookexternalhit/1.1' : 'Mozilla/5.0' },
      });
      const finalUrl = response.request?.res?.responseUrl || url;
      meta = extractMetadata(typeof response.data === 'string' ? response.data : '', finalUrl);
    } catch (e) {
      if (!isYouTube) throw e;
      console.warn(`[preview] page fetch failed: ${e.response?.status || e.code || e.message}`);
    }
    // YouTube blocks every youtube.com request from Render (page and oEmbed), so the public
    // noembed.com proxy of the same oEmbed data is the last resort.
    if (isYouTube && (!meta || !meta.title)) {
      for (const endpoint of ['https://www.youtube.com/oembed', 'https://noembed.com/embed']) {
        try {
          const oembed = await axios.get(endpoint, {
            ...limits,
            params: { url, format: 'json' },
            headers: { 'User-Agent': 'Mozilla/5.0' },
          });
          meta = mapOembed(oembed.data, url);
        } catch (err) {
          console.warn(`[preview] ${endpoint} failed: ${err.response?.status || err.code || err.message}`);
          meta = null;
        }
        if (meta?.title) break;
      }
      if (!meta?.title) throw new Error('Empty oEmbed');
    }
    res.json(meta);
  } catch (e) {
    console.warn(`[preview] GET ${req.query.url} failed: ${e.response?.status || e.code || e.message}`);
    res.status(422).json({ error: 'Could not fetch metadata' });
  }
});

// The iOS share extension already has the page the user is looking at (including sites that
// block server fetches), so it sends the HTML and the server only extracts; nothing is fetched.
app.post('/api/v1/preview', authenticate, requireUser, (req, res) => {
  const { url, html } = req.body || {};
  if (!url || typeof url !== 'string' || typeof html !== 'string') {
    return res.status(400).json({ error: 'URL and HTML required' });
  }
  try {
    assertPublicUrl(url);
    res.json(extractMetadata(html, url));
  } catch (e) {
    res.status(422).json({ error: 'Could not fetch metadata' });
  }
});

// ── Error handler ─────────────────────────────────────────────────────────────

// Registered after every route so next(err) reaches it; details stay in the logs.
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ──────────────────────────────────────────────────────────────────────

// Additive, idempotent migrations run before accepting traffic. If they fail the
// process exits, so Render keeps the previous deploy live.
// An advisory lock serializes instances that start at the same time during a deploy.
const MIGRATION_LOCK = 734011;

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query("ALTER TABLE businesses ADD COLUMN IF NOT EXISTS og_image TEXT NOT NULL DEFAULT ''");
    await client.query("ALTER TABLE businesses ADD COLUMN IF NOT EXISTS price TEXT NOT NULL DEFAULT ''");
    // Extra collections of a card; the primary one stays in businesses.folder_id.
    await client.query(`CREATE TABLE IF NOT EXISTS business_folders (
      business_id INT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      folder_id   INT NOT NULL REFERENCES folders(id)    ON DELETE CASCADE,
      position    INT NOT NULL DEFAULT 0,
      PRIMARY KEY (business_id, folder_id)
    )`);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

module.exports = { app, migrate, pool };

if (require.main === module) migrate().then(() => app.listen(PORT, () => {
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
  console.log('    PUT    /api/v1/businesses/:id/folders');
  console.log('    GET    /api/v1/preview');
  console.log('    POST   /api/v1/preview');
})).catch((err) => {
  console.error('Startup migration failed:', err);
  process.exit(1);
});
