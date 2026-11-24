const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const axios = require('axios');
const aiCard = require('../lib/aiCard');

const baseTestDb = process.env.SPHIR_TEST_DB;
const testDb = baseTestDb && `${baseTestDb}_ai`;

test('preview AI routes', { skip: !baseTestDb && 'SPHIR_TEST_DB not set' }, async (t) => {
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
  t.after(async () => {
    server.close();
    await pool.end();
  });

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

  async function createFolder(authHeaders, name) {
    const res = await fetch(`${base}/folders`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name }),
    });
    return res.json();
  }

  const savedApiKey = process.env.ANTHROPIC_API_KEY;
  t.afterEach(() => {
    if (savedApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = savedApiKey;
    }
  });

  // 1. with ANTHROPIC_API_KEY set and requestAnthropic stubbed -> GET and POST /preview return AI title/description/type, ai: true and the suggested collection id of the caller's own folder
  await t.test('with ANTHROPIC_API_KEY set and requestAnthropic stubbed -> GET and POST /preview return AI fields', async (st) => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key';

    const callerAuth = await signUp(`caller_1_${Date.now()}@example.com`);
    const callerFolder = await createFolder(callerAuth, 'Caller Favorites');

    st.mock.method(aiCard, 'requestAnthropic', async () => ({
      content: [
        {
          type: 'tool_use',
          name: 'card',
          input: {
            title: 'AI Smart Title',
            description: 'AI summary description.',
            price: '$35.00',
            type: 'product',
            collection_id: callerFolder.id,
          },
        },
      ],
    }));

    st.mock.method(axios, 'get', async (url) => ({
      data: '<html><head><title>Raw Page Title</title></head><body><p>Visible content</p></body></html>',
      request: { res: { responseUrl: url } },
    }));

    // GET /preview
    const getRes = await fetch(`${base}/preview?url=${encodeURIComponent('https://example.com/item-1')}`, {
      headers: callerAuth,
    });
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(getBody.title, 'AI Smart Title');
    assert.equal(getBody.description, 'AI summary description.');
    assert.equal(getBody.price, '$35.00');
    assert.equal(getBody.type, 'product');
    assert.equal(getBody.ai, true);
    assert.equal(getBody.suggested_collection_id, callerFolder.id);

    // POST /preview
    const postRes = await fetch(`${base}/preview`, {
      method: 'POST',
      headers: callerAuth,
      body: JSON.stringify({
        url: 'https://example.com/item-1-post',
        html: '<html><head><title>Posted Title</title></head><body>Posted content</body></html>',
      }),
    });
    assert.equal(postRes.status, 200);
    const postBody = await postRes.json();
    assert.equal(postBody.title, 'AI Smart Title');
    assert.equal(postBody.description, 'AI summary description.');
    assert.equal(postBody.price, '$35.00');
    assert.equal(postBody.type, 'product');
    assert.equal(postBody.ai, true);
    assert.equal(postBody.suggested_collection_id, callerFolder.id);
  });

  // 2. a collection id of ANOTHER user's folder returned by the stub -> suggested_collection_id: null
  await t.test("a collection id of ANOTHER user's folder returned by the stub -> suggested_collection_id: null", async (st) => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key';

    const callerAuth = await signUp(`caller_2_${Date.now()}@example.com`);
    await createFolder(callerAuth, 'Caller Folder');
    const otherAuth = await signUp(`other_2_${Date.now()}@example.com`);
    const otherFolder = await createFolder(otherAuth, 'Other User Folder');

    st.mock.method(aiCard, 'requestAnthropic', async () => ({
      content: [
        {
          type: 'tool_use',
          name: 'card',
          input: {
            title: 'AI Title',
            description: 'AI Description',
            price: '',
            type: 'article',
            collection_id: otherFolder.id, // belongs to another user!
          },
        },
      ],
    }));

    st.mock.method(axios, 'get', async (url) => ({
      data: '<html><head><title>Raw Page</title></head></html>',
      request: { res: { responseUrl: url } },
    }));

    const res = await fetch(`${base}/preview?url=${encodeURIComponent('https://example.com/other-folder-test')}`, {
      headers: callerAuth,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ai, true);
    assert.equal(body.suggested_collection_id, null);
  });

  // 3. AI throws -> response equals today's meta with ai: false (S7)
  await t.test("AI throws -> response equals today's meta with ai: false (S7)", async (st) => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key';

    const callerAuth = await signUp(`caller_3_${Date.now()}@example.com`);

    st.mock.method(aiCard, 'requestAnthropic', async () => {
      throw new Error('Claude AI rate limited');
    });

    st.mock.method(axios, 'get', async (url) => ({
      data: '<html><head><title>Original Page Title</title><meta property="og:description" content="Original Description"></head></html>',
      request: { res: { responseUrl: url } },
    }));

    const res = await fetch(`${base}/preview?url=${encodeURIComponent('https://example.com/ai-throws-test')}`, {
      headers: callerAuth,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.title, 'Original Page Title');
    assert.equal(body.description, 'Original Description');
    assert.equal(body.ai, false);
    assert.equal(body.suggested_collection_id, null);
    assert.equal(body.already_on_sphir, null);
  });

  // 4. no ANTHROPIC_API_KEY -> requestAnthropic never called and ai: false
  await t.test('no ANTHROPIC_API_KEY -> requestAnthropic never called and ai: false', async (st) => {
    delete process.env.ANTHROPIC_API_KEY;

    const callerAuth = await signUp(`caller_4_${Date.now()}@example.com`);

    let called = false;
    st.mock.method(aiCard, 'requestAnthropic', async () => {
      called = true;
      return {};
    });

    st.mock.method(axios, 'get', async (url) => ({
      data: '<html><head><title>No AI Page</title></head></html>',
      request: { res: { responseUrl: url } },
    }));

    const res = await fetch(`${base}/preview?url=${encodeURIComponent('https://example.com/no-ai-key-test')}`, {
      headers: callerAuth,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(called, false);
    assert.equal(body.title, 'No AI Page');
    assert.equal(body.ai, false);
    assert.equal(body.suggested_collection_id, null);
  });

  // 5. link already on Sphir -> requestAnthropic never called (S8) and already_on_sphir present in both GET and POST
  await t.test('link already on Sphir -> requestAnthropic never called (S8) and already_on_sphir present in both GET and POST', async (st) => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key';

    const userAuth = await signUp(`saver_${Date.now()}@example.com`);
    const callerAuth = await signUp(`caller_5_${Date.now()}@example.com`);

    const saveRes = await fetch(`${base}/businesses`, {
      method: 'POST',
      headers: userAuth,
      body: JSON.stringify({
        title: 'Already Saved Title',
        website: 'https://example.com/already-saved-link?utm_source=sphir',
        og_image: 'https://example.com/thumb.jpg',
        price: '$15.00',
      }),
    });
    assert.equal(saveRes.status, 201);

    let called = false;
    st.mock.method(aiCard, 'requestAnthropic', async () => {
      called = true;
      throw new Error('Should never call AI when already on Sphir (S8)');
    });

    st.mock.method(axios, 'get', async (url) => ({
      data: '<html><head><title>Live Title</title></head></html>',
      request: { res: { responseUrl: url } },
    }));

    // GET /preview
    const getRes = await fetch(`${base}/preview?url=${encodeURIComponent('https://example.com/already-saved-link')}`, {
      headers: callerAuth,
    });
    assert.equal(getRes.status, 200);
    const getBody = await getRes.json();
    assert.equal(called, false);
    assert.ok(getBody.already_on_sphir);
    assert.equal(getBody.already_on_sphir.count, 1);
    assert.equal(getBody.already_on_sphir.title, 'Already Saved Title');
    assert.equal(getBody.ai, false);
    assert.equal(getBody.suggested_collection_id, null);

    // POST /preview
    const postRes = await fetch(`${base}/preview`, {
      method: 'POST',
      headers: callerAuth,
      body: JSON.stringify({
        url: 'https://example.com/already-saved-link',
        html: '<html><head><title>Live Title</title></head></html>',
      }),
    });
    assert.equal(postRes.status, 200);
    const postBody = await postRes.json();
    assert.equal(called, false);
    assert.ok(postBody.already_on_sphir);
    assert.equal(postBody.already_on_sphir.count, 1);
    assert.equal(postBody.already_on_sphir.title, 'Already Saved Title');
    assert.equal(postBody.ai, false);
    assert.equal(postBody.suggested_collection_id, null);
  });

  // 6. lookup query failing -> preview still 200 with already_on_sphir: null
  await t.test('lookup query failing -> preview still 200 with already_on_sphir: null', async (st) => {
    delete process.env.ANTHROPIC_API_KEY;

    const callerAuth = await signUp(`caller_6_${Date.now()}@example.com`);

    st.mock.method(axios, 'get', async (url) => ({
      data: '<html><head><title>Resilient Page</title></head></html>',
      request: { res: { responseUrl: url } },
    }));

    const originalQuery = pool.query.bind(pool);
    st.mock.method(pool, 'query', async (sql, params) => {
      if (typeof sql === 'string' && sql.includes('link_key')) {
        throw new Error('Database error on link_key query');
      }
      return originalQuery(sql, params);
    });

    const res = await fetch(`${base}/preview?url=${encodeURIComponent('https://example.com/failing-lookup-test')}`, {
      headers: callerAuth,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.title, 'Resilient Page');
    assert.equal(body.already_on_sphir, null);
    assert.equal(body.ai, false);
    assert.equal(body.suggested_collection_id, null);
  });
});
