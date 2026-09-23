import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearLogs, configureLogging, listLogs, logger, redact, setLogLevel } from '../src/logger.js';

test('secrets never reach a log line', () => {
  const cases = [
    ['GET http://sab:8080/api?mode=queue&apikey=abc123def&output=json', 'apikey=<redacted>'],
    ['{"x-api-key":"secretkey123"}', '"x-api-key":"<redacted>"'],
    ['Authorization: Bearer qbt_abcdef1234567890', 'Authorization: <redacted>'],
    ['authorization=Basic ZW4tdXNlcjplbi1wYXNz', 'authorization=<redacted>'],
    ['https://user:pa55@members.easynews.com/dl/x', 'https://<redacted>@members.easynews.com'],
    ['https://www.thesportsdb.com/api/v1/json/99887766/lookupleague.php', 'json/<redacted>/lookupleague'],
  ];
  for (const [input, expected] of cases) assert.ok(redact(input).includes(expected), `${input} -> ${redact(input)}`);
  assert.equal(redact('https://www.thesportsdb.com/api/v1/json/123/x'), 'https://www.thesportsdb.com/api/v1/json/123/x', 'the public free key is kept');
  for (const [input] of cases) assert.ok(!/abc123def|secretkey123|abcdef1234567890|ZW4tdXNl|pa55|99887766/.test(redact(input)));
});

test('entries are filtered by level, component and text, and written to disk', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'replayarr-log-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  clearLogs();
  configureLogging({ dir, level: 'debug' });
  const search = logger('search');
  const download = logger('download');
  search.debug('UFC: "UFC 331" returned 12 result(s)');
  search.info('Searching for UFC 331', { request: 7 });
  download.warn('Easynews returned HTTP 404 for https://members.easynews.com/dl/x', { apikey: 'x' });
  setLogLevel('info');
  search.debug('not recorded at info');

  assert.deepEqual(listLogs({ level: 'debug' }).map((e) => e.component), ['download', 'search', 'search'], 'newest first');
  assert.deepEqual(listLogs({ level: 'warn' }).map((e) => e.message), ['Easynews returned HTTP 404 for https://members.easynews.com/dl/x']);
  assert.equal(listLogs({ component: 'search', q: '331' }).length, 2);
  assert.equal(listLogs({ level: 'debug' }).find((e) => e.component === 'search' && e.level === 'info').details, 'request=7');

  await new Promise((r) => setTimeout(r, 50));
  const file = await readFile(join(dir, 'replayarr.txt'), 'utf8');
  assert.match(file, /WARN  \[download\] Easynews returned HTTP 404/);
  assert.doesNotMatch(file, /not recorded at info/);
});
