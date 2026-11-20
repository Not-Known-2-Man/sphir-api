const test = require('node:test');
const assert = require('node:assert/strict');
const { extractMetadata } = require('../lib/extractMetadata');

const page = (head, body = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

test('returns every contract field with defaults for a plain page', () => {
  const meta = extractMetadata(page('<title>Hello</title>'), 'https://www.example.com/a');
  assert.deepEqual(meta, {
    url: 'https://www.example.com/a',
    title: 'Hello',
    description: '',
    image: '',
    type: 'link',
    tags: [],
    price: '',
    site: 'example.com',
    published: '',
  });
});

test('JSON-LD Product with USD offer gives product type and $ price', () => {
  const html = page(ld({
    '@context': 'https://schema.org', '@type': 'Product', name: 'Foam Roller',
    description: 'Dense roller', image: 'https://cdn.shop.com/roller.jpg',
    offers: { '@type': 'Offer', price: '29.99', priceCurrency: 'USD' },
  }));
  const meta = extractMetadata(html, 'https://shop.com/roller');
  assert.equal(meta.type, 'product');
  assert.equal(meta.price, '$29.99');
  assert.equal(meta.title, 'Foam Roller');
  assert.equal(meta.description, 'Dense roller');
  assert.equal(meta.image, 'https://cdn.shop.com/roller.jpg');
});

test('non-USD currency is formatted as amount plus code', () => {
  const html = page(ld({ '@type': 'Product', name: 'X', offers: [{ price: 45, priceCurrency: 'EUR' }] }));
  assert.equal(extractMetadata(html, 'https://shop.eu/x').price, '45 EUR');
});

test('AggregateOffer lowPrice is used when price is missing', () => {
  const html = page(ld({ '@type': 'Product', name: 'X', offers: { '@type': 'AggregateOffer', lowPrice: '12.50', priceCurrency: 'USD' } }));
  assert.equal(extractMetadata(html, 'https://shop.com/x').price, '$12.50');
});

test('meta product:price tags are a price fallback', () => {
  const html = page('<meta property="og:type" content="product"><meta property="product:price:amount" content="19.00"><meta property="product:price:currency" content="USD">');
  const meta = extractMetadata(html, 'https://shop.com/y');
  assert.equal(meta.type, 'product');
  assert.equal(meta.price, '$19.00');
});

test('Recipe and VideoObject JSON-LD types', () => {
  assert.equal(extractMetadata(page(ld({ '@type': 'Recipe', name: 'Pasta' })), 'https://food.com/p').type, 'recipe');
  assert.equal(extractMetadata(page(ld({ '@type': 'VideoObject', name: 'Walk' })), 'https://v.com/w').type, 'video');
});

test('NewsArticle inside @graph is an article with published date', () => {
  const html = page(ld({ '@context': 'https://schema.org', '@graph': [
    { '@type': 'WebSite', name: 'Site' },
    { '@type': 'NewsArticle', headline: 'Why Recovery Hurts', datePublished: '2026-02-11T08:00:00Z', keywords: 'Recovery, Training' },
  ] }));
  const meta = extractMetadata(html, 'https://news.com/r');
  assert.equal(meta.type, 'article');
  assert.equal(meta.title, 'Why Recovery Hurts');
  assert.equal(meta.published, '2026-02-11');
  assert.deepEqual(meta.tags, ['Recovery', 'Training']);
});

test('@type given as an array is matched', () => {
  const html = page(ld([{ '@type': ['Thing', 'BlogPosting'], headline: 'Post' }]));
  assert.equal(extractMetadata(html, 'https://blog.com/p').type, 'article');
});

test('og:type is used when there is no JSON-LD type', () => {
  assert.equal(extractMetadata(page('<meta property="og:type" content="video.other">'), 'https://v.com/1').type, 'video');
  assert.equal(extractMetadata(page('<meta property="og:type" content="article">'), 'https://n.com/1').type, 'article');
});

test('JSON-LD type wins over og:type', () => {
  const html = page('<meta property="og:type" content="article">' + ld({ '@type': 'Recipe', name: 'Soup' }));
  assert.equal(extractMetadata(html, 'https://food.com/s').type, 'recipe');
});

test('domain rules classify video and social links', () => {
  const plain = page('<title>t</title>');
  assert.equal(extractMetadata(plain, 'https://www.youtube.com/watch?v=abc').type, 'video');
  assert.equal(extractMetadata(plain, 'https://youtu.be/abc').type, 'video');
  assert.equal(extractMetadata(plain, 'https://vimeo.com/1').type, 'video');
  assert.equal(extractMetadata(plain, 'https://www.tiktok.com/@a/video/1').type, 'video');
  assert.equal(extractMetadata(plain, 'https://www.instagram.com/reel/xyz/').type, 'social');
  assert.equal(extractMetadata(plain, 'https://www.instagram.com/p/xyz/').type, 'social');
  assert.equal(extractMetadata(plain, 'https://x.com/a/status/1').type, 'social');
  assert.equal(extractMetadata(plain, 'https://twitter.com/a/status/1').type, 'social');
  assert.equal(extractMetadata(plain, 'https://www.facebook.com/a/posts/1').type, 'social');
  assert.equal(extractMetadata(plain, 'https://www.threads.net/@a/post/1').type, 'social');
});

test('og:type wins over domain rules', () => {
  const html = page('<meta property="og:type" content="article">');
  assert.equal(extractMetadata(html, 'https://www.facebook.com/notes/1').type, 'article');
});

test('tags: keywords array, article:tag metas, dedupe, strip underscore, max 8', () => {
  const html = page(
    '<meta property="article:tag" content="Soreness"><meta property="article:tag" content="recovery">' +
    '<meta name="keywords" content="_hidden, Nine, Ten">' +
    ld({ '@type': 'Article', headline: 'h', keywords: ['Recovery', ' Training ', 'Calisthenics', 'Four', 'Five', 'Six'] })
  );
  const meta = extractMetadata(html, 'https://n.com/a');
  assert.deepEqual(meta.tags, ['Recovery', 'Training', 'Calisthenics', 'Four', 'Five', 'Six', 'Soreness', 'hidden']);
});

test('site comes from og:site_name, else hostname without www', () => {
  assert.equal(extractMetadata(page('<meta property="og:site_name" content="Calisthenics IE">'), 'https://calisthenics.ie/a').site, 'Calisthenics IE');
  assert.equal(extractMetadata(page(''), 'https://www.calisthenics.ie/a').site, 'calisthenics.ie');
});

test('published from article:published_time meta', () => {
  const html = page('<meta property="article:published_time" content="2026-02-11T09:41:00+00:00">');
  assert.equal(extractMetadata(html, 'https://n.com/a').published, '2026-02-11');
});

test('relative images resolve against the final URL and non-http images are dropped', () => {
  assert.equal(extractMetadata(page('<meta property="og:image" content="/img/c.jpg">'), 'https://n.com/a/b').image, 'https://n.com/img/c.jpg');
  assert.equal(extractMetadata(page('<meta property="og:image" content="data:image/png;base64,AAA">'), 'https://n.com/a').image, '');
});

test('image falls back to JSON-LD ImageObject then twitter:image', () => {
  assert.equal(extractMetadata(page(ld({ '@type': 'Recipe', name: 'r', image: [{ '@type': 'ImageObject', url: 'https://c.com/1.jpg' }] })), 'https://f.com/r').image, 'https://c.com/1.jpg');
  assert.equal(extractMetadata(page('<meta name="twitter:image" content="https://c.com/t.jpg">'), 'https://f.com/r').image, 'https://c.com/t.jpg');
});

test('og title and description win over JSON-LD and <title>', () => {
  const html = page('<title>Doc</title><meta property="og:title" content="OG"><meta property="og:description" content="OG d"><meta name="description" content="Meta d">' + ld({ '@type': 'Article', headline: 'LD' }));
  const meta = extractMetadata(html, 'https://n.com/a');
  assert.equal(meta.title, 'OG');
  assert.equal(meta.description, 'OG d');
});

test('malformed JSON-LD is ignored without throwing', () => {
  const html = page('<title>Ok</title><script type="application/ld+json">{ not json</script>');
  const meta = extractMetadata(html, 'https://n.com/a');
  assert.equal(meta.title, 'Ok');
  assert.equal(meta.type, 'link');
});
