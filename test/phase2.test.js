import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { createStore } from '../src/store.js';
import { createService } from '../src/service.js';
import { loadSettings, saveSettings } from '../src/settings.js';
import { normalise } from '../src/adapters/prowlarr.js';
import { isUpgrade, normaliseProfile, qualityRank, wantsUpgrade } from '../src/profiles.js';

const REL = {
  hd720: 'UFC.331.Van.vs.Pantoja.2.720p.WEB.h264-GRP',
  hd1080: 'UFC.331.Van.vs.Pantoja.2.1080p.WEB.h264-GRP',
  sd: 'UFC.331.Van.vs.Pantoja.2.480p.HDTV.x264-GRP',
};

// Stub indexer and qBittorrent: the test decides what the indexer offers and
// when each download completes; completed downloads are real files.
async function setup(t, { profile = {}, offer = [REL.hd720] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'replayarr-p2-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = new Date('2026-09-20T12:00:00Z');
  const indexer = { offer, queries: 0 };
  const client = { added: [], states: new Map() };
  const hash = (title) => createHash('sha1').update(title).digest('hex');
  const adapters = {
    prowlarr: {
      search: async () => { indexer.queries += 1; return indexer.offer.map((title) => normalise({ title, protocol: 'torrent', size: 3e9, seeders: 40, magnetUrl: `magnet:?xt=urn:btih:${hash(title)}`, guid: title })); },
    },
    qbittorrent: {
      add: async (_config, candidate) => { client.added.push(candidate.title); client.states.set(candidate.infoHash, { state: 'downloading', progress: 0.5 }); return { remoteId: candidate.infoHash }; },
      status: async (_config, remoteId) => client.states.get(remoteId) || null,
    },
  };
  async function complete(title, { fail = false } = {}) {
    if (fail) { client.states.set(hash(title), { state: 'failed', error: 'tracker error' }); return; }
    const folder = join(dir, 'downloads', title);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, `${title}.mkv`), Buffer.alloc(2 * 1024 * 1024, title.length));
    client.states.set(hash(title), { state: 'completed', progress: 1, path: folder });
  }
  const store = createStore(openDatabase(':memory:'));
  const service = createService(store, {
    now: () => now, adapters, fetchEvents: async () => [], logoDir: join(dir, 'logos'), mediaServerDelayMs: 0,
    fetchImage: async () => new Response(Buffer.from('89504e47', 'hex'), { headers: { 'content-type': 'image/png' } }),
  });
  saveSettings(store, {
    indexers: [{ id: 'p', type: 'prowlarr', name: 'Prowlarr', url: 'http://prowlarr', apiKey: 'k' }],
    qbittorrent: { url: 'http://qbittorrent' },
    library: { root: join(dir, 'library'), mode: 'copy', minSizeMb: 1, writeMetadata: 'no' },
    profiles: [{ id: 'default', name: 'Any', qualities: ['2160p', '1080p', '720p', 'unknown'], cutoff: '1080p', ...profile }],
  });
  const event = service.addManualEvent({ promotionId: 'ufc', title: 'UFC 331: Van vs Pantoja 2', date: '2026-09-19' });
  const request = await service.requestEvent(event.id);
  return {
    store, service, indexer, client, complete, event, request, dir,
    advance: (hours) => { now = new Date(now.getTime() + hours * 3600000); },
    libraryFiles: async () => (await readdir(join(dir, 'library'), { recursive: true })).filter((f) => f.endsWith('.mkv')),
  };
}

test('quality ranks, cutoffs and upgrades', () => {
  assert.ok(qualityRank('2160p') > qualityRank('1080p') && qualityRank('1080p') > qualityRank('720p') && qualityRank('480p') > qualityRank(null));
  const profile = normaliseProfile({ qualities: ['1080p', '720p', 'bogus'], cutoff: '2160p' });
  assert.deepEqual(profile.qualities, ['1080p', '720p']);
  assert.equal(profile.cutoff, '1080p', 'a cutoff outside the allowed qualities falls back to the best allowed');
  assert.equal(wantsUpgrade(profile, '720p'), true);
  assert.equal(wantsUpgrade(profile, '1080p'), false);
  assert.equal(wantsUpgrade({ ...profile, upgrades: 'no' }, '720p'), false);
  assert.equal(isUpgrade(profile, '720p', '1080p'), true);
  assert.equal(isUpgrade(profile, '720p', '2160p'), false, 'not an allowed quality');
  assert.equal(isUpgrade(profile, '1080p', '1080p'), false);
});

test('an automatic search grabs the best match; interactive, manual profiles and low scores do not', async (t) => {
  const env = await setup(t);
  const auto = await env.service.searchRequest(env.request.id);
  assert.equal(auto.status, 'downloading');
  assert.deepEqual(env.client.added, [REL.hd720]);
  assert.ok(env.store.listActivity(20).some((a) => /grabbed .*720p.* automatically/.test(a.text)));

  const interactive = await setup(t);
  assert.equal((await interactive.service.searchRequest(interactive.request.id, { interactive: true })).status, 'review');
  assert.deepEqual(interactive.client.added, []);

  const manual = await setup(t, { profile: { autoGrab: 'no' } });
  assert.equal((await manual.service.searchRequest(manual.request.id)).status, 'review');

  const strict = await setup(t, { profile: { minScore: 100 } });
  assert.equal((await strict.service.searchRequest(strict.request.id)).status, 'review', 'nothing reaches the minimum score');
});

test('a quality the profile does not allow is rejected with the reason', async (t) => {
  const env = await setup(t, { offer: [REL.sd] });
  const result = await env.service.searchRequest(env.request.id);
  assert.equal(result.status, 'wanted');
  const [candidate] = env.store.listCandidates(env.request.id);
  assert.equal(candidate.decision, 'rejected');
  assert.equal(candidate.reason, 'profile: 480p not wanted by Any');
});

test('a failed download is set aside and the next best release grabbed', async (t) => {
  const env = await setup(t, { offer: [REL.hd1080, REL.hd720] });
  await env.service.searchRequest(env.request.id);
  assert.deepEqual(env.client.added, [REL.hd1080]);
  await env.complete(REL.hd1080, { fail: true });
  await env.service.reconcileJobs();
  assert.deepEqual(env.client.added, [REL.hd1080, REL.hd720]);
  assert.equal(env.store.getRequest(env.request.id).status, 'downloading');
  const failed = env.store.listCandidates(env.request.id).find((c) => c.title === REL.hd1080);
  assert.equal(failed.decision, 'rejected');
  assert.match(failed.reason, /^download: failed/);
});

test('an event imported below the cutoff is upgraded when a better release appears, replacing the file', async (t) => {
  const env = await setup(t);
  await env.service.searchRequest(env.request.id);
  await env.complete(REL.hd720);
  await env.service.tick();
  let request = env.store.getRequest(env.request.id);
  assert.equal(request.status, 'ready');
  assert.equal(env.store.libraryFor(env.event.id).quality, '720p');
  assert.equal(request.nextSearchAt, '2026-09-20T18:00:00.000Z', 'below the 1080p cutoff: look again in 6 hours');
  const [firstFile] = await env.libraryFiles();
  assert.match(firstFile, /720p/);

  env.advance(3);
  await env.service.tick();
  assert.deepEqual(env.client.added, [REL.hd720], 'not due yet');

  env.indexer.offer = [REL.hd720, REL.hd1080];
  env.advance(3);
  await env.service.tick();
  assert.deepEqual(env.client.added, [REL.hd720, REL.hd1080], 'the 1080p release is grabbed as an upgrade');
  assert.equal(env.store.getRequest(env.request.id).status, 'downloading');
  assert.equal(env.store.libraryFor(env.event.id).quality, '720p', 'the library copy stays until the upgrade imports');

  await env.complete(REL.hd1080);
  await env.service.tick();
  request = env.store.getRequest(env.request.id);
  assert.equal(request.status, 'ready');
  assert.equal(request.nextSearchAt, null, 'at the cutoff: no more upgrade searches');
  assert.equal(env.store.libraryFor(env.event.id).quality, '1080p');
  const files = await env.libraryFiles();
  assert.equal(files.length, 1, 'the 720p copy was removed');
  assert.match(files[0], /1080p/);
  assert.ok(env.store.listActivity(30).some((a) => /upgraded from 720p to 1080p/.test(a.text)));
});

test('upgrade searches stop a week after the event, and a failed upgrade keeps the library copy', async (t) => {
  const env = await setup(t);
  await env.service.searchRequest(env.request.id);
  await env.complete(REL.hd720);
  await env.service.tick();

  env.indexer.offer = [REL.hd1080];
  env.advance(6);
  await env.service.tick();
  await env.complete(REL.hd1080, { fail: true });
  await env.service.tick();
  let request = env.store.getRequest(env.request.id);
  assert.equal(request.status, 'ready');
  assert.match(request.error, /Upgrade failed/);
  assert.equal(env.store.libraryFor(env.event.id).quality, '720p');
  assert.ok(request.nextSearchAt, 'still looking');

  env.advance(24 * 8);
  const before = env.indexer.queries;
  await env.service.tick();
  request = env.store.getRequest(env.request.id);
  assert.equal(request.nextSearchAt, null, 'a week after the event: stop looking');
  assert.equal(env.indexer.queries, before, 'without asking the indexers');
});

test('a promotion can be given a profile; unknown profiles are refused', async (t) => {
  const env = await setup(t);
  saveSettings(env.store, { profiles: [...loadSettings(env.store).profiles, { id: 'hd', name: 'HD only', qualities: ['1080p'], autoGrab: 'no' }] });
  env.service.metadata.update('ufc', { profileId: 'hd' });
  assert.equal(env.service.metadata.list().find((p) => p.id === 'ufc').profileId, 'hd');
  assert.throws(() => env.service.metadata.update('ufc', { profileId: 'nope' }), /Unknown quality profile/);
  const result = await env.service.searchRequest(env.request.id);
  assert.equal(result.status, 'wanted', 'the HD profile rejects the 720p release');
  assert.match(env.store.listCandidates(env.request.id)[0].reason, /720p not wanted by HD only/);
});
