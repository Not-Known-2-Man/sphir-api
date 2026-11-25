// Default "Unfiled Cards" collection and reuse of an already-saved card (demo-feedback-1125 S1-S5).
// Run: SPHIR_TEST_DB=sphir_test npm test   (skipped when SPHIR_TEST_DB is unset)
// Uses its own database "<SPHIR_TEST_DB>_unfiled" (created on demand, name must start with "sphir_test");
// it is passed as DATABASE_URL so a DATABASE_URL in .env cannot redirect the tests (dotenv never overrides a set variable).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const axios = require('axios');
const aiCard = require('../lib/aiCard');

const baseTestDb = process.env.SPHIR_TEST_DB;
const testDb = baseTestDb && `${baseTestDb}_unfiled`;
const DEFAULT_NAME = 'Unfiled Cards';
const PROTECTED = { error: "Unfiled Cards can't be deleted or renamed" };

test('unfiled cards default collection and card reuse', { skip: !baseTestDb && 'SPHIR_TEST_DB not set' }, async (t) => {
  assert.match(testDb, /^sphir_test\w*$/, 'database must be a scratch database named sphir_test*');
  const admin = new Client({ connectionString: `postgres://localhost/${baseTestDb}` });
  await admin.connect();
  try {
    const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [testDb]);
    if (rows.length === 0) await admin.query(`CREATE DATABASE ${testDb}`);
  } finally {
    await admin.end();
  }

  const target = `postgres://localhost/${testDb}`;
  process.env.DATABASE_URL = target;
  const { app, migrate, pool } = require('../server');
  assert.equal(process.env.DATABASE_URL, target, 'DATABASE_URL changed after loading the server');
  const { rows: [{ db }] } = await pool.query('SELECT current_database() AS db');
  assert.equal(db, testDb, 'connected to the wrong database');

  await pool.query('DROP TABLE IF EXISTS images, business_folders, businesses, folders, users CASCADE');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8'));
  await migrate();

  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  t.after(async () => { server.close(); await pool.end(); });

  const call = async (headers, method, url, body) => {
    const res = await fetch(`${base}${url}`, { method, headers, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  async function signUp(email) {
    const res = await fetch(`${base}/auth/sign_up`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Passw0rd!x', password_confirmation: 'Passw0rd!x', first_name: 'QA', last_name: 'T' }),
    });
    const body = await res.json();
    return { Authorization: `Bearer ${body.token}`, uid: body.uid, 'Content-Type': 'application/json' };
  }
  const folders = async (h) => (await call(h, 'GET', '/folders')).body;
  const defaultOf = async (h) => (await folders(h)).find(f => f.is_default);
  const cards = async (h) => (await call(h, 'GET', '/users/get_businesses')).body;

  await t.test('S2 sign-up creates the default "Unfiled Cards" collection', async () => {
    const eve = await signUp('eve.unfiled@example.com');
    const list = await folders(eve);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, DEFAULT_NAME);
    assert.equal(list[0].is_default, true);
    const extra = (await call(eve, 'POST', '/folders', { name: 'Trips' })).body;
    assert.equal(extra.is_default, false);
    assert.equal((await folders(eve)).filter(f => f.is_default).length, 1);
  });

  await t.test('S1 a link already on Sphir returns the stored card as the preview', async (st) => {
    const owner = await signUp('owner.reuse@example.com');
    const caller = await signUp('caller.reuse@example.com');
    const link = 'https://shop.example.com/item/42';
    assert.equal((await call(owner, 'POST', '/businesses', {
      title: 'Stored Title', description: 'Stored description', website: link, price: '$5',
      og_image: 'https://example.com/stored.jpg', tags: ['gift', '_product'],
    })).status, 201);
    const upload = await call(owner, 'POST', '/businesses', {
      title: 'Private Photo', description: 'mine', website: 'https://shop.example.com/item/43',
      og_image: 'https://api.example.com/api/v1/images/0a1b2c3d-0a1b-4c3d-8a1b-0a1b2c3d4e5f', tags: ['_recipe'],
    });
    assert.equal(upload.status, 201);

    const page = (title) => ({
      data: `<html><head><meta property="og:title" content="${title}"><meta property="og:description" content="Page description"><meta property="og:type" content="article"><meta property="og:image" content="https://example.com/page.jpg"></head></html>`,
      request: { res: { responseUrl: 'https://shop.example.com/x' } },
    });
    st.mock.method(axios, 'get', async () => page('Page Title'));
    const ai = st.mock.method(aiCard, 'enrichCard', async () => ({ title: 'AI Title', description: 'AI description', type: 'video', price: '$9' }));
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'test-key';
    st.after(() => { if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = savedKey; });

    const get = (await call(caller, 'GET', `/preview?url=${encodeURIComponent(link)}`)).body;
    assert.equal(get.title, 'Stored Title');
    assert.equal(get.description, 'Stored description');
    assert.equal(get.price, '$5');
    assert.equal(get.type, 'product');
    assert.equal(get.image, 'https://example.com/stored.jpg');
    assert.equal(get.already_on_sphir.description, 'Stored description');
    assert.equal(get.already_on_sphir.type, 'product');
    assert.deepEqual(Object.keys(get.already_on_sphir).sort(), ['count', 'description', 'image', 'price', 'title', 'type']);
    assert.equal(get.ai, false);

    const post = (await call(caller, 'POST', '/preview', {
      url: link, html: page('Page Title').data,
    })).body;
    assert.equal(post.title, 'Stored Title');
    assert.equal(post.description, 'Stored description');
    assert.equal(post.price, '$5');
    assert.equal(post.type, 'product');
    assert.equal(post.image, 'https://example.com/stored.jpg');
    assert.equal(ai.mock.callCount(), 0, 'no AI call for a link already on Sphir');

    // Uploaded photo stays private: the page image is used, text fields still come from the stored card.
    const priv = (await call(caller, 'GET', `/preview?url=${encodeURIComponent('https://shop.example.com/item/43')}`)).body;
    assert.equal(priv.title, 'Private Photo');
    assert.equal(priv.type, 'recipe');
    assert.equal(priv.image, 'https://example.com/page.jpg');
    assert.equal(priv.already_on_sphir.image, '');

    // The user can still save a different card for the same link: one row per user.
    const saved = await call(caller, 'POST', '/businesses', { title: 'My Own Title', website: link });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.title, 'My Own Title');
    assert.equal((await cards(caller)).length, 1);
  });

  await t.test('S4 a card created without folder_id lands in the default collection', async () => {
    const h = await signUp('zoe.nofolder@example.com');
    const def = await defaultOf(h);
    const other = (await call(h, 'POST', '/folders', { name: 'Chosen' })).body;
    const a = (await call(h, 'POST', '/businesses', { title: 'No folder' })).body;
    const b = (await call(h, 'POST', '/businesses', { title: 'Empty folder', folder_id: '' })).body;
    const c = (await call(h, 'POST', '/businesses', { title: 'Chosen folder', folder_id: other.id })).body;
    assert.equal(a.folder_id, def.id);
    assert.deepEqual(a.folder_ids, [def.id]);
    assert.equal(b.folder_id, def.id);
    assert.equal(c.folder_id, other.id);
  });

  await t.test('S4 deleting a collection moves cards with no other collection to the default', async () => {
    const h = await signUp('dan.delete@example.com');
    const def = await defaultOf(h);
    const gone = (await call(h, 'POST', '/folders', { name: 'Gone' })).body;
    const keep = (await call(h, 'POST', '/folders', { name: 'Keep' })).body;
    const only = (await call(h, 'POST', '/businesses', { title: 'Only', folder_id: gone.id })).body;
    const multi = (await call(h, 'POST', '/businesses', { title: 'Multi', folder_id: gone.id })).body;
    await call(h, 'PUT', `/businesses/${multi.id}/folders`, { folder_ids: [gone.id, keep.id] });
    const extraOnly = (await call(h, 'POST', '/businesses', { title: 'Extra only', folder_id: keep.id })).body;
    await call(h, 'PUT', `/businesses/${extraOnly.id}/folders`, { folder_ids: [keep.id, gone.id] });

    const res = await call(h, 'DELETE', `/folders/${gone.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true });

    const byTitle = Object.fromEntries((await cards(h)).map(c => [c.title, c]));
    assert.equal(Object.keys(byTitle).length, 3, 'no card is deleted');
    assert.equal(byTitle.Only.folder_id, def.id);
    assert.deepEqual(byTitle.Only.folder_ids, [def.id]);
    assert.equal(byTitle.Multi.folder_id, keep.id);
    assert.deepEqual(byTitle.Multi.folder_ids, [keep.id]);
    assert.equal(byTitle['Extra only'].folder_id, keep.id);
    assert.deepEqual(byTitle['Extra only'].folder_ids, [keep.id]);
  });

  await t.test('S5 the default collection cannot be deleted or renamed; other edits still work', async () => {
    const h = await signUp('sam.protect@example.com');
    const def = await defaultOf(h);

    const del = await call(h, 'DELETE', `/folders/${def.id}`);
    assert.equal(del.status, 409);
    assert.deepEqual(del.body, PROTECTED);

    const ren = await call(h, 'PUT', `/folders/${def.id}`, { name: 'Renamed' });
    assert.equal(ren.status, 409);
    assert.deepEqual(ren.body, PROTECTED);
    const renWithOther = await call(h, 'PUT', `/folders/${def.id}`, { name: 'Renamed', description: 'changed' });
    assert.equal(renWithOther.status, 409);

    const unchanged = await defaultOf(h);
    assert.equal(unchanged.name, DEFAULT_NAME);
    assert.equal(unchanged.description, def.description);
    assert.equal(unchanged.id, def.id);

    const edit = await call(h, 'PUT', `/folders/${def.id}`, { description: 'My inbox', privacy: 'public' });
    assert.equal(edit.status, 200);
    assert.equal(edit.body.description, 'My inbox');
    assert.equal(edit.body.privacy, 'public');
    assert.equal(edit.body.name, DEFAULT_NAME);
    assert.equal(edit.body.is_default, true);
    assert.equal((await call(h, 'PUT', `/folders/${def.id}`, { name: DEFAULT_NAME })).status, 200);
  });

  await t.test('a normal collection can still be renamed and deleted', async () => {
    const h = await signUp('nora.normal@example.com');
    const f = (await call(h, 'POST', '/folders', { name: 'Before' })).body;
    const ren = await call(h, 'PUT', `/folders/${f.id}`, { name: 'After' });
    assert.equal(ren.status, 200);
    assert.equal(ren.body.name, 'After');
    assert.equal((await call(h, 'DELETE', `/folders/${f.id}`)).status, 200);
    assert.equal((await call(h, 'DELETE', `/folders/${f.id}`)).status, 404);
    assert.equal((await call(h, 'PUT', `/folders/${f.id}`, { name: 'x' })).status, 404);
  });

  await t.test('S3/S4 migration creates one default per user, adopts the exact name and files folderless cards', async () => {
    const token = (n) => `migr-token-${n}`;
    const auth = (n) => ({ Authorization: `Bearer ${token(n)}`, uid: `migr${n}@example.com`, 'Content-Type': 'application/json' });
    const addUser = async (n) => (await pool.query(
      'INSERT INTO users (email, password_hash, token, uid, client, is_guest) VALUES ($1,$2,$3,$1,$4,false) RETURNING id',
      [`migr${n}@example.com`, 'x', token(n), `client-${n}`])).rows[0].id;
    const addFolder = async (uid, name) => (await pool.query(
      "INSERT INTO folders (user_id, name, description) VALUES ($1,$2,'') RETURNING id", [uid, name])).rows[0].id;
    const addCard = async (uid, title, folderId) => (await pool.query(
      "INSERT INTO businesses (user_id, folder_id, title, description, tags) VALUES ($1,$2,$3,'','[]') RETURNING id",
      [uid, folderId, title])).rows[0].id;

    const u1 = await addUser(1); // no folders, one folderless card
    const u2 = await addUser(2); // has an exact "Unfiled Cards" folder and another one
    const u3 = await addUser(3); // folder with a different case: not adopted
    const u4 = await addUser(4); // card only in business_folders extras
    const u1Card = await addCard(u1, 'u1 loose', null);
    const u2Own = await addFolder(u2, DEFAULT_NAME);
    const u2Other = await addFolder(u2, 'Other');
    const u2Loose = await addCard(u2, 'u2 loose', null);
    const u2Filed = await addCard(u2, 'u2 filed', u2Other);
    await addFolder(u3, 'unfiled cards');
    const u4a = await addFolder(u4, 'A');
    const u4b = await addFolder(u4, 'B');
    const u4Card = await addCard(u4, 'u4 extras only', null);
    await pool.query('INSERT INTO business_folders (business_id, folder_id, position) VALUES ($1,$2,0),($1,$3,1)', [u4Card, u4b, u4a]);

    const countBefore = async () => ({
      cards: (await pool.query('SELECT count(*)::int AS n FROM businesses')).rows[0].n,
      folders: (await pool.query('SELECT count(*)::int AS n FROM folders')).rows[0].n,
    });
    const before = await countBefore();
    const usersWithoutDefault = (await pool.query(
      'SELECT count(*)::int AS n FROM users u WHERE NOT EXISTS (SELECT 1 FROM folders f WHERE f.user_id = u.id AND f.is_default)')).rows[0].n;

    await migrate();
    const afterFirst = await countBefore();
    const defaultsAfterFirst = (await pool.query('SELECT user_id, id FROM folders WHERE is_default ORDER BY user_id')).rows;
    await migrate(); // idempotent
    const afterSecond = await countBefore();
    assert.deepEqual(afterSecond, afterFirst, 'second run changes nothing');
    assert.deepEqual((await pool.query('SELECT user_id, id FROM folders WHERE is_default ORDER BY user_id')).rows, defaultsAfterFirst);

    // u2's existing folder is adopted: one new folder per user without one, minus the adopted user.
    assert.equal(afterFirst.cards, before.cards, 'no card deleted');
    assert.equal(afterFirst.folders, before.folders + usersWithoutDefault - 1);
    const perUser = (await pool.query('SELECT user_id, count(*)::int AS n FROM folders WHERE is_default GROUP BY user_id HAVING count(*) <> 1')).rows;
    assert.deepEqual(perUser, [], 'at most one default per user');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM users WHERE id = ANY($1) AND NOT EXISTS (SELECT 1 FROM folders f WHERE f.user_id = users.id AND f.is_default)', [[u1, u2, u3, u4]])).rows[0].n, 0);

    const defaultName = async (n) => (await folders(auth(n))).filter(f => f.is_default);
    assert.deepEqual((await defaultName(2)).map(f => f.id), [u2Own], 'exact-name folder adopted');
    assert.equal((await folders(auth(2))).filter(f => f.name === DEFAULT_NAME).length, 1);
    const d3 = await defaultName(3);
    assert.equal(d3.length, 1);
    assert.equal(d3[0].name, DEFAULT_NAME);
    assert.equal((await folders(auth(3))).length, 2, 'lowercase folder kept, new default added');

    const c1 = (await cards(auth(1)))[0];
    assert.equal(c1.id, u1Card);
    assert.equal(c1.folder_id, (await defaultName(1))[0].id);
    const c2 = Object.fromEntries((await cards(auth(2))).map(c => [c.id, c]));
    assert.equal(c2[u2Loose].folder_id, u2Own);
    assert.equal(c2[u2Filed].folder_id, u2Other, 'filed card untouched');
    const c4 = (await cards(auth(4)))[0];
    assert.equal(c4.folder_id, u4b, 'first extra promoted to primary');
    assert.deepEqual(c4.folder_ids, [u4b, u4a]);
    assert.equal((await defaultName(4)).length, 1);
    assert.equal(c4.folder_ids.includes((await defaultName(4))[0].id), false, 'extras-only card is not also put in the default');
  });
});
