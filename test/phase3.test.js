import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { createStore } from '../src/store.js';
import { createService } from '../src/service.js';
import { saveSettings } from '../src/settings.js';
import * as prowlarr from '../src/adapters/prowlarr.js';
import { mayConcern } from '../src/matching/index.js';

const REL = {
  hd720: 'UFC.331.Van.vs.Pantoja.2.720p.WEB.h264-GRP',
  hd1080: 'UFC.331.Van.vs.Pantoja.2.1080p.WEB.h264-GRP',
  other: 'NBA.2026.09.20.Lakers.vs.Celtics.1080p.WEB',
  junk: 'Some.Movie.2024.1080p.BluRay.x264',
};

// A stub Prowlarr whose RSS feed the test controls, counting live searches
// separately, and a stub qBittorrent whose downloads complete as real files.
async function setup(t, { rss = [], indexer = {}, preferences = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'replayarr-p3-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = new Date('2026-09-20T12:00:00Z');
  const hash = (title) => createHash('sha1').update(title).digest('hex');
  const release = (title) => prowlarr.normalise({ title, protocol: 'torrent', size: 3e9, seeders: 40, indexer: 'Tracker', magnetUrl: `magnet:?xt=urn:btih:${hash(title)}`, guid: title });
  const feed = { rss, rssCalls: 0, searches: 0, offer: [] };
  const client = { added: [], states: new Map() };
  const adapters = {
    prowlarr: {
      recent: async () => { feed.rssCalls += 1; return feed.rss.map(release); },
      search: async () => { feed.searches += 1; return feed.offer.map(release); },
    },
    qbittorrent: {
      add: async (_c, candidate) => { client.added.push(candidate.title); client.states.set(candidate.infoHash, { state: 'downloading', progress: 0.5 }); return { remoteId: candidate.infoHash }; },
      status: async (_c, id) => client.states.get(id) || null,
    },
  };
  async function complete(title) {
    const folder = join(dir, 'downloads', title);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `${title}.mkv`), Buffer.alloc(2 * 1024 * 1024, 1));
    client.states.set(hash(title), { state: 'completed', progress: 1, path: folder });
  }
  const store = createStore(openDatabase(':memory:'));
  const service = createService(store, { now: () => now, adapters, fetchEvents: async () => [], logoDir: join(dir, 'logos'), mediaServerDelayMs: 0 });
  saveSettings(store, {
    indexers: [{ id: 'p', type: 'prowlarr', name: 'Prowlarr', url: 'http://prowlarr', apiKey: 'k', ...indexer }],
    qbittorrent: { url: 'http://qbittorrent' },
    library: { root: join(dir, 'library'), mode: 'copy', minSizeMb: 1, writeMetadata: 'no' },
    preferences: { searchSeconds: 10, ...preferences },
  });
  const event = service.addManualEvent({ promotionId: 'ufc', title: 'UFC 331: Van vs Pantoja 2', date: '2026-09-19' });
  return {
    store, service, feed, client, complete, event,
    request: async () => service.requestEvent(event.id),
    advance: (minutes) => { now = new Date(now.getTime() + minutes * 60000); },
  };
}

test('Prowlarr RSS is a search with an empty query, for all of its indexers at once', async (t) => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(new URL(req.url, 'http://x'));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([
      { title: REL.hd720, protocol: 'torrent', size: 3e9, seeders: 5, magnetUrl: `magnet:?xt=urn:btih:${'a'.repeat(40)}`, guid: 'x' },
    ]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const releases = await prowlarr.recent({ url: `http://127.0.0.1:${server.address().port}`, apiKey: 'k', timeoutMs: 5000 });
  assert.equal(releases[0].title, REL.hd720);
  assert.equal(seen[0].pathname, '/api/v1/search');
  assert.equal(seen[0].searchParams.get('query'), '');
  assert.equal(seen[0].searchParams.get('type'), 'search');
});

test('the RSS pre-filter keeps releases that could concern an event, including short tokens like "ufc 331"', () => {
  const event = { title: 'UFC 331: Van vs Pantoja 2', aliases: [], payload: null };
  assert.equal(mayConcern(REL.hd720, event), true);
  assert.equal(mayConcern('UFC.331.Prelims.1080p', event), true);
  assert.equal(mayConcern(REL.other, event), false);
  assert.equal(mayConcern(REL.junk, event), false);
});

test('an RSS sync caches new releases and grabs one that matches a wanted event, without a live search', async (t) => {
  const env = await setup(t, { rss: [REL.junk, REL.other, REL.hd720] });
  const request = await env.request();
  const summary = await env.service.rssSync();
  assert.deepEqual({ fetched: summary.fetched, fresh: summary.fresh, matched: summary.matched }, { fetched: 3, fresh: 3, matched: 1 });
  assert.deepEqual(env.client.added, [REL.hd720]);
  assert.equal(env.store.getRequest(request.id).status, 'downloading');
  assert.equal(env.feed.searches, 0, 'no live search');
  const candidate = env.store.listCandidates(request.id)[0];
  assert.equal(candidate.evidence.at(-1), 'From the RSS cache');
  assert.equal(env.store.listCandidates(request.id).length, 1, 'unrelated feed items are not kept as candidates');

  const again = await env.service.rssSync();
  assert.equal(again.fresh, 0, 'releases already cached are not matched twice');
  assert.equal(env.store.releaseCacheStats().releases, 3);
});

test('an event in the library below its cutoff is upgraded from RSS', async (t) => {
  const env = await setup(t, { rss: [REL.hd720] });
  await env.request();
  await env.service.rssSync();
  await env.complete(REL.hd720);
  await env.service.reconcileJobs();
  await env.service.importRequest(env.store.listRequests()[0].id);
  assert.equal(env.store.libraryFor(env.event.id).quality, '720p');

  env.feed.rss = [REL.hd1080];
  await env.service.rssSync();
  assert.deepEqual(env.client.added, [REL.hd720, REL.hd1080], '1080p grabbed as an upgrade from the feed');
  assert.equal(env.feed.searches, 0);
});

test('a scheduled search looks in the cache first, and searches the indexers only when it has nothing', async (t) => {
  // The release was posted (and cached) before the event was requested.
  const env = await setup(t, { rss: [REL.hd720] });
  await env.service.rssSync();
  const request = await env.request();
  await env.service.tick();
  assert.equal(env.feed.searches, 0, 'found in the cache');
  assert.equal(env.store.getRequest(request.id).status, 'downloading');

  const empty = await setup(t, { rss: [REL.other] });
  const other = await empty.request();
  empty.feed.offer = [REL.hd720];
  await empty.service.tick();
  assert.ok(empty.feed.searches > 0, 'nothing cached for this event: a live search ran');
  assert.equal(empty.store.getRequest(other.id).status, 'downloading');
});

test('the worker syncs on its interval, and not at all when RSS is off', async (t) => {
  const env = await setup(t, { preferences: { rssMinutes: 15 } });
  await env.service.tick();
  assert.equal(env.feed.rssCalls, 1);
  env.advance(5);
  await env.service.tick();
  assert.equal(env.feed.rssCalls, 1, 'not due yet');
  env.advance(10);
  await env.service.tick();
  assert.equal(env.feed.rssCalls, 2);
  assert.equal(env.service.tasks().find((task) => task.name === 'rss-sync').interval, '15 minutes');

  const off = await setup(t, { preferences: { rssMinutes: 0 } });
  await off.service.tick();
  assert.equal(off.feed.rssCalls, 0);
  const perIndexer = await setup(t, { indexer: { rss: 'no' } });
  await perIndexer.service.rssSync();
  assert.equal(perIndexer.feed.rssCalls, 0, 'an indexer can opt out');
});

test('cached releases expire after two weeks without being seen', async (t) => {
  const env = await setup(t, { rss: [REL.other] });
  await env.service.rssSync();
  env.feed.rss = [];
  env.advance(15 * 24 * 60);
  const summary = await env.service.rssSync();
  assert.equal(summary.pruned, 1);
  assert.equal(env.store.releaseCacheStats().releases, 0);
});
