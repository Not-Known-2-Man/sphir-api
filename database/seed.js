/**
 * Seed script — run once after schema.sql:
 *   node database/seed.js
 *
 * Creates the test user and sample data. Safe to re-run: existing seed
 * data is cleared first so counts stay predictable.
 */

require('dotenv').config();

const mysql    = require('mysql2/promise');
const bcrypt   = require('bcryptjs');

const DB = {
  host:             process.env.DB_HOST     || 'localhost',
  user:             process.env.DB_USER     || 'root',
  password:         process.env.DB_PASSWORD || '',
  database:         process.env.DB_NAME     || 'sphir_local',
  multipleStatements: true,
};

async function seed() {
  const conn = await mysql.createConnection(DB);

  // ── Test user ────────────────────────────────────────────────────────────
  const EMAIL    = process.env.SEED_EMAIL;
  const PASSWORD = process.env.SEED_PASSWORD;
  if (!EMAIL || !PASSWORD) {
    throw new Error('Set SEED_EMAIL and SEED_PASSWORD before running the seed');
  }

  const hash = await bcrypt.hash(PASSWORD, 10);

  const [[existing]] = await conn.query(
    'SELECT id FROM users WHERE email = ?', [EMAIL]
  );

  let userId;
  if (existing) {
    userId = existing.id;
    await conn.query(
      'UPDATE users SET password_hash=?, first_name=?, last_name=?, uid=? WHERE id=?',
      [hash, 'Saul', 'Alejandro', EMAIL, userId]
    );
    console.log('✓ Updated test user (id=%d)', userId);
  } else {
    const [r] = await conn.query(
      'INSERT INTO users (email, password_hash, first_name, last_name, uid, is_guest) VALUES (?,?,?,?,?,0)',
      [EMAIL, hash, 'Saul', 'Alejandro', EMAIL]
    );
    userId = r.insertId;
    console.log('✓ Created test user (id=%d)', userId);
  }

  // ── Clear previous seed data ─────────────────────────────────────────────
  await conn.query('DELETE FROM businesses WHERE user_id=?', [userId]);
  await conn.query('DELETE FROM folders    WHERE user_id=?', [userId]);

  // ── Folders ───────────────────────────────────────────────────────────────
  const FOLDERS = [
    { name: 'Reading List', description: 'Articles and posts saved for later.', privacy: 'private'     },
    { name: 'Inspiration',  description: 'Things that spark creativity.',        privacy: 'private'     },
    { name: 'Work Assets',  description: 'Resources for work.',                  privacy: 'connections' },
    { name: 'Mood Board',   description: 'Visual inspiration.',                  privacy: 'public'      },
  ];

  const folderIds = [];
  for (const f of FOLDERS) {
    const [r] = await conn.query(
      'INSERT INTO folders (user_id, name, description, privacy) VALUES (?,?,?,?)',
      [userId, f.name, f.description, f.privacy]
    );
    folderIds.push(r.insertId);
  }
  console.log('✓ Created %d folders', folderIds.length);

  // ── Businesses (3 per folder) ────────────────────────────────────────────
  const BUSINESSES = [
    // Reading List
    [folderIds[0], 'The Pragmatic Programmer', 'Timeless software engineering book.',   'https://pragprog.com',          ['books','programming']],
    [folderIds[0], 'Hacker News',              'Tech news and community discussions.',  'https://news.ycombinator.com',  ['tech','news']],
    [folderIds[0], 'Stripe Blog',              'Engineering and product deep-dives.',   'https://stripe.com/blog',       ['engineering','fintech']],
    // Inspiration
    [folderIds[1], 'Dribbble',  'Design inspiration community.',  'https://dribbble.com',  ['design','ux']],
    [folderIds[1], 'Awwwards',  'Award-winning web design.',      'https://awwwards.com',  ['design','web']],
    [folderIds[1], 'Behance',   'Creative work showcase.',        'https://behance.net',   ['design','portfolio']],
    // Work Assets
    [folderIds[2], 'Figma',   'Collaborative design tool.',  'https://figma.com',  ['design','tools']],
    [folderIds[2], 'Linear',  'Issue tracking for teams.',   'https://linear.app', ['productivity','tools']],
    [folderIds[2], 'Notion',  'All-in-one workspace.',       'https://notion.so',  ['productivity','notes']],
    // Mood Board
    [folderIds[3], 'Unsplash', 'Free high-quality photos.',       'https://unsplash.com', ['photography','free']],
    [folderIds[3], 'Are.na',   'Visual research platform.',       'https://are.na',       ['inspiration','visual']],
    [folderIds[3], 'Coolors',  'Color palette generator.',        'https://coolors.co',   ['design','color']],
  ];

  for (const [folderId, title, description, website, tags] of BUSINESSES) {
    await conn.query(
      'INSERT INTO businesses (user_id, folder_id, title, description, website, tags) VALUES (?,?,?,?,?,?)',
      [userId, folderId, title, description, website, JSON.stringify(tags)]
    );
  }
  console.log('✓ Created %d businesses', BUSINESSES.length);

  await conn.end();
  console.log('\n✓ Seed complete!');
  console.log('  Email:    %s', EMAIL);
}

seed().catch(err => { console.error(err); process.exit(1); });
