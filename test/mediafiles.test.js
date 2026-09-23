import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { createStore } from '../src/store.js';
import { createService } from '../src/service.js';
import { saveSettings } from '../src/settings.js';
import { episodeNumber } from '../src/mediaFiles.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const JPG = Buffer.from('ffd8ffe000104a46', 'hex');
const exists = (path) => stat(path).then(() => true, () => false);

// A UFC event as a metadata refresh stores it, including TheSportsDB artwork.
const UFC_331 = {
  id: 'ufc:331', promotionId: 'ufc', title: 'UFC 331 Van vs Pantoja 2', date: '2026-09-20', time: '02:00',
  aliases: [], source: 'metadata', sourceRevision: 'thesportsdb',
  payload: {
    name: 'UFC 331 Van vs Pantoja 2', date: '2026-09-20', venue: 'T-Mobile Arena', city: 'Las Vegas', country: 'USA',
    description: 'Flyweight title rematch & more.', thumb: 'https://img.test/ufc331-thumb.jpg', fanart: 'https://img.test/ufc331-fanart.jpg',
  },
};

async function setup(t, { images = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'replayarr-media-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fetched = [];
  const fetchImage = async (url) => {
    fetched.push(url);
    if (images[url] === 404) return new Response('', { status: 404 });
    return new Response(images[url] || JPG, { headers: { 'content-type': url.endsWith('.png') ? 'image/png' : 'image/jpeg' } });
  };
  const refreshes = [];
  const jellyfin = { refreshLibrary: async (config) => { refreshes.push(config); } };
  const store = createStore(openDatabase(':memory:'));
  const service = createService(store, {
    fetchImage, logoDir: join(dir, 'logos'), mediaServerDelayMs: 0, adapters: { jellyfin }, fetchEvents: async () => [],
    now: () => new Date('2026-09-22T12:00:00Z'),
  });
  const library = join(dir, 'library');
  const downloads = join(dir, 'downloads');
  saveSettings(store, {
    library: { root: library, mode: 'copy', minSizeMb: 1 },
    jellyfin: { url: 'http://jellyfin:8096', apiKey: 'jf-key' },
  });
  store.upsertEvent(UFC_331);
  store.upsertEvent({ ...UFC_331, id: 'ufc:331-prelims', title: 'UFC 331 Prelims', time: '00:00', payload: { ...UFC_331.payload, name: 'UFC 331 Prelims' } });
  return { dir, store, service, library, downloads, fetched, refreshes };
}

// Put a finished download in front of the importer, as the worker would.
async function finishedDownload({ store, downloads }, event) {
  const folder = join(downloads, 'UFC.331.1080p');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'UFC.331.Van.vs.Pantoja.2.1080p.WEB.mkv'), Buffer.alloc(2 * 1024 * 1024, 5));
  const { request } = store.createRequest(event.id);
  store.saveCandidates(request.id, [{ identity: 'btih:x', source: 'Test', protocol: 'torrent', title: 'UFC.331.Van.vs.Pantoja.2.1080p.WEB', downloadUrl: 'magnet:?x', score: 90, quality: '1080p', decision: 'matched' }]);
  const candidate = store.listCandidates(request.id)[0];
  for (const status of ['searching', 'review']) store.setStatus(request.id, status);
  store.setStatus(request.id, 'downloading', { candidateId: candidate.id });
  const job = store.createJob({ requestId: request.id, candidateId: candidate.id, client: 'qbittorrent', remoteId: 'hash:x' });
  store.updateJob(job.id, { state: 'completed', progress: 1, remotePath: folder });
  store.setStatus(request.id, 'importing');
  return request;
}

test('episode numbers follow the date and the order of the day', () => {
  const day = [{ id: 'b', time: '02:00' }, { id: 'a', time: '00:00' }];
  assert.deepEqual(episodeNumber({ id: 'a', date: '2026-09-20' }, day), { season: 2026, episode: 92001 });
  assert.deepEqual(episodeNumber({ id: 'b', date: '2026-09-20' }, day), { season: 2026, episode: 92002 });
  assert.deepEqual(episodeNumber({ id: 'c', date: '2026-12-31' }, [{ id: 'c' }]), { season: 2026, episode: 123101 });
});

test('an import is named for Jellyfin and gets its .nfo, thumbnail and show files', async (t) => {
  const env = await setup(t);
  const { service, store, library, refreshes } = env;
  service.metadata.update('ufc', { logoUrl: 'https://img.test/ufc-logo.png' });
  const request = await finishedDownload(env, UFC_331);
  await service.importRequest(request.id);
  assert.equal(store.getRequest(request.id).status, 'ready', store.getRequest(request.id).error || '');

  const item = store.libraryFor('ufc:331');
  const season = join(library, 'UFC', 'Season 2026');
  assert.equal(item.path, join(season, 'UFC - S2026E092002 - UFC 331 Van vs Pantoja 2 [1080p].mkv'), 'second event that day, after the prelims');
  assert.deepEqual([item.season, item.episode], [2026, 92002]);

  const nfo = await readFile(join(season, 'UFC - S2026E092002 - UFC 331 Van vs Pantoja 2 [1080p].nfo'), 'utf8');
  for (const expected of ['<title>UFC 331 Van vs Pantoja 2</title>', '<showtitle>UFC</showtitle>', '<season>2026</season>',
    '<episode>92002</episode>', '<aired>2026-09-20</aired>', 'Flyweight title rematch &amp; more.', 'Venue: T-Mobile Arena, Las Vegas, USA',
    '<uniqueid type="replayarr" default="true">ufc:331</uniqueid>']) {
    assert.ok(nfo.includes(expected), `nfo has ${expected}`);
  }
  assert.deepEqual(await readFile(join(season, 'UFC - S2026E092002 - UFC 331 Van vs Pantoja 2 [1080p]-thumb.jpg')), JPG);
  assert.match(await readFile(join(library, 'UFC', 'tvshow.nfo'), 'utf8'), /<title>UFC<\/title>/);
  assert.ok(await exists(join(library, 'UFC', 'poster.png')), 'the chosen logo is the show poster');
  assert.ok(await exists(join(library, 'UFC', 'fanart.jpg')));

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(refreshes.length, 1, 'Jellyfin was asked to rescan');
  assert.equal(refreshes[0].apiKey, 'jf-key');
});

test('missing artwork never fails an import, and never removes existing artwork', async (t) => {
  const env = await setup(t, { images: { 'https://img.test/ufc331-thumb.jpg': 404, 'https://img.test/ufc331-fanart.jpg': 404 } });
  const { service, store, library } = env;
  await mkdir(join(library, 'UFC'), { recursive: true });
  await writeFile(join(library, 'UFC', 'fanart.png'), PNG);
  const request = await finishedDownload(env, UFC_331);
  await service.importRequest(request.id);
  assert.equal(store.getRequest(request.id).status, 'ready');
  assert.ok(store.listActivity().some((a) => /some artwork was not saved/.test(a.text)));
  await service.writeAllMetadata();
  assert.deepEqual(await readFile(join(library, 'UFC', 'fanart.png')), PNG, 'a failed download left the old fanart in place');
});

test('Rename Files moves events imported under an older pattern, with their side files', async (t) => {
  const env = await setup(t);
  const { service, store, library } = env;
  // As imported before episode numbering existed.
  const oldFolder = join(library, 'UFC', 'Season 2026');
  const oldPath = join(oldFolder, 'UFC - 2026-09-20 - UFC 331 Van vs Pantoja 2 [1080p].mkv');
  await mkdir(oldFolder, { recursive: true });
  await writeFile(oldPath, Buffer.alloc(1024, 1));
  await writeFile(oldPath.replace(/\.mkv$/, '.nfo'), '<episodedetails/>');
  await writeFile(oldPath.replace(/\.mkv$/, '-thumb.jpg'), JPG);
  store.upsertEvent({ ...UFC_331 });
  const { request } = store.createRequest('ufc:331');
  store.addLibraryItem({ eventId: 'ufc:331', requestId: request.id, path: oldPath, size: 1024, quality: '1080p', releaseTitle: 'UFC.331' });

  const plan = service.renamePlan();
  const newPath = join(oldFolder, 'UFC - S2026E092002 - UFC 331 Van vs Pantoja 2 [1080p].mkv');
  assert.deepEqual(plan.map((p) => [p.from, p.to, p.changed]), [[oldPath, newPath, true]]);

  const results = await service.renameFiles();
  assert.deepEqual(results.map((r) => r.ok), [true]);
  assert.equal(store.libraryFor('ufc:331').path, newPath);
  assert.equal(store.libraryFor('ufc:331').episode, 92002);
  const files = (await readdir(oldFolder)).sort();
  assert.deepEqual(files, [
    'UFC - S2026E092002 - UFC 331 Van vs Pantoja 2 [1080p]-thumb.jpg',
    'UFC - S2026E092002 - UFC 331 Van vs Pantoja 2 [1080p].mkv',
    'UFC - S2026E092002 - UFC 331 Van vs Pantoja 2 [1080p].nfo',
  ]);
  assert.match(await readFile(newPath.replace(/\.mkv$/, '.nfo'), 'utf8'), /<episode>92002<\/episode>/, 'the .nfo is rewritten with the new numbers');
  assert.equal(service.renamePlan()[0].changed, false, 'nothing left to rename');
});
