/**
 * One-off copy of the legacy MySQL data into PostgreSQL, keeping ids.
 *
 *   MySQL source:    DB_HOST / DB_USER / DB_PASSWORD / DB_NAME (from .env)
 *   Postgres target: TARGET_DATABASE_URL (schema.sql must already be applied)
 *
 *   TARGET_DATABASE_URL=postgres://... node database/migrate-from-mysql.js
 *
 * Refuses to run when the target already has users, so it never overwrites data.
 */

require('dotenv').config();

const mysql      = require('mysql2/promise');
const { Client } = require('pg');

const TABLES = {
  users:      ['id', 'email', 'password_hash', 'first_name', 'last_name', 'token', 'uid', 'client', 'is_guest', 'created_at'],
  folders:    ['id', 'user_id', 'name', 'description', 'privacy', 'created_at'],
  businesses: ['id', 'user_id', 'folder_id', 'title', 'description', 'website', 'email', 'tags', 'created_at'],
};

async function migrate() {
  if (!process.env.TARGET_DATABASE_URL) throw new Error('Set TARGET_DATABASE_URL');

  const source = await mysql.createConnection({
    host:     process.env.DB_HOST     || 'localhost',
    user:     process.env.DB_USER     || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME     || 'sphir_local',
  });
  const target = new Client({ connectionString: process.env.TARGET_DATABASE_URL });
  await target.connect();

  const { rows: [{ count }] } = await target.query('SELECT count(*)::int AS count FROM users');
  if (count > 0) throw new Error(`Target already has ${count} users; aborting`);

  await target.query('BEGIN');
  try {
    for (const [table, cols] of Object.entries(TABLES)) {
      const [rows] = await source.query(`SELECT ${cols.join(', ')} FROM ${table} ORDER BY id`);
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
      for (const row of rows) {
        const values = cols.map(c => {
          if (c === 'is_guest') return Boolean(row[c]);
          if (c === 'tags') return JSON.stringify(typeof row[c] === 'string' ? JSON.parse(row[c]) : row[c]);
          return row[c];
        });
        await target.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`, values);
      }
      await target.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE(MAX(id), 1)) FROM ${table}`);
      console.log('✓ %s: %d rows', table, rows.length);
    }
    await target.query('COMMIT');
  } catch (err) {
    await target.query('ROLLBACK');
    throw err;
  } finally {
    await source.end();
    await target.end();
  }
}

migrate().catch(err => { console.error(err.message); process.exit(1); });
