import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { openDatabase } from '../src/db.js';
import { createStore } from '../src/store.js';
import { createService } from '../src/service.js';
import { createApi } from '../src/api.js';
import { MASK } from '../src/settings.js';

async function start(t) {
  const service = createService(createStore(openDatabase(':memory:')));
  const api = createApi(service, { testers: {} });
  const server = createServer((req, res) => api(req, res, new URL(req.url, 'http://x')));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = (path, init = {}) => fetch(base + path, init);
  const json = (method, path, body) => call(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { call, json };
}

test('writes must be JSON, so a cross-site form cannot trigger them', async (t) => {
  const { call } = await start(t);
  const form = await call('/events/sync', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
  assert.equal(form.status, 415);
});

test('secrets are masked on read and kept when the mask is saved back', async (t) => {
  const { call, json } = await start(t);
  await json('PUT', '/settings', { prowlarr: { url: 'http://prowlarr:9696', apiKey: 'secret-key' } });
  const { settings } = await (await call('/settings')).json();
  assert.equal(settings.prowlarr.apiKey, MASK);
  const saved = await (await json('PUT', '/settings', settings)).json();
  assert.equal(saved.prowlarr.apiKey, MASK);
  const health = await (await call('/health')).json();
  assert.ok(!health.some((issue) => /Prowlarr/.test(issue.message)), 'the key survived the round trip');
});

test('manual events are validated and matched to their promotion', async (t) => {
  const { json, call } = await start(t);
  const bad = await json('POST', '/events', { promotionId: 'epl', title: 'Arsenal vs Chelsea', date: '21/09/2026' });
  assert.equal(bad.status, 400);
  const created = await (await json('POST', '/events', { promotionId: 'ufc', title: 'UFC 321: Aspinall vs Gane', date: '2026-10-25' })).json();
  assert.equal(created.promotionId, 'ufc');
  const promotions = await (await call('/promotions')).json();
  assert.equal(promotions.find((p) => p.id === 'ufc').stats.events, 1);
});
