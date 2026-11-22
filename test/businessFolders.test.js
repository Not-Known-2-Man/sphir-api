// Route tests against a real, disposable Postgres database. They DROP and recreate every table.
// Run: createdb sphir_test && SPHIR_TEST_DB=sphir_test npm test   (skipped when SPHIR_TEST_DB is unset)
// The name must start with "sphir_test"; it is passed as DATABASE_URL so a DATABASE_URL in .env
// (dotenv never overrides a variable that is already set) cannot redirect the tests elsewhere.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const testDb = process.env.SPHIR_TEST_DB;

test('business price and multiple collections', { skip: !testDb && 'SPHIR_TEST_DB not set' }, async (t) => {
  assert.match(testDb, /^sphir_test\w*$/, 'SPHIR_TEST_DB must be a scratch database named sphir_test*');
  const target = `postgres://localhost/${testDb}`;
  process.env.DATABASE_URL = target;
  const { app, migrate, pool } = require('../server');
  assert.equal(process.env.DATABASE_URL, target, 'DATABASE_URL changed after loading the server');
  const { rows: [{ db }] } = await pool.query('SELECT current_database() AS db');
  assert.equal(db, testDb, 'connected to the wrong database');

  await pool.query(`DROP TABLE IF EXISTS business_folders, businesses, folders, users CASCADE`);
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8'));
  await migrate();
  await migrate(); // idempotent

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  t.after(async () => { server.close(); await pool.end(); });

  async function signUp(email) {
    const res = await fetch(`${base}/auth/sign_up`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Passw0rd!x', password_confirmation: 'Passw0rd!x', first_name: 'QA', last_name: 'T' }),
    });
    const body = await res.json();
    return { Authorization: `Bearer ${body.token}`, uid: body.uid, 'Content-Type': 'application/json' };
  }
  const call = async (headers, method, url, body) => {
    const res = await fetch(`${base}${url}`, { method, headers, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  const alice = await signUp('alice.test@example.com');
  const bob = await signUp('bob.test@example.com');
  const guest = { Authorization: 'Bearer guest_token', 'Content-Type': 'application/json' };

  const f1 = (await call(alice, 'POST', '/folders', { name: 'Health' })).body.id;
  const f2 = (await call(alice, 'POST', '/folders', { name: 'Recipes' })).body.id;
  const f3 = (await call(alice, 'POST', '/folders', { name: 'Italy' })).body.id;
  const bobFolder = (await call(bob, 'POST', '/folders', { name: 'Bob' })).body.id;

  await t.test('create without price keeps the previous behavior', async () => {
    const { status, body } = await call(alice, 'POST', '/businesses', { title: 'Plain', folder_id: f1 });
    assert.equal(status, 201);
    assert.equal(body.price, '');
    assert.equal(body.folder_id, f1);
    assert.deepEqual(body.folder_ids, [f1]);
  });

  await t.test('a title longer than the 255-character column is shortened, not a 500', async () => {
    const caption = 'Stephanie Simmons on Instagram: "' + 'Pumpkin pie cookies '.repeat(30) + '"';
    const created = await call(alice, 'POST', '/businesses', { title: caption, folder_id: f1 });
    assert.equal(created.status, 201);
    assert.equal(created.body.title.length, 255);
    assert.ok(created.body.title.endsWith('…'));
    const edited = await call(alice, 'PUT', `/businesses/${created.body.id}`, { title: caption });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.title.length, 255);
  });

  let cardId;
  await t.test('create stores a trimmed price capped at 50 characters', async () => {
    const { status, body } = await call(alice, 'POST', '/businesses', { title: 'Roller', price: '  $29.99 ', folder_id: f1 });
    assert.equal(status, 201);
    assert.equal(body.price, '$29.99');
    cardId = body.id;
    const long = await call(alice, 'POST', '/businesses', { title: 'Long', price: 'x'.repeat(80) });
    assert.equal(long.body.price.length, 50);
    const bad = await call(alice, 'POST', '/businesses', { title: 'Bad', price: { a: 1 } });
    assert.equal(bad.body.price, '');
  });

  await t.test('update changes the price and omitting it keeps it', async () => {
    assert.equal((await call(alice, 'PUT', `/businesses/${cardId}`, { price: '45 EUR' })).body.price, '45 EUR');
    assert.equal((await call(alice, 'PUT', `/businesses/${cardId}`, { title: 'Roller 2' })).body.price, '45 EUR');
  });

  await t.test('PUT folders sets the full membership; first is the primary folder', async () => {
    const { status, body } = await call(alice, 'PUT', `/businesses/${cardId}/folders`, { folder_ids: [f2, f1, f3, f2] });
    assert.equal(status, 200);
    assert.equal(body.folder_id, f2);
    assert.deepEqual(body.folder_ids, [f2, f1, f3]);
    const list = (await call(alice, 'GET', '/users/get_businesses')).body;
    assert.deepEqual(list.find(b => b.id === cardId).folder_ids, [f2, f1, f3]);
  });

  await t.test('a folder the caller does not own is refused and nothing changes', async () => {
    const { status, body } = await call(alice, 'PUT', `/businesses/${cardId}/folders`, { folder_ids: [f1, bobFolder] });
    assert.equal(status, 422);
    assert.deepEqual(body, { error: 'Folder not found' });
    const card = (await call(alice, 'GET', '/users/get_businesses')).body.find(b => b.id === cardId);
    assert.equal(card.folder_id, f2);
    assert.deepEqual(card.folder_ids, [f2, f1, f3]);
  });

  await t.test('invalid bodies are refused', async () => {
    assert.equal((await call(alice, 'PUT', `/businesses/${cardId}/folders`, {})).status, 422);
    assert.equal((await call(alice, 'PUT', `/businesses/${cardId}/folders`, { folder_ids: ['abc'] })).status, 422);
    assert.equal((await call(alice, 'PUT', `/businesses/${cardId}/folders`, { folder_ids: ['1; DROP TABLE users'] })).status, 422);
    assert.equal((await call(alice, 'PUT', `/businesses/${cardId}/folders`, { folder_ids: [99999999999] })).status, 422);
  });

  await t.test('an unknown card is 404', async () => {
    assert.equal((await call(alice, 'PUT', '/businesses/987654/folders', { folder_ids: [f1] })).status, 404);
  });

  await t.test('a database connection failure answers 500 instead of hanging', async () => {
    const original = pool.connect;
    // pool.query() uses the callback form internally (auth keeps working); only the route's
    // promise-form checkout fails.
    pool.connect = (cb) => (cb ? original.call(pool, cb) : Promise.reject(new Error('no connection')));
    try {
      const res = await call(alice, 'PUT', `/businesses/${cardId}/folders`, { folder_ids: [f1] });
      assert.equal(res.status, 500);
    } finally {
      pool.connect = original;
    }
  });

  await t.test('another user cannot change the card collections', async () => {
    const { status } = await call(bob, 'PUT', `/businesses/${cardId}/folders`, { folder_ids: [bobFolder] });
    assert.equal(status, 404);
  });

  await t.test('guests cannot change collections', async () => {
    assert.equal((await call(guest, 'PUT', `/businesses/${cardId}/folders`, { folder_ids: [f1] })).status, 403);
  });

  await t.test('deleting a folder removes it from folder_ids', async () => {
    await call(alice, 'DELETE', `/folders/${f3}`);
    const card = (await call(alice, 'GET', '/users/get_businesses')).body.find(b => b.id === cardId);
    assert.deepEqual(card.folder_ids, [f2, f1]);
  });

  await t.test('deleting the primary folder leaves folder_id null and keeps the extras', async () => {
    const fa = (await call(alice, 'POST', '/folders', { name: 'A' })).body.id;
    const fb = (await call(alice, 'POST', '/folders', { name: 'B' })).body.id;
    const card = (await call(alice, 'POST', '/businesses', { title: 'Two homes' })).body.id;
    await call(alice, 'PUT', `/businesses/${card}/folders`, { folder_ids: [fa, fb] });
    await call(alice, 'DELETE', `/folders/${fa}`);
    const after = (await call(alice, 'GET', '/users/get_businesses')).body.find(b => b.id === card);
    assert.equal(after.folder_id, null);
    assert.deepEqual(after.folder_ids, [fb]);
  });

  await t.test('an empty list removes the card from every collection', async () => {
    const { body } = await call(alice, 'PUT', `/businesses/${cardId}/folders`, { folder_ids: [] });
    assert.equal(body.folder_id, null);
    assert.deepEqual(body.folder_ids, []);
  });

  await t.test('PUT businesses with folder_id replaces only the primary collection', async () => {
    const f4 = (await call(alice, 'POST', '/folders', { name: 'Trips' })).body.id;
    await call(alice, 'PUT', `/businesses/${cardId}/folders`, { folder_ids: [f1, f2] });
    const { body } = await call(alice, 'PUT', `/businesses/${cardId}`, { folder_id: f4 });
    assert.equal(body.folder_id, f4);
    assert.deepEqual(body.folder_ids, [f4, f2]);
  });
});
