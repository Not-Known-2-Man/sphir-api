const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const testDb = process.env.SPHIR_TEST_DB && `${process.env.SPHIR_TEST_DB}_account`;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF-fake-body')]);
const dataUrl = (type, buf) => `data:${type};base64,${buf.toString('base64')}`;

test('account deletion', { skip: !testDb && 'SPHIR_TEST_DB not set' }, async (t) => {
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

  const call = async (headers, method, url, body) => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { status: res.status, body: data };
  };

  // Sign up User A
  const resA = await call({}, 'POST', '/auth/sign_up', {
    email: 'userA.test@example.com',
    password: 'PasswordA!123',
    password_confirmation: 'PasswordA!123',
    first_name: 'Alice',
    last_name: 'Test',
  });
  assert.equal(resA.status, 201);
  const userA = resA.body;
  const authA = { Authorization: `Bearer ${userA.token}`, uid: userA.uid };

  // Sign up User B
  const resB = await call({}, 'POST', '/auth/sign_up', {
    email: 'userB.test@example.com',
    password: 'PasswordB!456',
    password_confirmation: 'PasswordB!456',
    first_name: 'Bob',
    last_name: 'Test',
  });
  assert.equal(resB.status, 201);
  const userB = resB.body;
  const authB = { Authorization: `Bearer ${userB.token}`, uid: userB.uid };

  // Fetch db IDs for A and B
  const { rows: [{ id: userIdA }] } = await pool.query('SELECT id FROM users WHERE email = $1', ['userA.test@example.com']);
  const { rows: [{ id: userIdB }] } = await pool.query('SELECT id FROM users WHERE email = $1', ['userB.test@example.com']);

  // User A creates folder
  const folderARes = await call(authA, 'POST', '/folders', { name: 'Folder A' });
  assert.equal(folderARes.status, 201);
  const folderAId = folderARes.body.id;

  // User A creates a second folder for multiple collections (business_folders)
  const folderA2Res = await call(authA, 'POST', '/folders', { name: 'Folder A2' });
  assert.equal(folderA2Res.status, 201);
  const folderA2Id = folderA2Res.body.id;

  // User A creates a business (card)
  const cardARes = await call(authA, 'POST', '/businesses', { title: 'Card A', folder_id: folderAId });
  assert.equal(cardARes.status, 201);
  const cardAId = cardARes.body.id;

  // Associate card with both folders so business_folders has a row
  const bfRes = await call(authA, 'PUT', `/businesses/${cardAId}/folders`, { folder_ids: [folderAId, folderA2Id] });
  assert.equal(bfRes.status, 200);

  // User A uploads an image
  const imgRes = await call(authA, 'POST', '/images', { data: dataUrl('image/jpeg', JPEG) });
  assert.equal(imgRes.status, 201);
  const imgAId = imgRes.body.id;

  // User B creates a folder
  const folderBRes = await call(authB, 'POST', '/folders', { name: 'Folder B' });
  assert.equal(folderBRes.status, 201);
  const folderBId = folderBRes.body.id;

  // Verify setup before tests
  const countUsers = async (id) => (await pool.query('SELECT count(*)::int AS n FROM users WHERE id = $1', [id])).rows[0].n;
  const countFolders = async (id) => (await pool.query('SELECT count(*)::int AS n FROM folders WHERE user_id = $1', [id])).rows[0].n;
  const countBusinesses = async (id) => (await pool.query('SELECT count(*)::int AS n FROM businesses WHERE user_id = $1', [id])).rows[0].n;
  const countBusinessFolders = async (id) => (await pool.query(
    'SELECT count(*)::int AS n FROM business_folders bf JOIN businesses b ON bf.business_id = b.id WHERE b.user_id = $1',
    [id]
  )).rows[0].n;
  const countImages = async (id) => (await pool.query('SELECT count(*)::int AS n FROM images WHERE user_id = $1', [id])).rows[0].n;

  assert.equal(await countUsers(userIdA), 1);
  assert.equal(await countFolders(userIdA), 2);
  assert.equal(await countBusinesses(userIdA), 1);
  assert.equal(await countBusinessFolders(userIdA), 1);
  assert.equal(await countImages(userIdA), 1);
  assert.equal(await countUsers(userIdB), 1);
  assert.equal(await countFolders(userIdB), 1);

  await t.test('1. Wrong password -> 422 { error: "Incorrect password" }; data still exists', async () => {
    const res = await call(authA, 'DELETE', '/auth', { password: 'WrongPassword' });
    assert.equal(res.status, 422);
    assert.deepEqual(res.body, { error: 'Incorrect password' });

    assert.equal(await countUsers(userIdA), 1);
    assert.equal(await countFolders(userIdA), 2);
    assert.equal(await countBusinesses(userIdA), 1);
    assert.equal(await countBusinessFolders(userIdA), 1);
    assert.equal(await countImages(userIdA), 1);
  });

  await t.test('2. Missing password (empty body {}) -> 422, nothing deleted', async () => {
    const res = await call(authA, 'DELETE', '/auth', {});
    assert.equal(res.status, 422);
    assert.deepEqual(res.body, { error: 'Incorrect password' });

    assert.equal(await countUsers(userIdA), 1);
    assert.equal(await countFolders(userIdA), 2);
    assert.equal(await countBusinesses(userIdA), 1);
    assert.equal(await countBusinessFolders(userIdA), 1);
    assert.equal(await countImages(userIdA), 1);
  });

  await t.test('3. Guest (Authorization: Bearer guest_token) -> 403', async () => {
    const res = await call({ Authorization: 'Bearer guest_token' }, 'DELETE', '/auth', { password: 'any' });
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'Sign up to save Sphirs and cards' });
  });

  await t.test('4. Correct password -> 200 { success: true }; A data gone; B data exists', async () => {
    const res = await call(authA, 'DELETE', '/auth', { password: 'PasswordA!123' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true });

    assert.equal(await countUsers(userIdA), 0);
    assert.equal(await countFolders(userIdA), 0);
    assert.equal(await countBusinesses(userIdA), 0);
    assert.equal(await countBusinessFolders(userIdA), 0);
    assert.equal(await countImages(userIdA), 0);

    assert.equal(await countUsers(userIdB), 1);
    assert.equal(await countFolders(userIdB), 1);
  });

  await t.test('5. After deletion, A old token on GET /api/v1/folders -> 401, sign-in -> 401', async () => {
    const getFolders = await call(authA, 'GET', '/folders');
    assert.equal(getFolders.status, 401);

    const signIn = await call({}, 'POST', '/auth/sign_in', {
      email: 'userA.test@example.com',
      password: 'PasswordA!123',
    });
    assert.equal(signIn.status, 401);
  });

  await t.test('6. B sign-out route still works: DELETE /api/v1/auth/sign_out with B token -> 200', async () => {
    const signOut = await call(authB, 'DELETE', '/auth/sign_out');
    assert.equal(signOut.status, 200);
    assert.deepEqual(signOut.body, { success: true });
  });
});
