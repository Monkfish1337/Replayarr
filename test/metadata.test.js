import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { createStore } from '../src/store.js';
import { createService } from '../src/service.js';
import { evaluate } from '../src/matching/index.js';

// A stand-in schedule: what the ported SSS sources return for a promotion.
function fixtures() {
  const calls = [];
  const schedule = {
    epl: [
      { id: 'epl:1', name: 'Arsenal vs Manchester City', date: '2026-09-21', time: '15:30:00', aliases: ['Arsenal vs Manchester City'], teamNames: { home: ['Arsenal', 'ARS'], away: ['Manchester City', 'MCI'] } },
      { id: 'epl:2', name: 'Liverpool vs Chelsea', date: '2026-09-27', time: '12:30:00', aliases: [] },
    ],
    ufc: [
      { id: 'ufc:331', name: 'UFC 331: Van vs Pantoja 2', date: '2026-09-19', time: '22:00:00', aliases: [] },
    ],
  };
  async function fetchEvents(promotion) {
    calls.push({ id: promotion.id, source: promotion.source, start: promotion.metadataStartDate });
    if (promotion.source.type === 'thesportsdb' && promotion.source.leagueId === '999') throw new Error('TheSportsDB league was not found');
    return schedule[promotion.id] || [];
  }
  return { calls, schedule, fetchEvents };
}

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'replayarr-meta-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fx = fixtures();
  const store = createStore(openDatabase(':memory:'));
  const service = createService(store, { fetchEvents: fx.fetchEvents, logoDir: join(dir, 'logos'), now: () => new Date('2026-09-22T12:00:00Z') });
  return { store, service, metadata: service.metadata, fx, dir };
}

test('following a promotion fetches its schedule and keeps the full record for matching', async (t) => {
  const { store, metadata, fx } = await setup(t);
  assert.equal(metadata.list().find((p) => p.id === 'epl').followed, false);
  metadata.update('epl', { followed: true });
  await metadata.waitForIdle();

  assert.equal(fx.calls.length, 1);
  assert.equal(fx.calls[0].source.type, 'football-data', 'the built-in source is used by default');
  assert.equal(fx.calls[0].start, '2026-08-23', 'no start date set, so it reaches back the configured 30 days');
  const event = store.getEvent('epl:1');
  assert.equal(event.time, '15:30');
  assert.deepEqual(event.payload.teamNames.away, ['Manchester City', 'MCI']);
  // The matchers see the structured team names from the payload.
  assert.equal(evaluate('EPL.2026.09.21.ARS-MCI.1080p', event).ok, true);

  const epl = metadata.list().find((p) => p.id === 'epl');
  assert.equal(epl.followed, true);
  assert.equal(epl.refreshCount, 2);
  assert.equal(epl.providerName, 'football-data.org · Premier League');
});

test('a refresh removes events the source dropped, but never requested or manual ones', async (t) => {
  const { store, service, metadata, fx } = await setup(t);
  metadata.update('epl', { followed: true });
  await metadata.waitForIdle();
  await service.requestEvent('epl:1');
  service.addManualEvent({ promotionId: 'epl', title: 'Fulham vs Brentford', date: '2026-09-20' });
  fx.schedule.epl = [];
  metadata.refresh(['epl']);
  await metadata.waitForIdle();
  assert.ok(store.getEvent('epl:1'), 'requested event kept');
  assert.equal(store.getEvent('epl:2'), null, 'dropped event removed');
  assert.ok(store.getEvent('epl:manual-2026-09-20-fulham-vs-brentford'), 'manual event kept');
});

test('a promotion can be switched to another provider, and failures are reported per promotion', async (t) => {
  const { metadata, fx, service } = await setup(t);
  const provider = metadata.createProvider({ id: 'tsdb-broken', name: 'Broken league', type: 'thesportsdb', leagueId: '999' });
  assert.equal(provider.source.leagueId, '999');
  assert.throws(() => metadata.createProvider({ id: 'tsdb-ufc', name: 'Duplicate', type: 'thesportsdb', leagueId: '1' }), /already exists/);
  assert.throws(() => metadata.createProvider({ id: 'bad', name: 'Bad', type: 'thesportsdb', leagueId: 'abc' }), /must be numeric/);

  metadata.update('ufc', { followed: true, providerId: 'tsdb-broken', startDate: '2026-01-01' });
  await metadata.waitForIdle();
  const call = fx.calls.at(-1);
  assert.deepEqual(call.source, { type: 'thesportsdb', leagueId: '999' });
  assert.equal(call.start, '2026-01-01');
  const ufc = metadata.list().find((p) => p.id === 'ufc');
  assert.equal(ufc.refreshError, 'TheSportsDB league was not found');
  assert.ok(service.health().some((issue) => /UFC: TheSportsDB league was not found/.test(issue.message)));

  // Choosing the provider a promotion ships with clears the override.
  metadata.update('ufc', { providerId: 'tsdb-ufc' });
  assert.equal(metadata.list().find((p) => p.id === 'ufc').providerId, null);
  metadata.deleteProvider('tsdb-broken');
  assert.throws(() => metadata.deleteProvider('tsdb-ufc'), /cannot be deleted/);
});

test('logos can be chosen by URL or uploaded, and nothing else is accepted', async (t) => {
  const { metadata, dir } = await setup(t);
  metadata.update('nfl', { logoUrl: 'https://a.espncdn.com/i/teamlogos/leagues/500/nfl.png' });
  assert.equal(metadata.list().find((p) => p.id === 'nfl').logo, 'https://a.espncdn.com/i/teamlogos/leagues/500/nfl.png');
  assert.throws(() => metadata.update('nfl', { logoUrl: 'javascript:alert(1)' }), /https/);
  assert.throws(() => metadata.update('nfl', { logoUrl: 'http://example.com/logo.png' }), /https/);

  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const updated = await metadata.uploadLogo('nfl', `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(updated.logo, '/logos/nfl.png');
  assert.deepEqual(await readFile(join(dir, 'logos', 'nfl.png')), png);
  await assert.rejects(metadata.uploadLogo('nfl', 'data:text/html;base64,PGgxPg=='), /PNG, JPEG/);

  metadata.update('nfl', { logoUrl: '' });
  assert.equal(metadata.list().find((p) => p.id === 'nfl').logo, '');
});

test('each UFC event gets its own prelims event, which takes only prelims releases', async (t) => {
  const { store, service, metadata } = await setup(t);
  metadata.update('ufc', { followed: true });
  await metadata.waitForIdle();
  const main = store.getEvent('ufc:331');
  const prelims = store.getEvent('ufc:331-prelims');
  assert.equal(prelims.title, 'UFC 331: Van vs Pantoja 2 (Prelims)');
  assert.equal(prelims.date, main.date);
  assert.equal(metadata.list().find((p) => p.id === 'ufc').refreshCount, 1, 'counted as one event from the source');

  assert.equal(evaluate('UFC.331.Van.vs.Pantoja.2.PPV.1080p.WEB.h264', main).ok, true);
  assert.equal(evaluate('UFC.331.Prelims.1080p.WEB.h264', main).reason, 'prelims-release', 'the main event no longer takes the prelims');
  assert.equal(evaluate('UFC.331.Prelims.1080p.WEB.h264', prelims).ok, true);
  assert.equal(evaluate('UFC.331.Early.Prelims.720p.WEB', prelims).ok, true);
  assert.equal(evaluate('UFC.331.Van.vs.Pantoja.2.PPV.1080p.WEB.h264', prelims).reason, 'not-prelims');
  assert.equal(evaluate('UFC.330.Prelims.1080p.WEB.h264', prelims).ok, false, 'another event’s prelims');

  const request = await service.requestEvent(prelims.id);
  assert.equal(request.eventId, 'ufc:331-prelims', 'prelims are requested on their own');
  assert.equal(store.getRequest(request.id).status, 'wanted');
  assert.equal(store.listRequests().length, 1, 'requesting the prelims does not request the main card');
});
