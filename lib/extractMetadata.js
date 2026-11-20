// Turns a fetched HTML page into the card preview contract used by the web and iOS clients.
// Precedence for the card type: JSON-LD @type > og:type > domain rules > "link".
const cheerio = require('cheerio');

const MAX_TAGS = 8;

const LD_TYPES = [
  [['Product', 'ProductGroup'], 'product'],
  [['Recipe'], 'recipe'],
  [['VideoObject'], 'video'],
  [['Article', 'NewsArticle', 'BlogPosting', 'Report', 'ScholarlyArticle', 'TechArticle'], 'article'],
];

const VIDEO_HOSTS = ['youtube.com', 'youtu.be', 'vimeo.com', 'tiktok.com'];
const SOCIAL_HOSTS = ['x.com', 'twitter.com', 'facebook.com', 'threads.net'];

function hostMatches(hostname, domain) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

// Every JSON-LD node on the page, flattening arrays and @graph containers.
function jsonLdNodes($) {
  const nodes = [];
  const visit = (value) => {
    for (const item of asArray(value)) {
      if (!item || typeof item !== 'object') continue;
      nodes.push(item);
      if (item['@graph']) visit(item['@graph']);
    }
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try { visit(JSON.parse($(el).contents().text())); } catch { /* malformed JSON-LD is ignored */ }
  });
  return nodes;
}

function typeOfNode(node) {
  const types = asArray(node['@type']).map(String);
  for (const [names, type] of LD_TYPES) {
    if (types.some(t => names.includes(t))) return type;
  }
  return '';
}

function typeFromOg(ogType) {
  const value = (ogType || '').toLowerCase();
  if (value.startsWith('product')) return 'product';
  if (value.startsWith('video')) return 'video';
  if (value === 'article') return 'article';
  return '';
}

function typeFromDomain(url) {
  const host = url.hostname.toLowerCase();
  if (VIDEO_HOSTS.some(d => hostMatches(host, d))) return 'video';
  if (hostMatches(host, 'instagram.com') && /^\/(reel|p)\//.test(url.pathname)) return 'social';
  if (SOCIAL_HOSTS.some(d => hostMatches(host, d))) return 'social';
  return '';
}

function absoluteHttpUrl(raw, base) {
  const value = text(raw);
  if (!value) return '';
  try {
    const resolved = new URL(value, base);
    return ['http:', 'https:'].includes(resolved.protocol) ? resolved.href : '';
  } catch { return ''; }
}

function ldImage(image) {
  for (const item of asArray(image)) {
    if (typeof item === 'string') return item;
    if (item && typeof item === 'object' && item.url) return text(item.url);
  }
  return '';
}

function formatPrice(amount, currency) {
  const value = text(amount);
  if (!value) return '';
  const code = text(currency).toUpperCase();
  if (!code || code === 'USD') return `$${value}`;
  return `${value} ${code}`;
}

function ldPrice(node) {
  for (const offer of asArray(node.offers)) {
    if (!offer || typeof offer !== 'object') continue;
    const price = formatPrice(offer.price ?? offer.lowPrice, offer.priceCurrency);
    if (price) return price;
  }
  return '';
}

function isoDate(raw) {
  const match = text(raw).match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

function collectTags(sources) {
  const seen = new Set();
  const tags = [];
  for (const raw of sources) {
    const tag = text(raw).replace(/^_+/, '').trim();
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length === MAX_TAGS) break;
  }
  return tags;
}

function splitKeywords(value) {
  return asArray(value).flatMap(k => (typeof k === 'string' ? k.split(',') : []));
}

function extractMetadata(html, finalUrl) {
  const $ = cheerio.load(html || '');
  const url = new URL(finalUrl);
  const meta = (selector) => text($(selector).attr('content'));

  const nodes = jsonLdNodes($);
  const typedNodes = nodes.filter(typeOfNode);
  const main = typedNodes[0] || {};

  const type = typeOfNode(main) || typeFromOg(meta('meta[property="og:type"]')) || typeFromDomain(url) || 'link';

  const title = meta('meta[property="og:title"]') || text(main.headline) || text(main.name) || $('title').first().text().trim();
  const description = meta('meta[property="og:description"]') || text(main.description) || meta('meta[name="description"]');

  const image = absoluteHttpUrl(meta('meta[property="og:image"]'), url)
    || absoluteHttpUrl(ldImage(main.image), url)
    || absoluteHttpUrl(meta('meta[name="twitter:image"]'), url);

  const articleTags = $('meta[property="article:tag"]').map((_, el) => $(el).attr('content')).get();
  const tags = collectTags([
    ...splitKeywords(main.keywords),
    ...articleTags,
    ...splitKeywords(meta('meta[name="keywords"]')),
  ]);

  const price = typedNodes.map(ldPrice).find(Boolean)
    || formatPrice(meta('meta[property="product:price:amount"]'), meta('meta[property="product:price:currency"]'));

  const site = meta('meta[property="og:site_name"]') || url.hostname.replace(/^www\./, '');
  const published = isoDate(main.datePublished) || isoDate(meta('meta[property="article:published_time"]'));

  return { url: url.href, title, description, image, type, tags, price, site, published };
}

module.exports = { extractMetadata };
