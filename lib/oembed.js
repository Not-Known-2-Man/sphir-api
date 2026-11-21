// Maps a YouTube oEmbed JSON response to the card preview contract (S8/S9).
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

module.exports = { mapOembed };
