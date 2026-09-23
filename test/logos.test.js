import test from 'node:test';
import assert from 'node:assert/strict';
import { logoCandidates } from '../src/metadata/logos.js';

// Answers for each service the logo search asks, keyed by host and path.
function fakeFetch(t, { wikimediaBusy = false } = {}) {
  const requests = [];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, headers: init?.headers || {} });
    const wikimedia = /wikidata\.org|wikipedia\.org|wikimedia\.org/.test(url.host);
    if (wikimedia && wikimediaBusy) return new Response('You are making too many requests to the API.\nPlease follow…', { status: 429 });
    if (url.host === 'www.wikidata.org' && url.searchParams.get('action') === 'wbsearchentities') {
      return json({ search: [{ id: 'Q1', label: 'Ultimate Fighting Championship', description: 'MMA promotion' }, { id: 'Q2', label: 'UFC (video game)' }] });
    }
    if (url.host === 'www.wikidata.org') {
      return json({ entities: { Q1: { claims: { P154: [{ mainsnak: { datavalue: { value: 'UFC Logo.svg' } } }] } }, Q2: { claims: {} } } });
    }
    if (url.host === 'www.thesportsdb.com' && url.pathname.endsWith('lookupleague.php')) {
      return json({ leagues: [{ strLeague: 'UFC', strLogo: 'https://r2.thesportsdb.com/logo.png', strBadge: 'https://r2.thesportsdb.com/badge.png' }] });
    }
    if (url.host === 'www.thesportsdb.com') return json({ teams: null });
    if (url.host === 'api.themoviedb.org' && url.pathname.endsWith('/search/company')) {
      return json({ results: [{ name: 'UFC', origin_country: 'US', logo_path: '/abc.svg' }] });
    }
    if (url.host === 'api.themoviedb.org') return json({ results: [{ name: 'UFC Fight Night', poster_path: '/poster.jpg' }] });
    if (url.host === 'en.wikipedia.org') {
      return json({ query: { pages: { 1: { index: 1, title: 'UFC', original: { source: 'https://upload.wikimedia.org/wikipedia/commons/9/92/UFC_Logo.svg' }, thumbnail: { source: 'https://upload.wikimedia.org/thumb/ufc.png' } } } } });
    }
    if (url.host === 'commons.wikimedia.org') {
      return json({ query: { pages: {
        5: { index: 1, title: 'File:UFC octagon logo.svg', imageinfo: [{ mime: 'image/svg+xml', url: 'https://upload.wikimedia.org/octagon.svg', thumburl: 'https://upload.wikimedia.org/thumb/octagon.svg/800px-octagon.svg.png' }] },
        6: { index: 2, title: 'File:UFC clip.webm', imageinfo: [{ mime: 'video/webm', url: 'https://upload.wikimedia.org/clip.webm' }] },
      } } });
    }
    return new Response('not found', { status: 404 });
  };
  return requests;
}

const UFC = { id: 'ufc', name: 'UFC' };
const recentEvents = [{ title: 'UFC 331', payload: { poster: 'https://r2.thesportsdb.com/ufc331-poster.jpg', thumb: 'https://r2.thesportsdb.com/ufc331-thumb.jpg' } }];

test('the logo search gathers Wikidata, TheSportsDB, TMDB, Wikipedia, Commons and event art', async (t) => {
  const requests = fakeFetch(t);
  const result = await logoCandidates({ promotion: UFC, source: { type: 'thesportsdb', leagueId: '4443' }, tmdbApiKey: 'tmdb-key', recentEvents });
  const bySource = (s) => result.candidates.filter((c) => c.source === s).map((c) => c.url);

  assert.deepEqual(bySource('Wikidata'), ['https://commons.wikimedia.org/wiki/Special:FilePath/UFC%20Logo.svg?width=800'], 'official logo, rendered to PNG');
  assert.deepEqual(bySource('TheSportsDB'), ['https://r2.thesportsdb.com/logo.png', 'https://r2.thesportsdb.com/badge.png']);
  assert.deepEqual(bySource('TMDB'), ['https://image.tmdb.org/t/p/original/abc.png', 'https://image.tmdb.org/t/p/original/poster.jpg'], 'SVG company logo used as PNG');
  assert.deepEqual(bySource('Wikipedia'), ['https://commons.wikimedia.org/wiki/Special:FilePath/UFC_Logo.svg?width=800'], 'SVG page image used as PNG');
  assert.deepEqual(bySource('Wikimedia Commons'), ['https://upload.wikimedia.org/thumb/octagon.svg/800px-octagon.svg.png'], 'SVG via its render; video skipped');
  assert.deepEqual(bySource('Recent events'), ['https://r2.thesportsdb.com/ufc331-poster.jpg', 'https://r2.thesportsdb.com/ufc331-thumb.jpg']);
  assert.equal(result.tmdb, true);
  assert.deepEqual(result.errors, []);

  const wikidataSearch = requests.find((r) => r.url.searchParams.get('action') === 'wbsearchentities');
  assert.equal(wikidataSearch.url.searchParams.get('search'), 'Ultimate Fighting Championship', 'full name searches better than the abbreviation');
  assert.match(wikidataSearch.headers['user-agent'], /github\.com\/Monkfish1337\/Replayarr/, 'Wikimedia sees a contactable user agent');
});

test('TMDB is skipped without a key, and a busy Wikimedia gives a short message', async (t) => {
  const requests = fakeFetch(t, { wikimediaBusy: true });
  const result = await logoCandidates({ promotion: UFC, source: { type: 'thesportsdb', leagueId: '4443' }, recentEvents: [] });
  assert.ok(!requests.some((r) => r.url.host === 'api.themoviedb.org'));
  assert.equal(result.tmdb, false);
  assert.ok(result.candidates.some((c) => c.source === 'TheSportsDB'), 'other sources still answer');
  assert.ok(result.errors.includes('Wikidata: busy, try again in a minute'), result.errors.join(' | '));
  assert.ok(result.errors.every((e) => !e.includes('\n')));
});
