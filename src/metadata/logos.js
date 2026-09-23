import { requestJson } from '../http.js';

// Candidate artwork for a promotion's logo picker. Every lookup is best
// effort: a source that fails or finds nothing just contributes no tiles.
const USER_AGENT = 'Replayarr/0.2 (self-hosted sports replay manager)';
const TIMEOUT_MS = 10000;

// TheSportsDB league ids for built-in promotions whose schedule comes from
// elsewhere, so they still get TheSportsDB's league artwork.
const TSDB_ARTWORK_LEAGUES = { nfl: '4391', nba: '4387', mlb: '4424', epl: '4328', ucl: '4480' };
const ESPN_LEAGUE_LOGOS = { nfl: 'nfl', nba: 'nba', mlb: 'mlb', nhl: 'nhl', wnba: 'wnba' };

async function json(service, url) {
  const { body } = await requestJson(service, url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, timeoutMs: TIMEOUT_MS });
  return body;
}

async function tsdbLeague(leagueId, apiKey) {
  const body = await json('TheSportsDB', `https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(apiKey || '123')}/lookupleague.php?id=${encodeURIComponent(leagueId)}`);
  const league = body?.leagues?.[0];
  if (!league) return [];
  const fields = [['strLogo', 'Logo'], ['strBadge', 'Badge'], ['strPoster', 'Poster'], ['strTrophy', 'Trophy'], ['strBanner', 'Banner'], ['strFanart1', 'Fan art']];
  return fields.filter(([key]) => league[key]).map(([key, label]) => ({
    url: league[key], thumb: `${league[key]}/preview`, label: `${league.strLeague || 'League'} · ${label}`, source: 'TheSportsDB',
  }));
}

async function wikipedia(query) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search', gsrsearch: query, gsrlimit: '6',
    prop: 'pageimages', piprop: 'original|thumbnail', pithumbsize: '320', origin: '*',
  });
  const body = await json('Wikipedia', `https://en.wikipedia.org/w/api.php?${params}`);
  return Object.values(body?.query?.pages || {})
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .filter((page) => page.original?.source)
    .map((page) => ({ url: page.original.source, thumb: page.thumbnail?.source || page.original.source, label: page.title, source: 'Wikipedia' }));
}

async function commons(query) {
  const params = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search', gsrnamespace: '6', gsrsearch: query, gsrlimit: '18',
    prop: 'imageinfo', iiprop: 'url|mime', iiurlwidth: '320', origin: '*',
  });
  const body = await json('Wikimedia Commons', `https://commons.wikimedia.org/w/api.php?${params}`);
  return Object.values(body?.query?.pages || {})
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map((page) => ({ page, info: page.imageinfo?.[0] }))
    .filter(({ info }) => info && /^image\/(?:svg\+xml|png|jpeg|webp)$/.test(info.mime))
    .map(({ page, info }) => ({ url: info.url, thumb: info.thumburl || info.url, label: page.title.replace(/^File:/, ''), source: 'Wikimedia Commons' }));
}

// `promotion` is the registry entry; `source` is the schedule source it
// currently uses; `query` is an optional search the operator typed.
export async function logoCandidates({ promotion, source, tsdbApiKey, query }) {
  const name = String(query || promotion.name || '').trim();
  const jobs = [];
  const leagueId = source?.type === 'thesportsdb' ? source.leagueId : TSDB_ARTWORK_LEAGUES[promotion.id];
  if (leagueId && !query) jobs.push(tsdbLeague(leagueId, tsdbApiKey));
  const espn = source?.type === 'espn' ? ESPN_LEAGUE_LOGOS[source.league] : ESPN_LEAGUE_LOGOS[promotion.id];
  if (espn && !query) {
    jobs.push(Promise.resolve([{ url: `https://a.espncdn.com/i/teamlogos/leagues/500/${espn}.png`, thumb: `https://a.espncdn.com/i/teamlogos/leagues/500/${espn}.png`, label: `${promotion.name} · ESPN league logo`, source: 'ESPN' }]));
  }
  if (name) {
    jobs.push(wikipedia(name));
    jobs.push(commons(/logo/i.test(name) ? name : `${name} logo`));
  }
  const settled = await Promise.allSettled(jobs);
  const seen = new Set();
  const candidates = [];
  const errors = [];
  for (const result of settled) {
    if (result.status === 'rejected') { errors.push(result.reason?.message || String(result.reason)); continue; }
    for (const item of result.value) {
      if (!/^https:\/\//.test(item.url) || seen.has(item.url)) continue;
      seen.add(item.url);
      candidates.push(item);
    }
  }
  return { candidates, errors };
}
