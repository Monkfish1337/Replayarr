import { requestJson, ServiceError } from '../http.js';

// Bitmagnet GraphQL search, ported from SSS lib/sources/bitmagnet.js.
//
// Bitmagnet is a local DHT index, so a query costs milliseconds, every result
// carries its info hash, and results can be ordered by seeders server-side,
// which makes a truncated result set keep the useful end. It is recall only:
// the promotion matchers decide relevance.
const SERVICE = 'Bitmagnet';

// torrent.name is the raw release name the matchers need; Bitmagnet's own
// parsed `title` hides the naming conventions they key on.
const SEARCH_QUERY = `query Search($input: TorrentContentSearchQueryInput!) {
  torrentContent {
    search(input: $input) {
      items {
        infoHash
        publishedAt
        seeders
        torrent { name size seeders magnetUri }
      }
    }
  }
}`;

export function endpointUrl(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '').replace(/\/graphql$/i, '') + '/graphql';
}

async function graphql(config, query, variables, timeoutMs) {
  const { body } = await requestJson(SERVICE, endpointUrl(config.url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
    timeoutMs,
  });
  // GraphQL reports errors with HTTP 200.
  if (Array.isArray(body?.errors) && body.errors.length) {
    throw new ServiceError(SERVICE, body.errors.map((e) => e?.message).filter(Boolean).join('; ') || 'query failed');
  }
  return body?.data;
}

export function normalise(item) {
  const hash = String(item?.infoHash || '').toLowerCase();
  const torrent = item?.torrent || {};
  const title = String(torrent.name || '').trim();
  if (!/^[a-f0-9]{40}$/.test(hash) || !title) return null;
  // Bitmagnet uses 1999-01-01 for "unknown"; do not present that as a date.
  const published = item.publishedAt && !/^1999-01-01/.test(String(item.publishedAt)) ? item.publishedAt : null;
  return {
    identity: `btih:${hash}`,
    indexer: 'DHT',
    protocol: 'torrent',
    title,
    downloadUrl: torrent.magnetUri || `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(title)}`,
    infoHash: hash,
    size: Number(torrent.size) || null,
    seeders: Number(item.seeders ?? torrent.seeders) || 0,
    publishedAt: published,
  };
}

export async function search(config, query) {
  const data = await graphql(config, SEARCH_QUERY, {
    input: {
      queryString: query,
      limit: Math.max(1, Math.min(1000, Number(config.limit) || 100)),
      cached: false,
      orderBy: [{ field: 'seeders', descending: true }],
    },
  }, config.timeoutMs);
  const items = data?.torrentContent?.search?.items;
  if (!Array.isArray(items)) throw new ServiceError(SERVICE, 'returned an unexpected response');
  return items.map(normalise).filter(Boolean);
}

export async function testConnection(config) {
  await graphql(config, '{ __typename }', {}, 10000);
  return 'Bitmagnet GraphQL reachable';
}
