import { joinUrl, requestJson, ServiceError } from '../http.js';

// SABnzbd JSON API. Same client interface as qbittorrent.js.
const SERVICE = 'SABnzbd';
const POST_PROCESSING = new Set(['Queued', 'QuickCheck', 'Verifying', 'Repairing', 'Fetching', 'Extracting', 'Moving', 'Running']);

async function api(config, params) {
  const query = new URLSearchParams({ ...params, apikey: config.apiKey || '', output: 'json' });
  const { body } = await requestJson(SERVICE, joinUrl(config.url, '/api?' + query), { timeoutMs: 15000 });
  if (body && body.status === false) throw new ServiceError(SERVICE, body.error || 'request refused');
  return body;
}

export async function add(config, candidate) {
  const params = { mode: 'addurl', name: candidate.downloadUrl, nzbname: candidate.title };
  if (config.category) params.cat = config.category;
  const body = await api(config, params);
  const id = body?.nzo_ids?.[0];
  if (!id) throw new ServiceError(SERVICE, 'did not return a job id');
  return { remoteId: id };
}

export async function status(config, remoteId) {
  const queue = await api(config, { mode: 'queue', nzo_ids: remoteId });
  const slot = queue?.queue?.slots?.find((item) => item.nzo_id === remoteId);
  if (slot) {
    const progress = Math.min(1, (Number(slot.percentage) || 0) / 100);
    return { state: slot.status === 'Downloading' ? 'downloading' : 'queued', progress, path: null };
  }
  const history = await api(config, { mode: 'history', nzo_ids: remoteId });
  const done = history?.history?.slots?.find((item) => item.nzo_id === remoteId);
  if (!done) return null;
  if (done.status === 'Completed') return { state: 'completed', progress: 1, path: done.storage || null };
  if (done.status === 'Failed') return { state: 'failed', progress: 1, path: done.storage || null, error: done.fail_message || 'SABnzbd reports the job failed' };
  // Downloaded; SABnzbd is still verifying, repairing or unpacking it.
  return { state: POST_PROCESSING.has(done.status) ? 'downloading' : 'queued', progress: 1, path: null };
}

export async function testConnection(config) {
  const version = await api(config, { mode: 'version' });
  await api(config, { mode: 'queue', limit: '1' });
  return `SABnzbd ${version?.version || ''}`.trim();
}
