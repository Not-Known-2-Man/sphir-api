const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const baseTestDb = process.env.SPHIR_TEST_DB;
const testDb = baseTestDb && `${baseTestDb}_already`;

test('already on Sphir saved-link lookup', { skip: !baseTestDb && 'SPHIR_TEST_DB not set' }, async (t) => {
  let activeDb = baseTestDb;
  if (testDb) {
    try {
      const admin = new Client({ connectionString: `postgres://localhost/${baseTestDb}` });
      await admin.connect();
      const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [testDb]);
      if (rows.length === 0) {
        await admin.query(`CREATE DATABASE ${testDb}`);
      }
      await admin.end();
      activeDb = testDb;
    } catch {
      activeDb = baseTestDb;
    }
  }

  assert.match(activeDb, /^sphir_test\w*$/, 'database must be a scratch database named sphir_test*');
  const target = `postgres://localhost/${activeDb}`;
  process.env.DATABASE_URL = target;
  const { app, migrate, pool } = require('../server');
  assert.equal(process.env.DATABASE_URL, target, 'DATABASE_URL changed after loading the server');
  const { rows: [{ db }] } = await pool.query('SELECT current_database() AS db');
  assert.equal(db, activeDb, 'connected to the wrong database');

  await pool.query(`DROP TABLE IF EXISTS images, business_folders, businesses, folders, users CASCADE`);
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8'));
  await migrate();
  await migrate(); // idempotent

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
    return {
      Authorization: `Bearer ${data.token}`,
      uid: data.uid,
      'Content-Type': 'application/json',
    };
  }

  const authUser1 = await signUp('user1@example.com');
  const authUser2 = await signUp('user2@example.com');
  const authCaller = await signUp('caller@example.com');

  // (a) no one saved it -> already_on_sphir: null
  await t.test('(a) no one saved it -> already_on_sphir: null', async (st) => {
    const axios = require('axios');
    st.mock.method(axios, 'get', async (url) => ({
      data: '<html><head><title>Unsaved</title><meta property="og:title" content="Unsaved Link"><meta property="og:image" content="https://example.com/unsaved.jpg"></head></html>',
      request: { res: { responseUrl: url } },
    }));

    const res = await fetch(`${base}/preview?url=${encodeURIComponent('https://example.com/unsaved-page')}`, { headers: authCaller });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.title, 'Unsaved Link');
    assert.equal(body.image, 'https://example.com/unsaved.jpg');
    assert.equal(body.already_on_sphir, null);
  });

  // (b) two other users saved variants of the same link (one with utm and m.) -> count 2 and stored title/image, no user info in the JSON
  await t.test('(b) two other users saved variants of the same link -> count 2 and stored title/image, no user info in JSON', async (st) => {
    const res1 = await fetch(`${base}/businesses`, {
      method: 'POST',
      headers: authUser1,
      body: JSON.stringify({
        title: 'First Variant Title',
        website: 'https://m.youtube.com/watch?v=multi123&utm_source=twitter',
        og_image: 'https://example.com/thumb1.jpg',
        description: 'First description',
        price: '$19.99',
        tags: ['video', 'media'],
      }),
    });
    assert.equal(res1.status, 201);

    const res2 = await fetch(`${base}/businesses`, {
      method: 'POST',
      headers: authUser2,
      body: JSON.stringify({
        title: 'Second Variant Title',
        website: 'https://www.youtube.com/watch?v=multi123',
        og_image: 'https://example.com/thumb2.jpg',
        description: 'Second description',
        price: '$29.99',
        tags: ['video', 'popular'],
      }),
    });
    assert.equal(res2.status, 201);

    const axios = require('axios');
    st.mock.method(axios, 'get', async (url) => ({
      data: '<html><head><meta property="og:title" content="Live YouTube Title"><meta property="og:image" content="https://example.com/live.jpg"></head></html>',
      request: { res: { responseUrl: url } },
    }));

    const previewRes = await fetch(`${base}/preview?url=${encodeURIComponent('https://youtube.com/watch?v=multi123')}`, { headers: authCaller });
    assert.equal(previewRes.status, 200);
    const body = await previewRes.json();
    assert.equal(body.title, 'Live YouTube Title');
    assert.ok(body.already_on_sphir, 'already_on_sphir should be non-null');
    assert.equal(body.already_on_sphir.count, 2);
    // Most recent row saved is user2's
    assert.equal(body.already_on_sphir.title, 'Second Variant Title');
    assert.equal(body.already_on_sphir.image, 'https://example.com/thumb2.jpg');
    assert.equal(body.already_on_sphir.price, '$29.99');
    // Description and tags can hold the other user's own notes (S3): never shared.
    assert.equal(body.already_on_sphir.description, undefined);
    assert.equal(body.already_on_sphir.tags, undefined);

    // Privacy (S3): verify no user info or business ids leaked
    assert.equal(body.already_on_sphir.user_id, undefined);
    assert.equal(body.already_on_sphir.email, undefined);
    assert.equal(body.already_on_sphir.first_name, undefined);
    assert.equal(body.already_on_sphir.last_name, undefined);
    assert.equal(body.already_on_sphir.id, undefined);
    assert.deepEqual(Object.keys(body.already_on_sphir).sort(), ['count', 'image', 'price', 'title']);
  });

  // (c) the caller's own save is counted
  await t.test('(c) the caller\'s own save is counted', async (st) => {
    const resCaller = await fetch(`${base}/businesses`, {
      method: 'POST',
      headers: authCaller,
      body: JSON.stringify({
        title: 'Caller Saved Title',
        website: 'https://youtube.com/watch?v=multi123&si=ref_share',
        og_image: 'https://example.com/caller_thumb.jpg',
        description: 'Caller description',
      }),
    });
    assert.equal(resCaller.status, 201);

    const axios = require('axios');
    st.mock.method(axios, 'get', async (url) => ({
      data: '<html><head><meta property="og:title" content="Live YouTube Title"></head></html>',
      request: { res: { responseUrl: url } },
    }));

    const previewRes = await fetch(`${base}/preview?url=${encodeURIComponent('https://www.youtube.com/watch?v=multi123')}`, { headers: authCaller });
    assert.equal(previewRes.status, 200);
    const body = await previewRes.json();
    assert.ok(body.already_on_sphir);
    assert.equal(body.already_on_sphir.count, 3);
    assert.equal(body.already_on_sphir.title, 'Caller Saved Title');
  });

  // (d) page fetch fails but link saved -> 200 with stored info
  await t.test('(d) page fetch fails but link saved -> 200 with stored info', async (st) => {
    const axios = require('axios');
    st.mock.method(axios, 'get', async () => {
      throw new Error('Network timeout');
    });

    const previewRes = await fetch(`${base}/preview?url=${encodeURIComponent('https://youtube.com/watch?v=multi123')}`, { headers: authCaller });
    assert.equal(previewRes.status, 200);
    const body = await previewRes.json();
    assert.equal(body.title, 'Caller Saved Title');
    assert.equal(body.image, 'https://example.com/caller_thumb.jpg');
    assert.equal(body.description, '');
    assert.deepEqual(body.tags, []);
    assert.ok(body.already_on_sphir);
    assert.equal(body.already_on_sphir.count, 3);
    assert.equal(body.already_on_sphir.title, 'Caller Saved Title');
  });

  // (e) page fetch fails and not saved -> 422 as today
  await t.test('(e) page fetch fails and not saved -> 422 as today', async (st) => {
    const axios = require('axios');
    st.mock.method(axios, 'get', async () => {
      throw new Error('Connection refused');
    });

    const previewRes = await fetch(`${base}/preview?url=${encodeURIComponent('https://example.org/never-saved-fail')}`, { headers: authCaller });
    assert.equal(previewRes.status, 422);
    const body = await previewRes.json();
    assert.deepEqual(body, { error: 'Could not fetch metadata' });
  });

  // (f) POST then PUT business stores the right link_key (check via the preview count, not the DB directly)
  await t.test('(f) POST then PUT business stores the right link_key', async (st) => {
    const axios = require('axios');
    st.mock.method(axios, 'get', async (url) => ({
      data: '<html><head><meta property="og:title" content="Page"></head></html>',
      request: { res: { responseUrl: url } },
    }));

    // Create card with original URL
    const postRes = await fetch(`${base}/businesses`, {
      method: 'POST',
      headers: authUser1,
      body: JSON.stringify({
        title: 'Original Card',
        website: 'https://m.store.example.com/item/999?utm_medium=email',
      }),
    });
    assert.equal(postRes.status, 201);
    const card = await postRes.json();

    // Check preview count for original URL is 1
    const prev1 = await (await fetch(`${base}/preview?url=${encodeURIComponent('https://store.example.com/item/999')}`, { headers: authCaller })).json();
    assert.ok(prev1.already_on_sphir);
    assert.equal(prev1.already_on_sphir.count, 1);

    // PUT to update website to new URL
    const putRes = await fetch(`${base}/businesses/${card.id}`, {
      method: 'PUT',
      headers: authUser1,
      body: JSON.stringify({
        website: 'https://www.store.example.com/item/1000?fbclid=xyz&gclid=abc',
      }),
    });
    assert.equal(putRes.status, 200);

    // Check original URL preview count is now 0 (null)
    const prevOld = await (await fetch(`${base}/preview?url=${encodeURIComponent('https://store.example.com/item/999')}`, { headers: authCaller })).json();
    assert.equal(prevOld.already_on_sphir, null);

    // Check new URL preview count is now 1
    const prevNew = await (await fetch(`${base}/preview?url=${encodeURIComponent('https://store.example.com/item/1000')}`, { headers: authCaller })).json();
    assert.ok(prevNew.already_on_sphir);
    assert.equal(prevNew.already_on_sphir.count, 1);
  });

  // Startup backfill test
  await t.test('startup backfill populates link_key for rows with website and empty link_key', async (st) => {
    const axios = require('axios');
    st.mock.method(axios, 'get', async (url) => ({
      data: '<html><head><meta property="og:title" content="Backfill"></head></html>',
      request: { res: { responseUrl: url } },
    }));

    // Insert directly with empty link_key
    await pool.query(
      `INSERT INTO businesses (user_id, title, description, website, tags, og_image, price, link_key)
       VALUES ($1, 'Backfill Title', 'Backfill Desc', 'https://www.backfilled.example.com/item/77?utm_source=bf', '[]'::jsonb, '', '', '')`,
      [1]
    );

    // Run startup migration/backfill
    await migrate();

    // Check that GET /preview finds it
    const prev = await (await fetch(`${base}/preview?url=${encodeURIComponent('https://backfilled.example.com/item/77')}`, { headers: authCaller })).json();
    assert.ok(prev.already_on_sphir);
    assert.equal(prev.already_on_sphir.count, 1);
    assert.equal(prev.already_on_sphir.title, 'Backfill Title');
  });
});
