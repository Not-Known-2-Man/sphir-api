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
});
