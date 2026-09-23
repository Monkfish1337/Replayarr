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

// Stand-ins for Prowlarr, Bitmagnet, Easynews, qBittorrent and SABnzbd that speak just enough
// of each real API for the pipeline to run against them over HTTP.
async function fakeServices(downloadDir) {
  const state = { torrents: [], sab: { queue: [], history: [] }, prowlarrQueries: [], logins: 0, prowlarrKeys: [], bitmagnetQueries: 0, easynewsQueries: 0, easynewsRanges: [] };
  const easynewsFile = Buffer.alloc(2 * 1024 * 1024, 7);
  const hash = 'a'.repeat(40);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = (value) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    // Prowlarr
    if (url.pathname === '/api/v1/search') {
      assert.ok(['prowlarr-key', 'usenet-key'].includes(req.headers['x-api-key']));
      state.prowlarrKeys.push(req.headers['x-api-key']);
      state.prowlarrQueries.push(url.searchParams.get('query'));
      return json([
        { title: 'Premier.League.2026.09.21.Arsenal.vs.Manchester.City.1080p.WEB-DL.H264', protocol: 'torrent', size: 5e9, seeders: 40, indexer: 'Tracker', magnetUrl: `magnet:?xt=urn:btih:${hash}`, guid: 'g1' },
        { title: 'EPL.2026.09.21.Arsenal.vs.Man.City.720p.HDTV', protocol: 'usenet', size: 3e9, indexer: 'NZBgeek', downloadUrl: 'http://prowlarr/nzb/2', guid: 'g2' },
        { title: 'Premier.League.2025.09.21.Arsenal.vs.Manchester.City.1080p', protocol: 'torrent', size: 5e9, seeders: 90, indexer: 'Tracker', magnetUrl: `magnet:?xt=urn:btih:${'b'.repeat(40)}`, guid: 'g3' },
        { title: 'Arsenal vs Manchester City 2026.09.21 Highlights 1080p', protocol: 'torrent', size: 4e8, seeders: 5, indexer: 'Tracker', magnetUrl: `magnet:?xt=urn:btih:${'c'.repeat(40)}`, guid: 'g4' },
      ]);
    }
    // Bitmagnet GraphQL
    if (url.pathname === '/graphql' && req.method === 'POST') {
      const { variables } = JSON.parse(body);
      if (!variables?.input) return json({ data: { __typename: 'Query' } });
      state.bitmagnetQueries += 1;
      assert.deepEqual(variables.input.orderBy, [{ field: 'seeders', descending: true }]);
      return json({ data: { torrentContent: { search: { items: [
        { infoHash: 'd'.repeat(40), publishedAt: '1999-01-01T00:00:00Z', seeders: 12, torrent: { name: 'EPL.2026.09.21.Arsenal.vs.Man.City.2160p.WEB.h265', size: 9e9, seeders: 12, magnetUri: 'magnet:?xt=urn:btih:' + 'd'.repeat(40) } },
        { infoHash: 'a'.repeat(40), seeders: 40, torrent: { name: 'Premier.League.2026.09.21.Arsenal.vs.Manchester.City.1080p.WEB-DL.H264', size: 5e9 } },
      ] } } } });
    }
    // Easynews search and file download
    const basic = 'Basic ' + Buffer.from('en-user:en-pass').toString('base64');
    if (url.pathname === '/2.0/search/solr-search/advanced') {
      if (req.headers.authorization !== basic) return res.writeHead(401).end();
      state.easynewsQueries += 1;
      return json({ dlFarm: 'farm1', dlPort: 443, downURL: '//evil.example.com', data: [
        { 0: 'enhash1', 10: 'Premier.League.2026.09.21.Arsenal.vs.Manchester.City.720p.WEB', 11: '.mkv', type: 'VIDEO', rawSize: easynewsFile.length, 14: '1h 52m', 5: '2026-09-21 18:00:00' },
        { 0: 'enhash2', 10: 'Arsenal.City.thumbs', 11: '.mp4', type: 'VIDEO', rawSize: 1000, 14: '40s' },
      ] });
    }
    if (url.pathname === '/farm1/443/enhash1.mkv/' + encodeURIComponent('Premier.League.2026.09.21.Arsenal.vs.Manchester.City.720p.WEB') + '.mkv') {
      if (req.headers.authorization !== basic) return res.writeHead(401).end();
      const range = /bytes=(\d+)-/.exec(req.headers.range || '');
      state.easynewsRanges.push(range ? Number(range[1]) : 0);
      const start = range ? Number(range[1]) : 0;
      res.writeHead(range ? 206 : 200, { 'content-length': easynewsFile.length - start });
      return res.end(easynewsFile.subarray(start));
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
        state.torrents.push({ hash, url: form.get('urls'), tags: form.get('tags'), category: form.get('category'), savepath: form.get('savepath'), state: 'downloading', progress: 0.4, content_path: '/downloads/Premier.League.Arsenal.City' });
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
    prowlarr: { url: fake.base, apiKey: 'prowlarr-key', maxQueries: 2 },
    qbittorrent: { url: fake.base, username: 'admin', password: 'qb-pass' },
    sabnzbd: { url: fake.base, apiKey: 'sab-key' },
    library: { root: library, mode: 'copy', minSizeMb: 1 },
    pathMappings: [{ remote: '/downloads', local: downloads }],
  });
  store.upsertEvent({
    id: 'epl:101', promotionId: 'epl', title: 'Arsenal vs Manchester City', date: '2026-09-21', time: '15:30',
    aliases: [], source: 'metadata', sourceRevision: 'football-data',
    payload: { id: 'epl:101', name: 'Arsenal vs Manchester City', date: '2026-09-21', time: '15:30:00', teamNames: { home: ['Arsenal'], away: ['Manchester City'] } },
  });
  return {
    store, service, fake, downloads, library,
    advance: (ms) => { now = new Date(now.getTime() + ms); },
    async cleanup() { fake.server.close(); await rm(dir, { recursive: true, force: true }); },
  };
}

test('a requested event goes from search to review to download to library', async (t) => {
  const env = await setup();
  t.after(() => env.cleanup());
  const { service, store, fake } = env;

  const event = store.getEvent('epl:101');
  assert.equal(event.promotionId, 'epl');

  const request = await service.requestEvent('epl:101');
  assert.equal(request.status, 'wanted');
  assert.equal(request.nextSearchAt, '2026-09-22T12:00:00.000Z', 'already three hours past kick-off, so due now');
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

test('every configured indexer is searched, and Easynews results download through the built-in downloader', async (t) => {
  const env = await setup();
  process.env.REPLAYARR_EASYNEWS_BASE_URL = env.fake.base;
  t.after(() => { delete process.env.REPLAYARR_EASYNEWS_BASE_URL; return env.cleanup(); });
  const { service, store, fake } = env;
  const easynewsFolder = join(env.downloads, 'easynews');
  saveSettings(store, { indexers: [
    { id: 'torrents', type: 'prowlarr', name: 'Prowlarr', url: fake.base, apiKey: 'prowlarr-key', maxQueries: 1 },
    { id: 'usenet', type: 'prowlarr', name: 'Prowlarr (Usenet)', url: fake.base, apiKey: 'usenet-key', maxQueries: 1 },
    { id: 'dht', type: 'bitmagnet', name: 'Bitmagnet', url: fake.base + '/graphql', maxQueries: 2 },
    { id: 'en', type: 'easynews', name: 'Easynews', username: 'en-user', password: 'en-pass', downloadFolder: easynewsFolder, maxQueries: 1 },
    { id: 'off', type: 'prowlarr', name: 'Disabled', url: fake.base, apiKey: 'nope', enabled: false },
  ] });
  const request = await service.requestEvent('epl:101');
  await service.searchRequest(request.id);

  assert.deepEqual(fake.state.prowlarrKeys, ['prowlarr-key', 'usenet-key'], 'both Prowlarr instances, not the disabled one');
  assert.equal(fake.state.bitmagnetQueries, 2);
  assert.equal(fake.state.easynewsQueries, 1);
  const candidates = store.listCandidates(request.id);
  const bySource = (source) => candidates.filter((c) => c.source === source).map((c) => c.title);
  assert.ok(bySource('Bitmagnet').includes('EPL.2026.09.21.Arsenal.vs.Man.City.2160p.WEB.h265'));
  assert.ok(!bySource('Bitmagnet').some((title) => title.includes('1080p')), 'a hash Prowlarr already reported is not duplicated');
  assert.equal(candidates.find((c) => c.source === 'Bitmagnet').publishedAt, null, "Bitmagnet's 1999 placeholder is not a date");
  const easy = candidates.find((c) => c.protocol === 'easynews');
  assert.equal(easy.decision, 'matched');
  assert.equal(candidates.filter((c) => c.protocol === 'easynews').length, 1, 'thumbnail strips are dropped');
  assert.ok(!easy.downloadUrl.includes('en-pass') && !easy.downloadUrl.includes(Buffer.from('en-user:en-pass').toString('base64')));
  assert.deepEqual(store.listSearches(request.id).map((s) => s.source).sort(), ['Bitmagnet', 'Easynews', 'Prowlarr', 'Prowlarr (Usenet)']);

  await service.approve(request.id, easy.id);
  const job = store.latestJob(request.id);
  assert.equal(job.client, 'easynews');
  for (let i = 0; i < 50 && store.getRequest(request.id).status === 'downloading'; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
    await service.reconcileJobs();
  }
  assert.equal(store.getRequest(request.id).status, 'importing');
  await service.tick();
  const done = store.getRequest(request.id);
  assert.equal(done.status, 'ready', done.error || '');
  const item = store.libraryFor('epl:101');
  assert.match(item.path, /Premier League - 2026-09-21 - Arsenal vs Manchester City \[720p\]\.mkv$/);
  assert.deepEqual(await readFile(item.path), Buffer.alloc(2 * 1024 * 1024, 7));
});

test('an interrupted Easynews download resumes from the partial file', async (t) => {
  const env = await setup();
  process.env.REPLAYARR_EASYNEWS_BASE_URL = env.fake.base;
  t.after(() => { delete process.env.REPLAYARR_EASYNEWS_BASE_URL; return env.cleanup(); });
  const easynews = await import('../src/adapters/easynews.js');
  const config = { id: 'en', username: 'en-user', password: 'en-pass', downloadFolder: join(env.downloads, 'en') };
  const [result] = await easynews.search(config, 'Arsenal');
  assert.equal(new URL(easynews.fileUrl(easynews.unpackToken(result.downloadUrl.slice(9)))).host, new URL(env.fake.base).host);
  delete process.env.REPLAYARR_EASYNEWS_BASE_URL;
  assert.equal(new URL(easynews.fileUrl({ u: '//evil.example.com', h: 'x' })).host, 'members.easynews.com', 'only easynews.com hosts receive credentials');
  process.env.REPLAYARR_EASYNEWS_BASE_URL = env.fake.base;

  // Simulate a restart: a partial file exists and the process has no record of the job.
  const folder = join(config.downloadFolder, 'replayarr-99');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'Premier.League.2026.09.21.Arsenal.vs.Manchester.City.720p.WEB.mkv.part'), Buffer.alloc(1024 * 1024, 7));
  const remoteId = `en|replayarr-99|${result.downloadUrl.slice(9)}`;
  let status = await easynews.status(config, remoteId);
  for (let i = 0; i < 50 && status.state !== 'completed'; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
    status = await easynews.status(config, remoteId);
  }
  assert.equal(status.state, 'completed');
  assert.deepEqual(env.fake.state.easynewsRanges, [1024 * 1024], 'resumed with a Range request');
  assert.deepEqual(await readFile(join(folder, 'Premier.League.2026.09.21.Arsenal.vs.Manchester.City.720p.WEB.mkv')), Buffer.alloc(2 * 1024 * 1024, 7));
});

test('an unmapped client path fails with a fix-it message, and Retry imports once mapped', async (t) => {
  const env = await setup();
  t.after(() => env.cleanup());
  const { service, store, fake } = env;
  saveSettings(store, { qbittorrent: { savePath: '/downloads/replays' }, pathMappings: [] });
  const request = await service.requestEvent('epl:101');
  await service.searchRequest(request.id);
  const torrent = store.listCandidates(request.id).find((c) => c.protocol === 'torrent' && c.decision === 'matched');
  await service.approve(request.id, torrent.id);
  assert.equal(fake.state.torrents[0].savepath, '/downloads/replays', 'the save path is sent with the torrent');

  // qBittorrent reports the path as it sees it inside its own container.
  const folder = join(env.downloads, 'replays', 'Premier.League.Arsenal.City');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'Premier.League.2026.09.21.Arsenal.vs.Manchester.City.1080p.mkv'), Buffer.alloc(2 * 1024 * 1024, 3));
  Object.assign(fake.state.torrents[0], { state: 'stalledUP', progress: 1, content_path: '/downloads/replays/Premier.League.Arsenal.City' });
  await service.tick();
  const failed = store.getRequest(request.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /ENOENT.*add a Remote Path Mapping/);

  saveSettings(store, { pathMappings: [{ remote: '/downloads', local: env.downloads }] });
  service.retry(request.id);
  await service.tick();
  assert.equal(store.getRequest(request.id).status, 'ready', store.getRequest(request.id).error || '');
  assert.equal(fake.state.torrents.length, 1, 'retrying an import does not download again');
});
