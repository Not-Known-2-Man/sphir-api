/**
 * Link normalization key for Sphir saved links.
 * Normalizes a URL so equivalent links map to the same key string.
 *
 * Rules:
 * - lowercase host
 * - drop leading www. and m.
 * - remove tracking params: utm_* (any suffix), fbclid, gclid, si, igsh
 * - keep other params, sorted by name so order does not matter
 * - drop fragment
 * - drop trailing slash of path (root / becomes empty path)
 * - scheme dropped (e.g. youtube.com/watch?v=abc)
 * - invalid/empty input returns '' (never throws)
 */

function linkKey(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return '';
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
    let host = parsed.host.toLowerCase();
    host = host.replace(/^(?:www|m)\./, '');

    let pathname = parsed.pathname;
    if (pathname === '/') {
      pathname = '';
    } else {
      pathname = pathname.replace(/\/+$/, '');
    }

    const searchParams = new URLSearchParams(parsed.search);
    const toDelete = [];
    for (const key of searchParams.keys()) {
      const lower = key.toLowerCase();
      if (lower.startsWith('utm_') || ['fbclid', 'gclid', 'si', 'igsh'].includes(lower)) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      searchParams.delete(key);
    }
    searchParams.sort();
    const qs = searchParams.toString();
    const queryPart = qs ? `?${qs}` : '';

    return `${host}${pathname}${queryPart}`;
  } catch {
    return '';
  }
}

module.exports = { linkKey };
