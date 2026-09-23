import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDatabase } from '../src/db.js';
import { createStore } from '../src/store.js';
import { byPriority, createService } from '../src/service.js';
import { loadSettings, saveSettings } from '../src/settings.js';
import { broadQueries, queriesFor } from '../src/matching/index.js';

// The fixture as UEFA's feed describes it (see metadata refresh).
const MAN_UTD_SABAH = {
  id: 'ucl:2049566', promotionId: 'ucl', title: 'Manchester United vs Sabah FC', date: '2026-09-10', time: '19:00',
  aliases: [], source: 'metadata', sourceRevision: 'uefa',
  payload: {
    id: 'ucl:2049566', name: 'Manchester United vs Sabah FC', date: '2026-09-10', time: '19:00:00', season: 2027, round: 'League Phase', competitionCode: 'UCL',
    teamNames: { home: ['Manchester United', 'Man Utd', 'Man United', 'Man. United', 'MUN'], away: ['Sabah', 'SAB', 'Sabah FC'] },
  },
};

const RIGHT = 'Man.Utd.v.Sabah.10.09.2026.1080p.WEB.h264';
const LAST_SEASON = 'Manchester.United.v.Sabah.2025.09.11.720p';

// A Prowlarr that only knows releases named the way scene groups name them:
// no competition prefix, "v" instead of "vs". It answers a query only when
// every word appears in the release title, as real indexers do.
async function fakeProwlarr(t, titles = [RIGHT, LAST_SEASON]) {
  const releases = titles.map((title, i) => ({
    title, protocol: 'torrent', size: 4e9, seeders: 25, indexer: 'Tracker',
    magnetUrl: `magnet:?xt=urn:btih:${String(i + 1).repeat(40).slice(0, 40)}`, guid: `r${i}`,
  }));
  const queries = [];
  const words = (text) => String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const server = createServer((req, res) => {
    const query = new URL(req.url, 'http://x').searchParams.get('query');
    queries.push(query);
    const wanted = words(query);
    const hits = releases.filter((r) => wanted.every((w) => words(r.title).includes(w)));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(hits));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}`, queries };
}

async function setup(t, indexers) {
  const store = createStore(openDatabase(':memory:'));
  const service = createService(store, { now: () => new Date('2026-09-11T12:00:00Z'), fetchEvents: async () => [] });
  saveSettings(store, { indexers, qbittorrent: { url: 'http://127.0.0.1:9' } });
  store.upsertEvent(MAN_UTD_SABAH);
  const request = await service.requestEvent(MAN_UTD_SABAH.id);
  return { store, service, request };
}

test('torrent indexers get SSS\'s whole torrent list; Easynews gets distinct spellings', () => {
  const torrent = queriesFor(MAN_UTD_SABAH, 'prowlarr', 60);
  assert.equal(torrent.length, 58);
  assert.equal(torrent[0], 'UEFA Champions League 2026.09.10 Manchester United Vs Sabah', 'SSS\'s focused scene form first');
  for (const form of ['MUN-SAB', 'Sabah Man Utd 2026.09.10', 'Sabah FC @ Manchester United 10.09.2026']) assert.ok(torrent.includes(form), form);
  assert.equal(queriesFor(MAN_UTD_SABAH, 'prowlarr', 6).length, 6, 'the indexer\'s cap still applies');
  const easynews = queriesFor(MAN_UTD_SABAH, 'easynews', 6);
  assert.equal(easynews.length, 6);
  assert.ok(easynews.some((q) => q.startsWith('Man. United')) && easynews.some((q) => q.startsWith('Manchester United')), easynews.join(' | '));
});

test('broad queries are just the two teams, without prefix, date or "vs"', () => {
  assert.deepEqual(broadQueries(MAN_UTD_SABAH), ['Manchester United Sabah', 'Man Utd Sabah FC']);
  assert.deepEqual(broadQueries(MAN_UTD_SABAH, ['manchester united sabah']), ['Man Utd Sabah FC'], 'not repeated');
  assert.deepEqual(broadQueries({ title: 'UFC 331 Van vs Pantoja 2', payload: {} }), [], 'events without structured teams keep their own queries');
});

test('the search works down SSS\'s list, stops at the first match, and the matcher keeps the right fixture', async (t) => {
  const prowlarr = await fakeProwlarr(t);
  const { store, service, request } = await setup(t, [{ id: 'p', type: 'prowlarr', name: 'Prowlarr', url: prowlarr.base, apiKey: 'k' }]);
  const result = await service.searchRequest(request.id);
  assert.equal(result.status, 'review');
  const hit = prowlarr.queries.at(-1);
  assert.ok(prowlarr.queries.length < 58, `stopped early after ${prowlarr.queries.length} queries`);
  assert.ok(prowlarr.queries.slice(0, 9).every((q) => /League|UCL/.test(q)), 'the precise forms still go first');
  const candidates = store.listCandidates(request.id);
  assert.deepEqual(candidates.filter((c) => c.decision === 'matched').map((c) => c.title), [RIGHT], `found by "${hit}"`);
  assert.deepEqual(store.listSearches(request.id)[0].queries, prowlarr.queries, 'the search record shows only the queries sent');
});

test('indexers are asked in priority order, and slower ones are skipped once there is a match', async (t) => {
  const fast = await fakeProwlarr(t);
  const slow = await fakeProwlarr(t);
  const { store, service, request } = await setup(t, [
    { id: 'tor', type: 'prowlarr', name: 'Torrent Prowlarr', url: slow.base, apiKey: 'k', priority: 40 },
    { id: 'hosted', type: 'prowlarr', name: 'Hosted', url: fast.base, apiKey: 'k', priority: 5 },
  ]);
  assert.deepEqual(byPriority(loadSettings(store).indexers).map((i) => i.id), ['hosted', 'tor']);
  await service.searchRequest(request.id);
  assert.ok(fast.queries.length > 0);
  assert.equal(slow.queries.length, 0, 'the torrent Prowlarr was not needed');
  assert.deepEqual(store.listSearches(request.id).map((s) => s.source), ['Hosted']);
});

test('indexers saved with the old small query limits move to SSS\'s, and get a default priority', () => {
  const store = createStore(openDatabase(':memory:'));
  store.setSetting('config', { indexers: [
    { id: 'a', type: 'prowlarr', name: 'P', url: 'http://p', apiKey: 'k', maxQueries: 6 },
    { id: 'b', type: 'bitmagnet', name: 'B', url: 'http://b', maxQueries: 12 },
    { id: 'c', type: 'prowlarr', name: 'Chosen', url: 'http://c', apiKey: 'k', maxQueries: 9 },
  ] });
  const [p, b, c] = loadSettings(store).indexers;
  assert.deepEqual([p.maxQueries, b.maxQueries, c.maxQueries], [60, 60, 9], 'a limit the user chose is kept');
  assert.deepEqual([p.priority, b.priority], [30, 10]);
  saveSettings(store, { indexers: [{ ...p, maxQueries: 6 }] });
  assert.equal(loadSettings(store).indexers[0].maxQueries, 6, 'once upgraded, 6 is the user\'s own choice');
});

test('manual search runs the typed query, and a rejected release can be grabbed only with override', async (t) => {
  const prowlarr = await fakeProwlarr(t);
  const { store, service, request } = await setup(t, [{ id: 'p', type: 'prowlarr', name: 'Prowlarr', url: prowlarr.base, apiKey: 'k' }]);
  const result = await service.manualSearch(request.id, { query: '  Sabah   ' });
  assert.deepEqual(prowlarr.queries, ['Sabah']);
  assert.equal(result.query, 'Sabah');
  assert.deepEqual(Object.fromEntries(result.candidates.map((c) => [c.title, c.decision])), { [RIGHT]: 'matched', [LAST_SEASON]: 'rejected' });
  assert.ok(result.candidates.every((c) => c.evidence.at(-1) === 'Manual search: "Sabah"'));
  assert.equal(store.getRequest(request.id).status, 'wanted', 'a manual search does not change the request');
  assert.match(store.listSearches(request.id)[0].source, /\(manual\)$/);

  const wrong = result.candidates.find((c) => c.decision === 'rejected');
  await assert.rejects(service.approve(request.id, wrong.id), /Grab anyway/);
  const qbit = { add: async () => ({ remoteId: 'hash:x' }), status: async () => null };
  const overridden = createService(store, { adapters: { qbittorrent: qbit }, fetchEvents: async () => [] });
  const sent = await overridden.approve(request.id, wrong.id, { override: true });
  assert.equal(sent.status, 'downloading', 'a wanted request moves straight to downloading');
  assert.equal(sent.candidateId, wrong.id);

  await assert.rejects(service.manualSearch(request.id, { query: ' ' }), /Type something/);
  await assert.rejects(service.manualSearch(request.id, { query: 'x y', indexerId: 'nope' }), /disabled or not set up/);
});
