// Card privacy (odd/tasks/card-privacy.md S1-S4): per-card is_private lock, who else may see a
// card, and the "Already on Sphir" preview. Needs SPHIR_TEST_DB=sphir_test*; skipped otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const baseTestDb = process.env.SPHIR_TEST_DB;
const testDb = baseTestDb && `${baseTestDb}_privacy`;

test('card privacy', { skip: !baseTestDb && 'SPHIR_TEST_DB not set' }, async (t) => {
  const admin = new Client({ connectionString: `postgres://localhost/${baseTestDb}` });
  await admin.connect();
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [testDb]);
  if (rows.length === 0) await admin.query(`CREATE DATABASE ${testDb}`);
  await admin.end();

  assert.match(testDb, /^sphir_test\w*$/, 'database must be a scratch database named sphir_test*');
  const target = `postgres://localhost/${testDb}`;
  process.env.DATABASE_URL = target;
  const { app, migrate, pool } = require('../server');
  const { rows: [{ db }] } = await pool.query('SELECT current_database() AS db');
  assert.equal(db, testDb, 'connected to the wrong database');

  await pool.query('DROP TABLE IF EXISTS images, business_folders, businesses, folders, users CASCADE');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8'));
  await migrate();

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  t.after(async () => { server.close(); await pool.end(); });

  async function signUp(email) {
    const res = await fetch(`${base}/auth/sign_up`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Password123!', password_confirmation: 'Password123!', first_name: 'Test', last_name: 'User' }),
    });
    const data = await res.json();
    return { Authorization: `Bearer ${data.token}`, uid: data.uid, 'Content-Type': 'application/json' };
  }
  const api = async (method, url, headers, body) => {
    const res = await fetch(`${base}${url}`, { method, headers, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const owner = await signUp('owner@example.com');
  const viewer = await signUp('viewer@example.com');
  const folder = async (privacy) => (await api('POST', '/folders', owner, { name: `F ${privacy} ${Math.random()}`, privacy })).body.id;
  const publicFolder = await folder('public');
  const connectionsFolder = await folder('connections');
  const privateFolder = await folder('private');

  function mockPage(st, title = 'Live Page Title') {
    const axios = require('axios');
    st.mock.method(axios, 'get', async (url) => ({
      data: `<html><head><meta property="og:title" content="${title}"></head></html>`,
      request: { res: { responseUrl: url } },
    }));
  }
  const preview = async (url, headers = viewer) => api('GET', `/preview?url=${encodeURIComponent(url)}`, headers);
  let n = 0;
  async function card(fields) {
    n += 1;
    const website = `https://privacy.example.com/item/${n}`;
    const res = await api('POST', '/businesses', owner, {
      title: `Owner Title ${n}`, description: 'Owner notes', price: '$5', og_image: 'https://example.com/i.jpg',
      tags: ['_book'], website, ...fields,
    });
    assert.equal(res.status, 201);
    return { ...res.body, website };
  }
  const assertCountOnly = (body, count) => {
    assert.deepEqual(body.already_on_sphir, { count });
    assert.equal(body.title, 'Live Page Title');
    assert.notEqual(body.description, 'Owner notes');
    assert.notEqual(body.price, '$5');
  };

  await t.test('S2: a new card is private unless is_private is false', async () => {
    const locked = await card({});
    assert.equal(locked.is_private, true);
    const notBool = await card({ is_private: 'false' });
    assert.equal(notBool.is_private, true);
    const open = await card({ is_private: false });
    assert.equal(open.is_private, false);
    const list = await api('GET', '/users/get_businesses', owner);
    assert.equal(list.status, 200);
    const listed = (list.body.businesses || list.body).find(b => b.id === open.id);
    assert.equal(listed.is_private, false);
  });

  await t.test('S2: update sets is_private only from a boolean; omitted keeps it', async () => {
    const c = await card({});
    const put = (body) => api('PUT', `/businesses/${c.id}`, owner, body);
    assert.equal((await put({ is_private: false })).body.is_private, false);
    assert.equal((await put({ title: 'Renamed' })).body.is_private, false);
    assert.equal((await put({ is_private: 'true' })).body.is_private, false);
    assert.equal((await put({ is_private: null })).body.is_private, false);
    assert.equal((await put({ is_private: true })).body.is_private, true);
    const other = await api('PUT', `/businesses/${c.id}`, viewer, { is_private: false });
    assert.equal(other.status, 404);
    const { rows: [row] } = await pool.query('SELECT is_private FROM businesses WHERE id = $1', [c.id]);
    assert.equal(row.is_private, true);
  });

  await t.test('S2: the migration adds is_private and locks existing cards', async () => {
    await pool.query('ALTER TABLE businesses DROP COLUMN is_private');
    const { rows: [old] } = await pool.query(
      `INSERT INTO businesses (user_id, title, description, tags) VALUES (1, 'Old', '', '[]'::jsonb) RETURNING id`
    );
    await migrate();
    await migrate();
    const { rows: [row] } = await pool.query('SELECT is_private FROM businesses WHERE id = $1', [old.id]);
    assert.equal(row.is_private, true);
  });

  await t.test('S3/S4: locked card in a public collection gives the count only', async (st) => {
    mockPage(st);
    const c = await card({ folder_id: publicFolder });
    const res = await preview(c.website);
    assert.equal(res.status, 200);
    assertCountOnly(res.body, 1);
  });

  await t.test('S4: page fetch fails -> a hidden card still gives the count only; no card gives 422', async (st) => {
    const axios = require('axios');
    st.mock.method(axios, 'get', async () => { throw Object.assign(new Error('blocked'), { code: 'ECONNRESET' }); });
    const c = await card({ folder_id: publicFolder });
    const res = await preview(c.website);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.already_on_sphir, { count: 1 });
    assert.equal(res.body.url, c.website);
    assert.equal(res.body.title, '');
    assert.equal(res.body.description, '');
    assert.equal(res.body.price, '');
    const none = await preview('https://privacy.example.com/never-saved');
    assert.equal(none.status, 422);
    assert.deepEqual(none.body, { error: 'Could not fetch metadata' });
  });

  await t.test('S3/S4: unlocked card that is unfiled, private or connections-only gives the count only', async (st) => {
    mockPage(st);
    for (const folder_id of [undefined, privateFolder, connectionsFolder]) {
      const c = await card({ is_private: false, folder_id });
      const res = await preview(c.website);
      assert.equal(res.status, 200);
      assertCountOnly(res.body, 1);
    }
  });

  await t.test('S3/S4: unlocked card in a public collection shares its details', async (st) => {
    mockPage(st);
    const c = await card({ is_private: false, folder_id: publicFolder });
    const res = await preview(c.website);
    assert.equal(res.body.title, c.title);
    assert.equal(res.body.description, 'Owner notes');
    assert.equal(res.body.price, '$5');
    assert.deepEqual(res.body.already_on_sphir, {
      count: 1, title: c.title, description: 'Owner notes', type: 'book', image: 'https://example.com/i.jpg', price: '$5',
    });
  });

  await t.test('S3: a public extra collection counts like the primary one', async (st) => {
    mockPage(st);
    const c = await card({ is_private: false, folder_id: privateFolder });
    const moved = await api('PUT', `/businesses/${c.id}/folders`, owner, { folder_ids: [privateFolder, publicFolder] });
    assert.equal(moved.status, 200);
    assert.equal((await preview(c.website)).body.already_on_sphir.title, c.title);
  });

  await t.test('S3: locking a visible card hides it again', async (st) => {
    mockPage(st);
    const c = await card({ is_private: false, folder_id: publicFolder });
    await api('PUT', `/businesses/${c.id}`, owner, { is_private: true });
    assertCountOnly((await preview(c.website)).body, 1);
  });

  await t.test('S4: the owner always gets their own locked card', async (st) => {
    mockPage(st);
    const c = await card({});
    const res = await preview(c.website, owner);
    assert.equal(res.body.title, c.title);
    assert.equal(res.body.already_on_sphir.description, 'Owner notes');
  });

  await t.test('S4: several cards for one link -> details skip hidden cards and prefer the viewer\'s own', async (st) => {
    mockPage(st);
    const website = 'https://privacy.example.com/shared-link';
    const save = (headers, title, fields) => api('POST', '/businesses', headers, { title, description: `${title} notes`, website, ...fields });
    assert.equal((await save(owner, 'Older Visible', { is_private: false, folder_id: publicFolder })).status, 201);
    const third = await signUp('third@example.com');
    assert.equal((await save(third, 'Newer Locked', {})).status, 201);
    const first = await preview(website);
    assert.equal(first.body.already_on_sphir.count, 2);
    assert.equal(first.body.already_on_sphir.title, 'Older Visible');

    assert.equal((await save(viewer, 'Viewer Own', {})).status, 201);
    assert.equal((await save(owner, 'Newest Visible', { is_private: false, folder_id: publicFolder })).status, 201);
    const second = await preview(website);
    assert.equal(second.body.already_on_sphir.count, 3);
    assert.equal(second.body.already_on_sphir.title, 'Viewer Own');
  });

  await t.test('S4: only locked cards -> the AI fills the preview and the count stays', async (st) => {
    mockPage(st);
    const aiCard = require('../lib/aiCard');
    const ai = st.mock.method(aiCard, 'enrichCard', async () => ({ title: 'AI Title', description: 'AI description', type: 'article' }));
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    st.after(() => { if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey; });
    const c = await card({ folder_id: publicFolder });
    const res = await preview(c.website);
    assert.equal(ai.mock.callCount(), 1);
    assert.equal(res.body.ai, true);
    assert.equal(res.body.title, 'AI Title');
    assert.equal(res.body.description, 'AI description');
    assert.deepEqual(res.body.already_on_sphir, { count: 1 });
  });

  await t.test('S4: POST preview (share extension HTML) applies the same rule', async () => {
    const c = await card({});
    const res = await api('POST', '/preview', viewer, {
      url: c.website, html: '<html><head><meta property="og:title" content="Live Page Title"></head></html>',
    });
    assert.equal(res.status, 200);
    assertCountOnly(res.body, 1);
  });
});
