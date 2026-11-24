const test = require('node:test');
const assert = require('node:assert/strict');
const aiCard = require('../lib/aiCard');

test('aiCard unit tests', async (t) => {
  // 1. no key -> null and no request
  await t.test('no key -> null and no request', async (st) => {
    let called = false;
    st.mock.method(aiCard, 'requestAnthropic', async () => {
      called = true;
      return {};
    });

    const res = await aiCard.enrichCard(
      { url: 'https://example.com', meta: {}, text: 'sample', collections: [] },
      { apiKey: '' }
    );
    assert.equal(res, null);
    assert.equal(called, false);
  });

  // 1b. an upstream error body is never logged (it could echo the key)
  await t.test('API error logs only the status, never the response body', async (st) => {
    st.mock.method(globalThis, 'fetch', async () => ({
      ok: false,
      status: 401,
      text: async () => 'invalid x-api-key secret-key-123',
    }));
    const warnings = [];
    st.mock.method(console, 'warn', (...args) => { warnings.push(args.join(' ')); });

    const res = await aiCard.enrichCard(
      { url: 'https://example.com', meta: {}, text: 'sample', collections: [] },
      { apiKey: 'secret-key-123' }
    );
    assert.equal(res, null);
    assert.ok(warnings.some(w => w.includes('401')), 'status is logged');
    assert.ok(warnings.every(w => !w.includes('secret-key-123')), 'key never logged');
  });

  // 2. valid tool_use -> mapped fields
  await t.test('valid tool_use -> mapped fields', async (st) => {
    st.mock.method(aiCard, 'requestAnthropic', async () => ({
      content: [
        {
          type: 'tool_use',
          name: 'card',
          input: {
            title: 'Clean AI Title',
            description: 'Short AI description.',
            price: '$49.99',
            type: 'product',
            collection_id: 10,
          },
        },
      ],
    }));

    const res = await aiCard.enrichCard(
      {
        url: 'https://example.com/item',
        meta: { title: 'Raw Title', price: '$50' },
        text: 'Some product page text',
        collections: [{ id: 10, name: 'Wishlist' }],
      },
      { apiKey: 'sk-ant-test' }
    );

    assert.deepEqual(res, {
      title: 'Clean AI Title',
      description: 'Short AI description.',
      price: '$49.99',
      type: 'product',
      collection_id: 10,
    });
  });

  // 3. collection_id not in list -> null
  await t.test('collection_id not in list -> null', async (st) => {
    st.mock.method(aiCard, 'requestAnthropic', async () => ({
      content: [
        {
          type: 'tool_use',
          name: 'card',
          input: {
            title: 'Title',
            description: 'Desc',
            price: '',
            type: 'link',
            collection_id: 999,
          },
        },
      ],
    }));

    const res = await aiCard.enrichCard(
      {
        url: 'https://example.com',
        meta: {},
        text: '',
        collections: [{ id: 10, name: 'Wishlist' }],
      },
      { apiKey: 'sk-ant-test' }
    );

    assert.ok(res);
    assert.equal(res.collection_id, null);
  });

  // 4. too-long title truncated (and desc, price)
  await t.test('too-long title truncated', async (st) => {
    const longTitle = '   ' + 'A'.repeat(250) + '   ';
    const longDesc = 'B'.repeat(600);
    const longPrice = 'C'.repeat(100);

    st.mock.method(aiCard, 'requestAnthropic', async () => ({
      content: [
        {
          type: 'tool_use',
          name: 'card',
          input: {
            title: longTitle,
            description: longDesc,
            price: longPrice,
            type: 'article',
            collection_id: null,
          },
        },
      ],
    }));

    const res = await aiCard.enrichCard(
      { url: 'https://example.com', meta: {}, text: '', collections: [] },
      { apiKey: 'sk-ant-test' }
    );

    assert.ok(res);
    assert.equal(res.title.length, 200);
    assert.equal(res.title, 'A'.repeat(200));
    assert.equal(res.description.length, 500);
    assert.equal(res.description, 'B'.repeat(500));
    assert.equal(res.price.length, 50);
    assert.equal(res.price, 'C'.repeat(50));
  });

  // 5. wrong type enum -> field ignored
  await t.test('wrong type enum -> field ignored', async (st) => {
    st.mock.method(aiCard, 'requestAnthropic', async () => ({
      content: [
        {
          type: 'tool_use',
          name: 'card',
          input: {
            title: 'Some Title',
            description: 'Some Desc',
            price: '$10',
            type: 'invalid_type_enum',
            collection_id: null,
          },
        },
      ],
    }));

    const res = await aiCard.enrichCard(
      { url: 'https://example.com', meta: {}, text: '', collections: [] },
      { apiKey: 'sk-ant-test' }
    );

    assert.ok(res);
    assert.equal(res.title, 'Some Title');
    assert.equal(res.type, undefined);
    assert.equal('type' in res, false);
  });

  // 6. requestAnthropic throws -> null
  await t.test('requestAnthropic throws -> null', async (st) => {
    st.mock.method(aiCard, 'requestAnthropic', async () => {
      throw new Error('Anthropic 500 Internal Error');
    });

    const res = await aiCard.enrichCard(
      { url: 'https://example.com', meta: {}, text: '', collections: [] },
      { apiKey: 'sk-ant-test' }
    );

    assert.equal(res, null);
  });

  // 7. timeout -> null (stub that waits for the abort signal)
  await t.test('timeout -> null (stub that waits for the abort signal)', async (st) => {
    st.mock.method(aiCard, 'requestAnthropic', async (_body, { signal }) => {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const res = await aiCard.enrichCard(
      { url: 'https://example.com', meta: {}, text: '', collections: [] },
      { apiKey: 'sk-ant-test', timeoutMs: 50 }
    );

    assert.equal(res, null);
  });

  // 8. request body uses model claude-haiku-5-5 and forced tool card and includes the collection names
  await t.test('request body uses model claude-haiku-5-5 and forced tool card and includes the collection names', async (st) => {
    let capturedBody = null;
    st.mock.method(aiCard, 'requestAnthropic', async (body) => {
      capturedBody = body;
      return {
        content: [
          {
            type: 'tool_use',
            name: 'card',
            input: {
              title: 'Body Test',
              description: 'Body Desc',
              price: '',
              type: 'link',
              collection_id: null,
            },
          },
        ],
      };
    });

    await aiCard.enrichCard(
      {
        url: 'https://example.com/test',
        meta: { title: 'Old Title', description: 'Old Desc', site: 'Example', type: 'link', price: '' },
        text: 'Visible page excerpt text',
        collections: [
          { id: 1, name: 'Tech Articles' },
          { id: 2, name: 'Cooking Recipes' },
        ],
      },
      { apiKey: 'sk-ant-test' }
    );

    assert.ok(capturedBody);
    assert.equal(capturedBody.model, 'claude-haiku-5-5');
    assert.equal(capturedBody.max_tokens, 600);
    assert.deepEqual(capturedBody.tool_choice, { type: 'tool', name: 'card' });
    assert.ok(Array.isArray(capturedBody.tools));
    const cardTool = capturedBody.tools.find((tool) => tool.name === 'card');
    assert.ok(cardTool);
    assert.ok(cardTool.input_schema);
    assert.deepEqual(cardTool.input_schema.properties.type.enum, ['product', 'recipe', 'video', 'article', 'social', 'link']);

    // System prompt requirement
    assert.match(capturedBody.system, /untrusted data/i);
    assert.match(capturedBody.system, /never instructions/i);

    // User message requirement
    const userMessage = capturedBody.messages.find((m) => m.role === 'user');
    assert.ok(userMessage);
    assert.match(userMessage.content, /Tech Articles/);
    assert.match(userMessage.content, /Cooking Recipes/);
    assert.match(userMessage.content, /1: Tech Articles/);
    assert.match(userMessage.content, /2: Cooking Recipes/);
    assert.match(userMessage.content, /https:\/\/example\.com\/test/);
    assert.match(userMessage.content, /Visible page excerpt text/);
  });

  // pageText helper
  await t.test('pageText strips scripts, styles, tags, collapses whitespace, max 6000 chars', () => {
    assert.equal(aiCard.pageText(null), '');
    assert.equal(aiCard.pageText(''), '');

    const html = `
      <html>
        <head>
          <style>body { color: red; }</style>
          <script>console.log("secret code");</script>
        </head>
        <body>
          <h1>Hello   World!</h1>
          <p>This is a <b>test</b> of   whitespace.</p>
          <script type="text/javascript">
            alert("another script");
          </script>
        </body>
      </html>
    `;
    assert.equal(aiCard.pageText(html), 'Hello World! This is a test of whitespace.');

    const hugeHtml = '<p>' + 'word '.repeat(2000) + '</p>';
    const excerpt = aiCard.pageText(hugeHtml);
    assert.ok(excerpt.length <= 6000);
  });

  // S10: only the first ~200KB of HTML is read
  await t.test('pageText reads only the first 200KB of HTML (S10)', () => {
    const html = '<div>' + ' '.repeat(210 * 1024) + '</div><p>tail marker</p>';
    assert.equal(aiCard.pageText(html), '');
    assert.equal(aiCard.pageText('<p>head marker</p>' + ' '.repeat(210 * 1024)), 'head marker');
  });

  // S10: crafted HTML cannot stall the server
  await t.test('pageText stays fast on crafted HTML (unclosed scripts and tags) (S10)', () => {
    for (const crafted of ['<script'.repeat(40000), '<a'.repeat(100000), '<style x'.repeat(30000)]) {
      const start = process.hrtime.bigint();
      aiCard.pageText(crafted);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      assert.ok(ms < 200, `took ${ms}ms`);
    }
    assert.equal(aiCard.pageText('<p>a</p><script>x</script'), 'a');
    assert.equal(aiCard.pageText('<scripts>kept</scripts>'), 'kept');
    assert.equal(aiCard.pageText('<style-x>custom</style-x><script_x>el</script_x>'), 'custom el');
    assert.equal(aiCard.pageText('<p>İstanbul İİİ</p><script>var leak = 1;</script><p>end</p>'), 'İstanbul İİİ end');
    assert.equal(aiCard.pageText('<SCRIPT type="x">hidden</SCRIPT><style/>z</style>ok'), 'ok');
  });

  // S9: default AI timeout is about 4 seconds
  await t.test('default timeout aborts the AI call after 4 seconds, not before (S9)', async (st) => {
    st.mock.timers.enable({ apis: ['setTimeout'] });
    let aborted = false;
    st.mock.method(aiCard, 'requestAnthropic', async (_body, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }));
    const pending = aiCard.enrichCard(
      { url: 'https://example.com', meta: {}, text: '', collections: [] },
      { apiKey: 'sk-ant-test' }
    );
    st.mock.timers.tick(3999);
    assert.equal(aborted, false);
    st.mock.timers.tick(1);
    assert.equal(aborted, true);
    assert.equal(await pending, null);
  });
});
