import { joinUrl, requestJson } from '../http.js';

const SERVICE = 'Prowlarr';

// Ported from SSS lib/sources/prowlarr.js: many trackers expose the btih only
// inside the magnet or guid, sometimes base32 encoded.
function base32ToHex(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of value.toUpperCase().replace(/=+$/, '')) {
    const index = alphabet.indexOf(char);
    if (index < 0) return '';
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = bits.match(/.{8}/g) || [];
  return bytes.length === 20 ? bytes.map((b) => parseInt(b, 2).toString(16).padStart(2, '0')).join('') : '';
}

export function extractInfoHash(result) {
  if (/^[a-f0-9]{40}$/i.test(result.infoHash || '')) return result.infoHash.toLowerCase();
  for (const field of [result.magnetUrl, result.downloadUrl, result.guid, result.infoUrl]) {
    if (typeof field !== 'string') continue;
    const magnet = field.match(/urn:btih:([A-Fa-f0-9]{40}|[A-Z2-7]{32})/i);
    if (magnet) return magnet[1].length === 40 ? magnet[1].toLowerCase() : base32ToHex(magnet[1]);
    const bare = field.match(/\b([A-Fa-f0-9]{40})\b/);
    if (bare) return bare[1].toLowerCase();
  }
  return '';
}

export function normalise(result) {
  const protocol = result.protocol === 'usenet' ? 'usenet' : 'torrent';
  const infoHash = protocol === 'torrent' ? extractInfoHash(result) : '';
  const url = result.magnetUrl || result.downloadUrl || '';
  const identity = infoHash ? `btih:${infoHash}` : `${protocol}:${result.guid || url || result.title}`;
  return {
    identity,
    source: 'Prowlarr',
    indexer: result.indexer || null,
    protocol,
    title: String(result.title || '').trim(),
    downloadUrl: url,
    infoHash: infoHash || null,
    size: Number(result.size) || null,
    seeders: protocol === 'torrent' ? Number(result.seeders) || 0 : null,
    publishedAt: result.publishDate || null,
  };
}

// Prowlarr's RSS: a search with no query returns each of its indexers' newest
// releases (what Sonarr's RSS sync reads), one request for all of them.
export function recent(config) {
  return search(config, '');
}

export async function search(config, query) {
  const params = new URLSearchParams({ query, type: 'search', limit: '100' });
  const { body } = await requestJson(SERVICE, joinUrl(config.url, '/api/v1/search?' + params), {
    headers: { 'X-Api-Key': config.apiKey, Accept: 'application/json' },
    timeoutMs: config.timeoutMs,
  });
  if (!Array.isArray(body)) return [];
  return body.map(normalise).filter((item) => item.title && item.downloadUrl);
}

export async function testConnection(config) {
  const { body } = await requestJson(SERVICE, joinUrl(config.url, '/api/v1/system/status'), {
    headers: { 'X-Api-Key': config.apiKey, Accept: 'application/json' },
    timeoutMs: 10000,
  });
  return `Prowlarr ${body.version || ''}`.trim();
}
