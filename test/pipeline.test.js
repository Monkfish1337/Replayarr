import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { createStore } from '../src/store.js';
import { createService } from '../src/service.js';
import { saveSettings } from '../src/settings.js';
import * as qbittorrent from '../src/adapters/qbittorrent.js';

// Stand-ins for SSS, Prowlarr, qBittorrent and SABnzbd that speak just enough
// of each real API for the pipeline to run against them over HTTP.
async function fakeServices(downloadDir) {
  const state = { torrents: [], sab: { queue: [], history: [] }, prowlarrQueries: [], logins: 0 };
  const hash = 'a'.repeat(40);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = (value) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    // SSS addon
    if (url.pathname === '/u/1/tok/manifest.json') return json({ name: 'SSS', catalogs: [{ type: 'movie', id: 'epl-recent', name: 'Premier League Recent' }] });
    if (url.pathname === '/u/1/tok/catalog/movie/epl-recent.json') {
      return json({ metas: [
        { id: 'epl:101', name: 'Arsenal vs Manchester City', releaseInfo: '2026-09-21' },
        { id: 'epl:099', name: 'Chelsea vs Everton', releaseInfo: '2025-01-01' },
      ] });
    }
    if (url.pathname.startsWith('/u/1/tok/catalog/')) return json({ metas: [] });
    if (url.pathname === '/u/1/tok/meta/movie/epl%3A101.json') {
      return json({ meta: { id: 'epl:101', name: 'Arsenal vs Manchester City', released: '2026-09-21T15:30:00.000Z', searchHints: [] } });
    }
    // Prowlarr
    if (url.pathname === '/api/v1/search') {
      assert.equal(req.headers['x-api-key'], 'prowlarr-key');
      state.prowlarrQueries.push(url.searchParams.get('query'));
      return json([
        { title: 'Premier.League.2026.09.21.Arsenal.vs.Manchester.City.1080p.WEB-DL.H264', protocol: 'torrent', size: 5e9, seeders: 40, indexer: 'Tracker', magnetUrl: `magnet:?xt=urn:btih:${hash}`, guid: 'g1' },
        { title: 'EPL.2026.09.21.Arsenal.vs.Man.City.720p.HDTV', protocol: 'usenet', size: 3e9, indexer: 'NZBgeek', downloadUrl: 'http://prowlarr/nzb/2', guid: 'g2' },
        { title: 'Premier.League.2025.09.21.Arsenal.vs.Manchester.City.1080p', protocol: 'torrent', size: 5e9, seeders: 90, indexer: 'Tracker', magnetUrl: `magnet:?xt=urn:btih:${'b'.repeat(40)}`, guid: 'g3' },
        { title: 'Arsenal vs Manchester City 2026.09.21 Highlights 1080p', protocol: 'torrent', size: 4e8, seeders: 5, indexer: 'Tracker', magnetUrl: `magnet:?xt=urn:btih:${'c'.repeat(40)}`, guid: 'g4' },
      ]);
    }
    // qBittorrent
    if (url.pathname === '/api/v2/auth/login') {
      state.logins += 1;
      const form = new URLSearchParams(body);
      if (form.get('password') !== 'qb-pass') return res.end('Fails.');
      return res.writeHead(200, { 'set-cookie': 'SID=abc; HttpOnly; path=/' }).end('Ok.');
    }
    if (url.pathname.startsWith('/api/v2/')) {
      if (req.headers.cookie !== 'SID=abc' && req.headers.authorization !== 'Bearer qbt_testkey1234567890123456789') return res.writeHead(403).end('Forbidden');
      if (url.pathname === '/api/v2/torrents/add') {
        const form = new URLSearchParams(body);
        state.torrents.push({ hash, url: form.get('urls'), tags: form.get('tags'), category: form.get('category'), state: 'downloading', progress: 0.4, content_path: '/downloads/Premier.League.Arsenal.City' });
        return res.end('Ok.');
      }
      if (url.pathname === '/api/v2/torrents/info') return json(state.torrents.filter((t) => t.hash === url.searchParams.get('hashes')));
      if (url.pathname === '/api/v2/app/version') return res.end('v5.1.0');
    }
    // SABnzbd
    if (url.pathname === '/api') {
      const mode = url.searchParams.get('mode');
      if (url.searchParams.get('apikey') !== 'sab-key') return json({ status: false, error: 'API Key Incorrect' });
      if (mode === 'addurl') { state.sab.queue.push({ nzo_id: 'SABnzbd_nzo_1', status: 'Downloading', percentage: '10' }); return json({ status: true, nzo_ids: ['SABnzbd_nzo_1'] }); }
      if (mode === 'queue') return json({ queue: { slots: state.sab.queue } });
      if (mode === 'history') return json({ history: { slots: state.sab.history } });
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, state, downloadDir };
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'replayarr-'));
  const downloads = join(dir, 'downloads');
  const library = join(dir, 'library');
  const fake = await fakeServices(downloads);
  let now = new Date('2026-09-22T12:00:00Z');
  const store = createStore(openDatabase(':memory:'));
  const service = createService(store, { now: () => now });
  saveSettings(store, {
    sss: { manifestUrl: `${fake.base}/u/1/tok/manifest.json` },
    prowlarr: { url: fake.base, apiKey: 'prowlarr-key', maxQueries: 2 },
    qbittorrent: { url: fake.base, username: 'admin', password: 'qb-pass' },
    sabnzbd: { url: fake.base, apiKey: 'sab-key' },
    library: { root: library, mode: 'copy', minSizeMb: 1 },
    pathMappings: [{ remote: '/downloads', local: downloads }],
  });
  return {
    store, service, fake, downloads, library,
    advance: (ms) => { now = new Date(now.getTime() + ms); },
    async cleanup() { fake.server.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test('a requested SSS event goes from search to review to download to library', async (t) => {
  const env = await setup();
  t.after(() => env.cleanup());
  const { service, store, fake } = env;

  const sync = await service.syncEvents();
  assert.equal(sync.count, 1, 'events outside the lookback window are skipped');
  const event = store.getEvent('epl:101');
  assert.equal(event.promotionId, 'epl');

  const request = await service.requestEvent('epl:101');
  assert.equal(request.status, 'wanted');
  assert.equal(store.getEvent('epl:101').time, '15:30', 'detail refresh records the start time');
  const again = await service.requestEvent('epl:101');
  assert.equal(again.id, request.id, 'requesting twice returns the same request');

  await service.tick();
  const reviewed = store.getRequest(request.id);
  assert.equal(reviewed.status, 'review');
  assert.equal(fake.state.prowlarrQueries.length, 2, 'search is bounded by maxQueries');

  const candidates = store.listCandidates(request.id);
  const matched = candidates.filter((c) => c.decision === 'matched');
  assert.deepEqual(matched.map((c) => c.protocol).sort(), ['torrent', 'usenet']);
  const wrongYear = candidates.find((c) => c.title.includes('2025'));
  assert.equal(wrongYear.decision, 'rejected');
  assert.match(wrongYear.reason, /wrong-date/);
  assert.match(candidates.find((c) => /Highlights/.test(c.title)).reason, /sports-noise/);
  const best = matched[0];
  assert.equal(best.protocol, 'torrent', '1080p WEB-DL with seeders ranks first');
  assert.ok(best.evidence.some((line) => line.startsWith('1080p')));

  await assert.rejects(service.approve(request.id, wrongYear.id), /Only a release that matched/);
  await service.approve(request.id, best.id);
  assert.equal(store.getRequest(request.id).status, 'downloading');
  assert.equal(fake.state.torrents[0].category, 'replayarr');
  assert.equal(store.latestJob(request.id).remoteId, `hash:${'a'.repeat(40)}`);

  await service.tick();
  assert.equal(store.latestJob(request.id).state, 'downloading');
  assert.equal(store.latestJob(request.id).progress, 0.4);

  const folder = join(env.downloads, 'Premier.League.Arsenal.City');
  await mkdir(join(folder, 'Sample'), { recursive: true });
  await writeFile(join(folder, 'Sample', 'sample.mkv'), Buffer.alloc(3 * 1024 * 1024));
  await writeFile(join(folder, 'Premier.League.2026.09.21.Arsenal.vs.Manchester.City.1080p.mkv'), Buffer.alloc(2 * 1024 * 1024, 1));
  Object.assign(fake.state.torrents[0], { state: 'stalledUP', progress: 1 });

  await service.tick();
  const done = store.getRequest(request.id);
  assert.equal(done.status, 'ready', done.error || '');
  const item = store.libraryFor('epl:101');
  assert.equal(item.path, join(env.library, 'Premier League', 'Season 2026', 'Premier League - 2026-09-21 - Arsenal vs Manchester City [1080p].mkv'));
  assert.equal((await stat(item.path)).size, 2 * 1024 * 1024, 'the main file is imported, not the larger sample');
  assert.deepEqual(await readFile(item.path), Buffer.alloc(2 * 1024 * 1024, 1));
  await assert.rejects(service.requestEvent('epl:101'), /already in your library/);
});

test('usenet approvals go to SABnzbd and a failed job can pick another release', async (t) => {
  const env = await setup();
  t.after(() => env.cleanup());
  const { service, store, fake } = env;
  await service.syncEvents();
  const request = await service.requestEvent('epl:101');
  await service.searchRequest(request.id);
  const usenet = store.listCandidates(request.id).find((c) => c.protocol === 'usenet' && c.decision === 'matched');

  await service.approve(request.id, usenet.id);
  assert.equal(store.latestJob(request.id).remoteId, 'SABnzbd_nzo_1');
  fake.state.sab.queue = [];
  fake.state.sab.history = [{ nzo_id: 'SABnzbd_nzo_1', status: 'Failed', fail_message: 'Repair failed, not enough blocks' }];
  await service.reconcileJobs();
  const failed = store.getRequest(request.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Repair failed/);

  const torrent = store.listCandidates(request.id).find((c) => c.protocol === 'torrent' && c.decision === 'matched');
  await service.approve(request.id, torrent.id);
  assert.equal(store.getRequest(request.id).status, 'downloading');
});

test('a search with no match backs off instead of retrying every tick', async (t) => {
  const env = await setup();
  t.after(() => env.cleanup());
  const { service, store, fake } = env;
  service.addManualEvent({ promotionId: 'epl', title: 'Fulham vs Brentford', date: '2026-09-20' });
  const request = await service.requestEvent('epl:manual-2026-09-20-fulham-vs-brentford');
  await service.tick();
  const waiting = store.getRequest(request.id);
  assert.equal(waiting.status, 'wanted');
  assert.match(waiting.error, /No matching release yet/);
  const queries = fake.state.prowlarrQueries.length;
  await service.tick();
  assert.equal(fake.state.prowlarrQueries.length, queries, 'not searched again before the back-off');
  env.advance(31 * 60000);
  await service.tick();
  assert.ok(fake.state.prowlarrQueries.length > queries);
});

test('an upcoming event is not searched until after it starts', async (t) => {
  const env = await setup();
  t.after(() => env.cleanup());
  const { service, store, fake } = env;
  service.addManualEvent({ promotionId: 'ufc', title: 'UFC 321: Aspinall vs Gane', date: '2026-10-25', time: '22:00' });
  const request = await service.requestEvent('ufc:manual-2026-10-25-ufc-321-aspinall-vs-gane');
  assert.equal(request.nextSearchAt, '2026-10-26T01:00:00.000Z');
  await service.tick();
  assert.equal(fake.state.prowlarrQueries.length, 0);
  assert.equal(store.getRequest(request.id).status, 'wanted');
});

test('status changes that skip a step are refused', () => {
  const store = createStore(openDatabase(':memory:'));
  store.upsertEvent({ id: 'wwe:1', title: 'WWE Raw', date: '2026-09-21', source: 'manual' });
  const { request } = store.createRequest('wwe:1');
  assert.throws(() => store.setStatus(request.id, 'ready'), /cannot move from wanted to ready/);
  assert.throws(() => store.setStatus(request.id, 'downloading'), /cannot move from wanted to downloading/);
});

test('a qBittorrent API key is used instead of logging in', async (t) => {
  const env = await setup();
  t.after(() => env.cleanup());
  const { service, store, fake } = env;
  saveSettings(store, { qbittorrent: { apiKey: 'qbt_testkey1234567890123456789', password: 'wrong' } });
  await service.syncEvents();
  const request = await service.requestEvent('epl:101');
  await service.searchRequest(request.id);
  const torrent = store.listCandidates(request.id).find((c) => c.protocol === 'torrent' && c.decision === 'matched');
  await service.approve(request.id, torrent.id);
  await service.reconcileJobs();
  assert.equal(store.latestJob(request.id).state, 'downloading');
  assert.equal(fake.state.logins, 0);

  await assert.rejects(
    qbittorrent.testConnection({ url: fake.base, apiKey: 'qbt_revoked' }),
    /API key rejected/,
  );
  assert.equal(fake.state.logins, 0, 'a rejected key does not fall back to a password login');
});
