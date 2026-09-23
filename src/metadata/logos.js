import { requestJson } from '../http.js';

// Candidate artwork for a promotion's logo picker, gathered from several
// sources in parallel. Every lookup is best effort: a source that fails or
// finds nothing contributes no tiles, and its error is reported alongside.
//
// Sources, roughly in order of how often they hold the right logo:
//   Wikidata        the entity's official logo property (P154), rendered PNG
//   TheSportsDB     league artwork by league id, and team badges by name
//   ESPN            league logos, light and dark
//   TMDB            company logos and show posters (needs a TMDB key)
//   Wikipedia       page images of matching articles
//   Commons         file search for "<name> logo"
//   Recent events   posters and square art of the promotion's own events
// Wikimedia asks API clients to identify themselves with a contact URL and
// throttles anonymous-looking agents much harder.
const USER_AGENT = 'Replayarr/0.2 (https://github.com/Monkfish1337/Replayarr; self-hosted sports replay manager)';
const TIMEOUT_MS = 10000;
// Wide enough for a crisp poster; Commons renders SVG logos to PNG at this size.
const RENDER_WIDTH = 800;

// TheSportsDB league ids for built-in promotions whose schedule comes from
// elsewhere, so they still get TheSportsDB's league artwork.
const TSDB_ARTWORK_LEAGUES = { nfl: '4391', nba: '4387', mlb: '4424', epl: '4328', ucl: '4480' };
const ESPN_LEAGUE_LOGOS = { nfl: 'nfl', nba: 'nba', mlb: 'mlb', nhl: 'nhl', wnba: 'wnba' };
// Full names search better than abbreviations on Wikidata and TMDB.
const SEARCH_NAMES = {
  ufc: 'Ultimate Fighting Championship', wwe: 'WWE', aew: 'All Elite Wrestling', one: 'ONE Championship',
  f1: 'Formula One', motogp: 'MotoGP', nfl: 'National Football League', nba: 'National Basketball Association',
  mlb: 'Major League Baseball', epl: 'Premier League', ucl: 'UEFA Champions League', motd: 'Match of the Day',
};

async function json(service, url) {
  const { body } = await requestJson(service, url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, timeoutMs: TIMEOUT_MS });
  return body;
}

const commonsFile = (name) => `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name)}?width=${RENDER_WIDTH}`;

async function wikidata(query) {
  const search = await json('Wikidata', `https://www.wikidata.org/w/api.php?${new URLSearchParams({
    action: 'wbsearchentities', format: 'json', language: 'en', type: 'item', limit: '6', search: query, origin: '*',
  })}`);
  const hits = search?.search || [];
  if (!hits.length) return [];
  const entities = await json('Wikidata', `https://www.wikidata.org/w/api.php?${new URLSearchParams({
    action: 'wbgetentities', format: 'json', props: 'claims', ids: hits.map((h) => h.id).join('|'), origin: '*',
  })}`);
  const out = [];
  for (const hit of hits) {
    const files = (entities?.entities?.[hit.id]?.claims?.P154 || []).map((c) => c.mainsnak?.datavalue?.value).filter(Boolean);
    for (const file of files) {
      out.push({ url: commonsFile(file), thumb: commonsFile(file).replace(`width=${RENDER_WIDTH}`, 'width=320'), label: `${hit.label}${hit.description ? ` – ${hit.description}` : ''} · ${file}`, source: 'Wikidata' });
    }
  }
  return out;
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

async function tsdbTeams(query, apiKey) {
  const body = await json('TheSportsDB', `https://www.thesportsdb.com/api/v1/json/${encodeURIComponent(apiKey || '123')}/searchteams.php?t=${encodeURIComponent(query)}`);
  const out = [];
  for (const team of (body?.teams || []).slice(0, 3)) {
    for (const [key, label] of [['strLogo', 'Logo'], ['strBadge', 'Badge'], ['strBanner', 'Banner']]) {
      if (team[key]) out.push({ url: team[key], thumb: `${team[key]}/preview`, label: `${team.strTeam} · ${label}`, source: 'TheSportsDB' });
    }
  }
  return out;
}

async function tmdb(query, apiKey) {
  const base = 'https://api.themoviedb.org/3';
  const auth = `api_key=${encodeURIComponent(apiKey)}`;
  const [companies, shows] = await Promise.all([
    json('TMDB', `${base}/search/company?${auth}&query=${encodeURIComponent(query)}`),
    json('TMDB', `${base}/search/tv?${auth}&query=${encodeURIComponent(query)}`),
  ]);
  const image = (path, size) => `https://image.tmdb.org/t/p/${size}${path}`;
  const out = [];
  for (const company of (companies?.results || []).filter((c) => c.logo_path).slice(0, 6)) {
    // TMDB serves SVG logos as .svg; its .png variant of the same path renders them.
    const path = company.logo_path.replace(/\.svg$/i, '.png');
    out.push({ url: image(path, 'original'), thumb: image(path, 'w300'), label: `${company.name}${company.origin_country ? ` (${company.origin_country})` : ''} · company logo`, source: 'TMDB' });
  }
  for (const show of (shows?.results || []).filter((s) => s.poster_path).slice(0, 4)) {
    out.push({ url: image(show.poster_path, 'original'), thumb: image(show.poster_path, 'w300'), label: `${show.name} · show poster`, source: 'TMDB' });
  }
  return out;
}

async function wikipedia(query) {
  const body = await json('Wikipedia', `https://en.wikipedia.org/w/api.php?${new URLSearchParams({
    action: 'query', format: 'json', generator: 'search', gsrsearch: query, gsrlimit: '6',
    prop: 'pageimages', piprop: 'original|thumbnail', pithumbsize: '320', origin: '*',
  })}`);
  return Object.values(body?.query?.pages || {})
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .filter((page) => page.original?.source)
    .map((page) => {
      // SVG originals are offered as a PNG render, which media servers can use.
      const svg = /\.svg$/i.test(page.original.source);
      const file = decodeURIComponent(page.original.source.split('/').pop());
      return { url: svg ? commonsFile(file) : page.original.source, thumb: page.thumbnail?.source || page.original.source, label: page.title, source: 'Wikipedia' };
    });
}

async function commons(query) {
  const body = await json('Wikimedia Commons', `https://commons.wikimedia.org/w/api.php?${new URLSearchParams({
    action: 'query', format: 'json', generator: 'search', gsrnamespace: '6', gsrsearch: query, gsrlimit: '18',
    prop: 'imageinfo', iiprop: 'url|mime', iiurlwidth: String(RENDER_WIDTH), origin: '*',
  })}`);
  return Object.values(body?.query?.pages || {})
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map((page) => ({ page, info: page.imageinfo?.[0] }))
    .filter(({ info }) => info && /^image\/(?:svg\+xml|png|jpeg|webp)$/.test(info.mime))
    .map(({ page, info }) => ({
      // An SVG is used through its PNG render (thumburl), which media servers accept.
      url: info.mime === 'image/svg+xml' ? (info.thumburl || info.url) : info.url,
      thumb: info.thumburl || info.url,
      label: page.title.replace(/^File:/, ''),
      source: 'Wikimedia Commons',
    }));
}

function eventArtwork(events) {
  const out = [];
  for (const event of events) {
    const p = event.payload || {};
    for (const [key, label] of [['poster', 'Poster'], ['square', 'Square'], ['thumb', 'Thumbnail']]) {
      if (p[key]) out.push({ url: p[key], thumb: p[key], label: `${event.title} · ${label}`, source: 'Recent events' });
    }
  }
  return out;
}

// `promotion` is the registry entry; `source` is the schedule source it
// currently uses; `query` is an optional search the operator typed;
// `recentEvents` are the promotion's latest events with their artwork.
export async function logoCandidates({ promotion, source, tsdbApiKey, tmdbApiKey, query, recentEvents = [] }) {
  const typed = String(query || '').trim();
  const name = typed || SEARCH_NAMES[promotion.id] || promotion.name || '';
  const jobs = [];
  const label = (sourceName, promise) => jobs.push(promise.then((items) => items, (error) => { throw Object.assign(error, { sourceName }); }));

  if (name) label('Wikidata', wikidata(name));
  if (!typed) {
    const leagueId = source?.type === 'thesportsdb' ? source.leagueId : TSDB_ARTWORK_LEAGUES[promotion.id];
    if (leagueId) label('TheSportsDB', tsdbLeague(leagueId, tsdbApiKey));
    const espn = source?.type === 'espn' ? ESPN_LEAGUE_LOGOS[source.league] : ESPN_LEAGUE_LOGOS[promotion.id];
    if (espn) {
      const logo = (variant) => `https://a.espncdn.com/i/teamlogos/leagues/${variant}/${espn}.png`;
      label('ESPN', Promise.resolve([
        { url: logo('500'), thumb: logo('500'), label: `${promotion.name} · ESPN league logo`, source: 'ESPN' },
        { url: logo('500-dark'), thumb: logo('500-dark'), label: `${promotion.name} · ESPN league logo (dark)`, source: 'ESPN' },
      ]));
    }
    label('Recent events', Promise.resolve(eventArtwork(recentEvents)));
  }
  if (name) {
    label('TheSportsDB', tsdbTeams(typed || promotion.name, tsdbApiKey));
    if (tmdbApiKey) label('TMDB', tmdb(name, tmdbApiKey));
    label('Wikipedia', wikipedia(name));
    label('Wikimedia Commons', commons(/logo/i.test(name) ? name : `${name} logo`));
  }

  const settled = await Promise.allSettled(jobs);
  const seen = new Set();
  const candidates = [];
  const errors = [];
  for (const result of settled) {
    if (result.status === 'rejected') {
      // One short line per source; services like Wikimedia return long HTML-ish bodies.
      const message = String(result.reason?.message || result.reason).split('\n')[0].replace(/^[^:]+:\s*/, '').slice(0, 120);
      errors.push(`${result.reason?.sourceName || 'source'}: ${/429/.test(message) ? 'busy, try again in a minute' : message}`);
      continue;
    }
    for (const item of result.value) {
      if (!/^https:\/\//.test(item.url) || seen.has(item.url)) continue;
      seen.add(item.url);
      candidates.push(item);
    }
  }
  return { candidates, errors, tmdb: !!tmdbApiKey };
}
