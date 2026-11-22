// Route tests for /api/v1/images against a disposable Postgres database.
// Run: createdb sphir_test && createdb sphir_test_images && SPHIR_TEST_DB=sphir_test npm test
// Uses its own database ("<SPHIR_TEST_DB>_images") because businessFolders.test.js drops every table
// and node --test runs the files in parallel. The name must start with "sphir_test"; it is passed as
// DATABASE_URL so an ambient DATABASE_URL cannot redirect the tests (dotenv never overrides a set variable).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const testDb = process.env.SPHIR_TEST_DB && `${process.env.SPHIR_TEST_DB}_images`;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-fake-body')]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-fake-body')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 fake')]);
const dataUrl = (type, buf) => `data:${type};base64,${buf.toString('base64')}`;
const padded = (head, size) => Buffer.concat([head, Buffer.alloc(size - head.length, 1)]);

test('images upload and serving', { skip: !testDb && 'SPHIR_TEST_DB not set' }, async (t) => {
  assert.match(testDb, /^sphir_test\w*$/, 'database must be a scratch database named sphir_test*');
  const target = `postgres://localhost/${testDb}`;
  process.env.DATABASE_URL = target;
  const { app, migrate, pool } = require('../server');
  assert.equal(process.env.DATABASE_URL, target, 'DATABASE_URL changed after loading the server');
  const { rows: [{ db }] } = await pool.query('SELECT current_database() AS db');
  assert.equal(db, testDb, 'connected to the wrong database');

  await pool.query(`DROP TABLE IF EXISTS images, business_folders, businesses, folders, users CASCADE`);
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8'));
  await migrate();
  await migrate(); // idempotent

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  t.after(async () => { server.close(); await pool.end(); });

  const res0 = await fetch(`${base}/auth/sign_up`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'img.test@example.com', password: 'Passw0rd!x', password_confirmation: 'Passw0rd!x', first_name: 'QA', last_name: 'T' }),
  });
  const su = await res0.json();
  const auth = { Authorization: `Bearer ${su.token}`, uid: su.uid, 'Content-Type': 'application/json' };
  const count = async () => (await pool.query('SELECT count(*)::int AS n FROM images')).rows[0].n;
  const upload = async (body, headers = auth) => {
    const res = await fetch(`${base}/images`, { method: 'POST', headers, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  await t.test('201 with id and https url; GET returns the same bytes with safe headers', async () => {
    const { status, body } = await upload({ data: dataUrl('image/jpeg', JPEG) }, { ...auth, 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'api.example.com' });
    assert.equal(status, 201);
    assert.match(body.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(body.url, `https://api.example.com/api/v1/images/${body.id}`);
    assert.deepEqual(Object.keys(body).sort(), ['id', 'url']);
    const get = await fetch(`${base}/images/${body.id}`); // no auth: public
    assert.equal(get.status, 200);
    assert.equal(get.headers.get('content-type'), 'image/jpeg');
    assert.equal(get.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(get.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.deepEqual(Buffer.from(await get.arrayBuffer()), JPEG);
  });

  await t.test('png and webp are accepted and served with their own type', async () => {
    for (const [type, buf] of [['image/png', PNG], ['image/webp', WEBP]]) {
      const { status, body } = await upload({ data: dataUrl(type, buf) });
      assert.equal(status, 201, type);
      const get = await fetch(`${base}/images/${body.id}`);
      assert.equal(get.headers.get('content-type'), type);
      assert.deepEqual(Buffer.from(await get.arrayBuffer()), buf);
    }
  });

  await t.test('url is https on Render even without forwarding headers, and PUBLIC_API_URL overrides', async () => {
    process.env.RENDER = 'true';
    try {
      const a = await upload({ data: dataUrl('image/png', PNG) });
      assert.match(a.body.url, /^https:\/\/.+\/api\/v1\/images\/[0-9a-f-]{36}$/);
      process.env.PUBLIC_API_URL = 'https://sphir-api.example.com/';
      const b = await upload({ data: dataUrl('image/png', PNG) });
      assert.equal(b.body.url, `https://sphir-api.example.com/api/v1/images/${b.body.id}`);
    } finally { delete process.env.RENDER; delete process.env.PUBLIC_API_URL; }
  });

  await t.test('401 without auth and nothing stored', async () => {
    const before = await count();
    const { status } = await upload({ data: dataUrl('image/jpeg', JPEG) }, { 'Content-Type': 'application/json' });
    assert.equal(status, 401);
    assert.equal(await count(), before);
  });

  const rejected = {
    'missing data': {},
    'data not a string': { data: 123 },
    'not a data url': { data: 'hello world' },
    'plain text declared as jpeg': { data: dataUrl('image/jpeg', Buffer.from('just text, not an image')) },
    'svg': { data: dataUrl('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')) },
    'gif': { data: dataUrl('image/gif', Buffer.from('GIF89a-fake')) },
    'png bytes declared as jpeg': { data: dataUrl('image/jpeg', PNG) },
    'jpeg bytes declared as webp': { data: dataUrl('image/webp', JPEG) },
    'invalid base64': { data: 'data:image/jpeg;base64,@@@@' },
    'empty payload': { data: 'data:image/jpeg;base64,' },
    'just over 2 MB': { data: dataUrl('image/jpeg', padded(JPEG, 2 * 1024 * 1024 + 1)) },
    'far over 2 MB (body limit)': { data: dataUrl('image/jpeg', padded(JPEG, 3 * 1024 * 1024)) },
  };
  for (const [name, payload] of Object.entries(rejected)) {
    await t.test(`422 and nothing stored: ${name}`, async () => {
      const before = await count();
      const { status, body } = await upload(payload);
      assert.equal(status, 422);
      assert.equal(typeof body.error, 'string');
      assert.ok(body.error.length > 0);
      assert.equal(await count(), before);
    });
  }

  await t.test('exactly 2 MB is accepted', async () => {
    const { status } = await upload({ data: dataUrl('image/jpeg', padded(JPEG, 2 * 1024 * 1024)) });
    assert.equal(status, 201);
  });

  await t.test('GET 404 for unknown and malformed ids, no SQL error', async () => {
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid', '1', "x'%20OR%201=1"]) {
      const res = await fetch(`${base}/images/${id}`);
      assert.equal(res.status, 404, id);
    }
  });

  await t.test('a card saved with the returned url keeps it as og_image', async () => {
    const up = await upload({ data: dataUrl('image/jpeg', JPEG) }, { ...auth, 'X-Forwarded-Proto': 'https' });
    const created = await fetch(`${base}/businesses`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'Shot', og_image: up.body.url }) });
    assert.equal(created.status, 201);
    const card = await created.json();
    assert.equal(card.og_image, up.body.url);
    const edited = await fetch(`${base}/businesses/${card.id}`, { method: 'PUT', headers: auth, body: JSON.stringify({ og_image: up.body.url }) });
    assert.equal((await edited.json()).og_image, up.body.url);
  });

  await t.test('POST /businesses still rejects bodies over the global 100 kb limit', async () => {
    const res = await fetch(`${base}/businesses`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'Big', description: 'x'.repeat(200 * 1024) }) });
    assert.notEqual(res.status, 201);
    assert.equal(res.status, 500); // body-parser's 413 reaches the generic error handler, as before
  });

  await t.test('POST /images returns 400 for malformed JSON body without logging', async (st) => {
    const logged = st.mock.method(console, 'error', () => {});
    const res = await fetch(`${base}/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"data": "invalid json',
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Invalid JSON body' });
    assert.equal(logged.mock.callCount(), 0);
  });

  await t.test('POST /images returns 422 with existing message for oversized body', async () => {
    const res = await fetch(`${base}/images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: 'x'.repeat(3 * 1024 * 1024) }),
    });
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { error: 'Image too large (max 2 MB)' });
  });

  await t.test('POST /images rejects upload when user reaches 100 images limit', async () => {
    const { rows: [{ id: userId }] } = await pool.query('SELECT id FROM users WHERE token = $1', [su.token]);
    const { rows: [{ n: currentCount }] } = await pool.query('SELECT count(*)::int AS n FROM images WHERE user_id = $1', [userId]);
    const params = [userId, JPEG];
    const chunks = [];
    for (let i = currentCount; i < 99; i++) {
      params.push(crypto.randomUUID());
      chunks.push(`($${params.length}, $1, 'image/jpeg', $2)`);
    }
    if (chunks.length > 0) {
      await pool.query(`INSERT INTO images (id, user_id, mime, data) VALUES ${chunks.join(',')}`, params);
    }
    const ok = await upload({ data: dataUrl('image/jpeg', JPEG) });
    assert.equal(ok.status, 201);

    const before = await count();
    const rejected = await upload({ data: dataUrl('image/jpeg', JPEG) });
    assert.equal(rejected.status, 422);
    assert.deepEqual(rejected.body, { error: 'Image limit reached (100 per account)' });
    assert.equal(await count(), before);
  });

  await t.test('image limit is per user; another user with 0 images can upload', async () => {
    const res2 = await fetch(`${base}/auth/sign_up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'img.user2@example.com', password: 'Passw0rd!x', password_confirmation: 'Passw0rd!x', first_name: 'QA2', last_name: 'T2' }),
    });
    const su2 = await res2.json();
    const auth2 = { Authorization: `Bearer ${su2.token}`, uid: su2.uid, 'Content-Type': 'application/json' };
    const { status, body } = await upload({ data: dataUrl('image/jpeg', JPEG) }, auth2);
    assert.equal(status, 201);
    assert.match(body.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
