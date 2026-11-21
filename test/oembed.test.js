const test = require('node:test');
const assert = require('node:assert/strict');
const { mapOembed } = require('../lib/oembed');

const URL_ = 'https://youtu.be/dQw4w9WgXcQ';

test('maps YouTube oEmbed JSON to the preview contract', () => {
  const out = mapOembed({ title: 'Never Gonna', author_name: 'Rick', thumbnail_url: 'http://i.ytimg.com/vi/x/hq.jpg' }, URL_);
  assert.deepEqual(out, {
    url: URL_, title: 'Never Gonna', description: 'Rick', image: 'https://i.ytimg.com/vi/x/hq.jpg',
    type: 'video', tags: [], price: '', site: 'YouTube', published: '',
  });
});

test('missing oEmbed fields become empty strings', () => {
  const out = mapOembed({}, URL_);
  assert.equal(out.title, '');
  assert.equal(out.description, '');
  assert.equal(out.image, '');
  assert.equal(out.type, 'video');
  assert.equal(out.url, URL_);
});

test('non-object oEmbed input does not throw', () => {
  assert.equal(mapOembed(null, URL_).title, '');
});
