const test = require('node:test');
const assert = require('node:assert/strict');
const { mapOembed, mapTweetOembed } = require('../lib/oembed');

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

const JACK_URL = 'https://x.com/jack/status/20';
const JACK_OEMBED = {
  url: 'https://x.com/jack/status/20',
  author_name: 'jack',
  author_url: 'https://x.com/jack',
  html: '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">just setting up my twttr</p>&mdash; jack (@jack) <a href="https://x.com/jack/status/20?ref_src=twsrc%5Etfw">March 21, 2006</a></blockquote>\n\n',
};

test('maps Twitter/X oEmbed JSON to the preview contract', () => {
  const out = mapTweetOembed(JACK_OEMBED, JACK_URL);
  assert.deepEqual(out, {
    url: JACK_URL,
    title: 'just setting up my twttr',
    description: '@jack on X',
    image: '',
    type: 'social',
    tags: [],
    price: '',
    site: 'X',
    published: '',
  });
});

test('decodes HTML entities in tweet text', () => {
  const data = {
    author_name: 'alice',
    html: '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &mdash; f</p></blockquote>',
  };
  const out = mapTweetOembed(data, 'https://x.com/alice/status/1');
  assert.equal(out.title, 'a & b <c> "d" \'e\' — f');
  assert.equal(out.description, '@alice on X');
  assert.equal(out.type, 'social');
});

test('strips inner tags inside <p>', () => {
  const data = {
    author_name: 'bob',
    html: '<blockquote class="twitter-tweet"><p>Check out <a href="https://t.co/abc">this link</a> and <b>bold text</b></p></blockquote>',
  };
  const out = mapTweetOembed(data, 'https://x.com/bob/status/2');
  assert.equal(out.title, 'Check out this link and bold text');
});

test('returns null for missing or empty html', () => {
  assert.equal(mapTweetOembed({}, JACK_URL), null);
  assert.equal(mapTweetOembed({ html: '' }, JACK_URL), null);
  assert.equal(mapTweetOembed({ html: '   ' }, JACK_URL), null);
  assert.equal(mapTweetOembed({ html: '<blockquote>no p tag</blockquote>' }, JACK_URL), null);
  assert.equal(mapTweetOembed({ html: '<p>   </p>' }, JACK_URL), null);
});

test('non-object tweet oEmbed input does not throw', () => {
  assert.equal(mapTweetOembed(null, JACK_URL), null);
  assert.equal(mapTweetOembed(undefined, JACK_URL), null);
  assert.equal(mapTweetOembed('string', JACK_URL), null);
  assert.equal(mapTweetOembed(123, JACK_URL), null);
});
