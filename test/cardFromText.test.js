const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const aiCard = require('../lib/aiCard');

const baseTestDb = process.env.SPHIR_TEST_DB;
const testDb = baseTestDb && `${baseTestDb}_card_from_text`;

const AI_FALSE_BODY = {
  ai: false,
  title: '',
  description: '',
  price: '',
  type: null,
  suggested_collection_id: null,
};

test('POST /api/v1/ai/card-from-text', { skip: !baseTestDb && 'SPHIR_TEST_DB not set' }, async (t) => {
  let activeDb = baseTestDb;
  if (testDb) {
    const admin = new Client({ connectionString: `postgres://localhost/${baseTestDb}` });
    await admin.connect();
    try {
      const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [testDb]);
      if (rows.length === 0) {
        await admin.query(`CREATE DATABASE ${testDb}`);
      }
    } finally {
      await admin.end();
    }
    activeDb = testDb;
  }

  assert.match(activeDb, /^sphir_test\w*$/, 'database must be a scratch database named sphir_test*');
  const target = `postgres://localhost/${activeDb}`;
  process.env.DATABASE_URL = target;
  const { app, migrate, pool } = require('../server');
  assert.equal(process.env.DATABASE_URL, target, 'DATABASE_URL changed after loading the server');

  await pool.query('DROP TABLE IF EXISTS images, business_folders, businesses, folders, users CASCADE');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8'));
  await migrate();

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
      body: JSON.stringify({
        email,
        password: 'Password123!',
        password_confirmation: 'Password123!',
        first_name: 'Test',
        last_name: 'User',
      }),
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
  const savedLimit = process.env.AI_DAILY_LIMIT;
  t.afterEach(() => {
    if (savedApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = savedApiKey;
    }
    if (savedLimit === undefined) {
      delete process.env.AI_DAILY_LIMIT;
    } else {
      process.env.AI_DAILY_LIMIT = savedLimit;
    }
  });

  // S1: 422 for missing / non-string / whitespace-only text, no AI call, and counter not consumed
  await t.test('422 for missing, non-string, or whitespace-only text without calling AI or consuming quota (S1)', async (st) => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
    process.env.AI_DAILY_LIMIT = '1';
    const auth = await signUp(`cft_422_${Date.now()}@example.com`);

    let calls = 0;
    st.mock.method(aiCard, 'requestAnthropic', async () => {
      calls++;
      return {
        content: [{
          type: 'tool_use',
          name: 'card',
          input: { title: 'Valid', description: 'Desc', price: '', type: 'article', collection_id: null },
        }],
      };
    });

    for (const payload of [{}, { text: 123 }, { text: null }, { text: '   \n\t  ' }]) {
      const res = await fetch(`${base}/ai/card-from-text`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 422);
      assert.deepEqual(await res.json(), { error: 'text is required' });
    }
    assert.equal(calls, 0);

    // Daily quota was not consumed by the 422s
    const okRes = await fetch(`${base}/ai/card-from-text`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: 'Receipt from Coffee Shop $4.50' }),
    });
    assert.equal(okRes.status, 200);
    const okBody = await okRes.json();
    assert.equal(okBody.ai, true);
    assert.equal(calls, 1);
  });

  // S2: success with stubbed AI returns exact ai:true shape and user's own folder id
  await t.test('success with stubbed AI returns exact ai:true shape and own folder id (S2)', async (st) => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
    const auth = await signUp(`cft_ok_${Date.now()}@example.com`);
    const folder = await createFolder(auth, 'Shopping List');

    let capturedBody = null;
    st.mock.method(aiCard, 'requestAnthropic', async (body) => {
      capturedBody = body;
      return {
        content: [{
          type: 'tool_use',
          name: 'card',
          input: {
            title: 'Sony WH-1000XM5 Headphones',
            description: 'Wireless noise-canceling headphones from screenshot.',
            price: '$349.99',
            type: 'product',
            collection_id: folder.id,
          },
        }],
      };
    });

    const res = await fetch(`${base}/ai/card-from-text`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: 'Sony WH-1000XM5 $349.99 Add to Cart' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ai: true,
      title: 'Sony WH-1000XM5 Headphones',
      description: 'Wireless noise-canceling headphones from screenshot.',
      price: '$349.99',
      type: 'product',
      suggested_collection_id: folder.id,
    });

    assert.ok(capturedBody);
    assert.match(capturedBody.system, /untrusted data/i);
    assert.match(capturedBody.system, /never instructions/i);
    const userMsg = capturedBody.messages.find((m) => m.role === 'user')?.content || '';
    assert.match(userMsg, /photo|screenshot/i);
  });

  // S2: suggested_collection_id of ANOTHER user's folder becomes null
  await t.test("suggested_collection_id of another user's folder becomes null (S2)", async (st) => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
    const callerAuth = await signUp(`cft_caller_${Date.now()}@example.com`);
    await createFolder(callerAuth, 'My Folder');
    const otherAuth = await signUp(`cft_other_${Date.now()}@example.com`);
    const otherFolder = await createFolder(otherAuth, 'Other Folder');

    st.mock.method(aiCard, 'requestAnthropic', async () => ({
      content: [{
        type: 'tool_use',
        name: 'card',
        input: {
          title: 'Pasta Recipe',
          description: 'Quick dinner.',
          price: '',
          type: 'recipe',
          collection_id: otherFolder.id,
        },
      }],
    }));

    const res = await fetch(`${base}/ai/card-from-text`, {
      method: 'POST',
      headers: callerAuth,
      body: JSON.stringify({ text: 'Boil water, add pasta' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ai: true,
      title: 'Pasta Recipe',
      description: 'Quick dinner.',
      price: '',
      type: 'recipe',
      suggested_collection_id: null,
    });
  });

  // S1: truncation: text passed to AI is at most 6000 chars
  await t.test('text longer than 6000 characters is truncated to 6000 before going to Claude (S1)', async (st) => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
    const auth = await signUp(`cft_trunc_${Date.now()}@example.com`);

    let capturedUserContent = '';
    st.mock.method(aiCard, 'requestAnthropic', async (body) => {
      capturedUserContent = body.messages.find((m) => m.role === 'user')?.content || '';
      return {
        content: [{
          type: 'tool_use',
          name: 'card',
          input: { title: 'Truncated', description: 'Desc', price: '', type: 'article', collection_id: null },
        }],
      };
    });

    const longText = 'A'.repeat(6000) + 'TAIL_MARKER_SHOULD_NOT_APPEAR';
    const res = await fetch(`${base}/ai/card-from-text`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: longText }),
    });
    assert.equal(res.status, 200);
    assert.equal(capturedUserContent.includes('TAIL_MARKER_SHOULD_NOT_APPEAR'), false);
    assert.equal(capturedUserContent.includes('A'.repeat(6000)), true);
  });

  // S3: no ANTHROPIC_API_KEY -> exact ai:false body and no AI call
  await t.test('no ANTHROPIC_API_KEY -> 200 with exact ai:false body and no AI call (S3)', async (st) => {
    delete process.env.ANTHROPIC_API_KEY;
    const auth = await signUp(`cft_nokey_${Date.now()}@example.com`);

    let called = false;
    st.mock.method(aiCard, 'requestAnthropic', async () => {
      called = true;
      return {};
    });

    const res = await fetch(`${base}/ai/card-from-text`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: 'Some screenshot text' }),
    });
    assert.equal(res.status, 200);
    assert.equal(called, false);
    assert.deepEqual(await res.json(), AI_FALSE_BODY);
  });

  // S3: AI throws -> exact ai:false body with 200
  await t.test('AI throws -> 200 with exact ai:false body (S3)', async (st) => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
    const auth = await signUp(`cft_throw_${Date.now()}@example.com`);

    st.mock.method(aiCard, 'requestAnthropic', async () => {
      throw new Error('Claude unavailable');
    });

    const res = await fetch(`${base}/ai/card-from-text`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: 'Some screenshot text' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), AI_FALSE_BODY);
  });

  // S3, S4: daily limit -> ai:false and AI stub not called
  await t.test('daily limit reached -> 200 with ai:false and AI stub not called (S3, S4)', async (st) => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
    process.env.AI_DAILY_LIMIT = '2';
    const auth = await signUp(`cft_limit_${Date.now()}@example.com`);

    let calls = 0;
    st.mock.method(aiCard, 'requestAnthropic', async () => {
      calls++;
      return {
        content: [{
          type: 'tool_use',
          name: 'card',
          input: { title: 'Card', description: 'Desc', price: '', type: 'link', collection_id: null },
        }],
      };
    });

    const callRoute = () => fetch(`${base}/ai/card-from-text`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: 'Sample OCR text' }),
    });

    assert.equal((await (await callRoute()).json()).ai, true);
    assert.equal((await (await callRoute()).json()).ai, true);
    const overRes = await callRoute();
    assert.equal(overRes.status, 200);
    assert.deepEqual(await overRes.json(), AI_FALSE_BODY);
    assert.equal(calls, 2);
  });

  // S4: daily limit is shared with the preview route
  await t.test('daily limit is shared with the preview route (S4)', async (st) => {
    process.env.ANTHROPIC_API_KEY = 'test-api-key';
    process.env.AI_DAILY_LIMIT = '2';
    const auth = await signUp(`cft_shared_${Date.now()}@example.com`);

    let calls = 0;
    st.mock.method(aiCard, 'requestAnthropic', async () => {
      calls++;
      return {
        content: [{
          type: 'tool_use',
          name: 'card',
          input: { title: 'Shared', description: 'Desc', price: '', type: 'article', collection_id: null },
        }],
      };
    });

    const previewRes = await fetch(`${base}/preview`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        url: `https://example.com/shared-limit-${Date.now()}`,
        html: '<html><head><title>Preview Page</title></head></html>',
      }),
    });
    assert.equal(previewRes.status, 200);
    assert.equal((await previewRes.json()).ai, true);

    const cftRes1 = await fetch(`${base}/ai/card-from-text`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: 'Second AI call via OCR' }),
    });
    assert.equal(cftRes1.status, 200);
    assert.equal((await cftRes1.json()).ai, true);

    const cftRes2 = await fetch(`${base}/ai/card-from-text`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ text: 'Third AI call should hit shared limit' }),
    });
    assert.equal(cftRes2.status, 200);
    assert.deepEqual(await cftRes2.json(), AI_FALSE_BODY);
    assert.equal(calls, 2);
  });

  // S1: unauthenticated -> same status the preview route returns
  await t.test('unauthenticated -> same status as preview route (S1)', async () => {
    const previewRes = await fetch(`${base}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', html: '<html></html>' }),
    });
    const cftRes = await fetch(`${base}/ai/card-from-text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Hello world' }),
    });
    assert.equal(cftRes.status, previewRes.status);
  });
});
