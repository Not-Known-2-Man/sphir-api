// Maps oEmbed JSON responses to the card preview contract.
const cheerio = require('cheerio');
const { shorten } = require('./extractMetadata');

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function httpsUrl(raw) {
  const value = str(raw);
  return value ? value.replace(/^http:\/\//i, 'https://') : '';
}

function mapOembed(data, requestedUrl) {
  const o = data && typeof data === 'object' ? data : {};
  return {
    url: requestedUrl,
    title: str(o.title),
    description: str(o.author_name),
    image: httpsUrl(o.thumbnail_url),
    type: 'video',
    tags: [],
    price: '',
    site: 'YouTube',
    published: '',
  };
}

function mapTweetOembed(data, requestedUrl) {
  const o = data && typeof data === 'object' ? data : null;
  if (!o) return null;
  if (typeof o.html !== 'string') return null;

  const $ = cheerio.load(o.html);
  const p = $('p').first();
  if (!p.length) return null;
  const rawText = p.text().trim();
  if (!rawText) return null;

  const author = str(o.author_name).replace(/^@/, '');
  return {
    url: requestedUrl || str(o.url),
    title: shorten(rawText, 200),
    description: author ? `@${author} on X` : '',
    image: '',
    type: 'social',
    tags: [],
    price: '',
    site: 'X',
    published: '',
  };
}

module.exports = { mapOembed, mapTweetOembed };
