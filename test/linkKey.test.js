const test = require('node:test');
const assert = require('node:assert/strict');
const { linkKey } = require('../lib/linkKey');

test('S2 example: m.youtube.com with utm and www.youtube.com produce identical key', () => {
  const url1 = 'https://m.youtube.com/watch?v=abc&utm_source=x';
  const url2 = 'https://www.youtube.com/watch?v=abc';
  assert.equal(linkKey(url1), 'youtube.com/watch?v=abc');
  assert.equal(linkKey(url2), 'youtube.com/watch?v=abc');
  assert.equal(linkKey(url1), linkKey(url2));
});

test('tracking params removed: utm_* (any suffix), fbclid, gclid, si, igsh', () => {
  const base = 'https://example.com/post?id=42';
  const withTracking = 'https://example.com/post?utm_source=google&utm_medium=cpc&utm_campaign=spring&utm_term=shoes&utm_content=logolink&fbclid=fb123&gclid=gc456&si=si789&igsh=ig012&id=42';
  assert.equal(linkKey(withTracking), 'example.com/post?id=42');
  assert.equal(linkKey(base), 'example.com/post?id=42');
});

test('query params are sorted by name so order does not matter', () => {
  const url1 = 'https://example.com/search?q=sphir&page=2&filter=active';
  const url2 = 'https://example.com/search?filter=active&q=sphir&page=2';
  const url3 = 'https://example.com/search?page=2&filter=active&q=sphir';
  assert.equal(linkKey(url1), 'example.com/search?filter=active&page=2&q=sphir');
  assert.equal(linkKey(url2), 'example.com/search?filter=active&page=2&q=sphir');
  assert.equal(linkKey(url3), 'example.com/search?filter=active&page=2&q=sphir');
});

test('fragment is dropped', () => {
  assert.equal(linkKey('https://example.com/article#heading-2'), 'example.com/article');
  assert.equal(linkKey('https://example.com/article?id=1#heading-2'), 'example.com/article?id=1');
});

test('trailing slash of path is dropped, but root / becomes empty path', () => {
  assert.equal(linkKey('https://example.com/'), 'example.com');
  assert.equal(linkKey('https://example.com'), 'example.com');
  assert.equal(linkKey('https://example.com/path/'), 'example.com/path');
  assert.equal(linkKey('https://example.com/path'), 'example.com/path');
  assert.equal(linkKey('https://example.com/deep/path/'), 'example.com/deep/path');
});

test('uppercase host is lowercased, and www. / m. are dropped', () => {
  assert.equal(linkKey('https://WWW.EXAMPLE.COM/about'), 'example.com/about');
  assert.equal(linkKey('https://M.EXAMPLE.COM/about'), 'example.com/about');
  assert.equal(linkKey('http://SUB.EXAMPLE.COM/Page'), 'sub.example.com/Page');
});

test('invalid and empty inputs return empty string and never throw', () => {
  assert.equal(linkKey(''), '');
  assert.equal(linkKey('   '), '');
  assert.equal(linkKey(null), '');
  assert.equal(linkKey(undefined), '');
  assert.equal(linkKey(123), '');
  assert.equal(linkKey({}), '');
  assert.equal(linkKey('not a url'), '');
  assert.equal(linkKey('http://'), '');
  assert.equal(linkKey('javascript:alert(1)'), '');
  assert.equal(linkKey('mailto:user@example.com'), '');
});
