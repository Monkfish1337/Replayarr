import test from 'node:test';
import assert from 'node:assert/strict';
import { addRequest, advanceRequest, initialState, requestFor, selectRelease } from '../model.js';

test('requesting the same event twice does not duplicate work', () => {
  const once = addRequest(initialState(), 'wwe-0921');
  const twice = addRequest(once, 'wwe-0921');
  assert.equal(twice, once);
  assert.equal(requestFor(once, 'wwe-0921').status, 'queued');
});

test('only a candidate for the requested event can start a download', () => {
  const state = initialState();
  assert.equal(selectRelease(state, 'req-2', 'nfl-a'), state);
  const selected = selectRelease(state, 'req-2', 'mlb-a');
  assert.equal(selected.requests.find((item) => item.id === 'req-2').status, 'downloading');
});

test('request lifecycle reaches review and ready without skipping approval', () => {
  let state = addRequest(initialState(), 'wwe-0921');
  const id = requestFor(state, 'wwe-0921').id;
  state = advanceRequest(state, id);
  state = advanceRequest(state, id);
  assert.equal(requestFor(state, 'wwe-0921').status, 'review');
  assert.equal(advanceRequest(state, id), state);
  state = selectRelease(state, id, 'wwe-a');
  state = advanceRequest(state, id);
  state = advanceRequest(state, id);
  assert.equal(requestFor(state, 'wwe-0921').status, 'ready');
});
