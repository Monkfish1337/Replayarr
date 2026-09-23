import { joinUrl, request, ServiceError } from '../http.js';

// qBittorrent WebUI API v2, authenticated by API key (qBittorrent 5.2+) or
// by username and password. Download clients share one interface:
//   add(config, candidate, { tag }) -> { remoteId }
//   status(config, remoteId)        -> { state, progress, path, error } | null
// where state is queued | downloading | completed | failed.
const SERVICE = 'qBittorrent';
const sessions = new Map();

const COMPLETE = new Set(['uploading', 'stalledUP', 'pausedUP', 'stoppedUP', 'queuedUP', 'forcedUP', 'checkingUP']);
const WAITING = new Set(['metaDL', 'forcedMetaDL', 'queuedDL', 'allocating', 'checkingDL', 'checkingResumeData', 'moving']);

async function login(config) {
  const base = String(config.url || '').replace(/\/+$/, '');
  const { response, text } = await request(SERVICE, joinUrl(base, '/api/v2/auth/login'), {
    method: 'POST',
    // qBittorrent rejects API calls whose Referer/Origin is not its own host.
    headers: { 'content-type': 'application/x-www-form-urlencoded', Referer: base, Origin: base },
    body: new URLSearchParams({ username: config.username || '', password: config.password || '' }),
    timeoutMs: 10000,
  });
  if (text.trim() !== 'Ok.') throw new ServiceError(SERVICE, 'login rejected; check the username and password');
  const cookie = (response.headers.getSetCookie?.() || [response.headers.get('set-cookie') || ''])
    .map((value) => value.split(';')[0]).find((value) => /^(?:SID|QBT_SID_\d+)=/.test(value));
  sessions.set(base, cookie || '');
  return cookie || '';
}

async function call(config, path, init = {}, retried = false) {
  const base = String(config.url || '').replace(/\/+$/, '');
  // qBittorrent 5.2+ API keys are stateless: no login and no session cookie.
  if (config.apiKey) {
    try {
      return await request(SERVICE, joinUrl(base, path), {
        ...init,
        headers: { ...(init.headers || {}), Referer: base, Origin: base, Authorization: `Bearer ${config.apiKey}` },
        timeoutMs: 15000,
      });
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        throw new ServiceError(SERVICE, 'API key rejected (API keys need qBittorrent 5.2 or newer)', error.status);
      }
      throw error;
    }
  }
  if (!sessions.has(base)) await login(config);
  try {
    return await request(SERVICE, joinUrl(base, path), {
      ...init,
      headers: { ...(init.headers || {}), Referer: base, Origin: base, Cookie: sessions.get(base) || '' },
      timeoutMs: 15000,
    });
  } catch (error) {
    if (error.status === 403 && !retried) {
      sessions.delete(base);
      return call(config, path, init, true);
    }
    throw error;
  }
}

export async function add(config, candidate, { tag }) {
  const form = new URLSearchParams({ urls: candidate.downloadUrl, tags: tag });
  if (config.category) form.set('category', config.category);
  const { text } = await call(config, '/api/v2/torrents/add', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  if (/^Fails\./.test(text.trim())) throw new ServiceError(SERVICE, 'refused the torrent');
  // A known hash is the stable identity. Without one (a .torrent URL behind
  // Prowlarr's proxy), the per-job tag finds it again.
  return { remoteId: candidate.infoHash ? `hash:${candidate.infoHash}` : `tag:${tag}` };
}

export async function status(config, remoteId) {
  const [kind, value] = String(remoteId).split(/:(.*)/s);
  const params = kind === 'hash' ? `hashes=${encodeURIComponent(value)}` : `tag=${encodeURIComponent(value)}`;
  const { text } = await call(config, `/api/v2/torrents/info?${params}`);
  const torrent = JSON.parse(text)[0];
  if (!torrent) return null;
  const path = torrent.content_path || torrent.save_path || null;
  if (torrent.state === 'error' || torrent.state === 'missingFiles') {
    return { state: 'failed', progress: torrent.progress, path, error: `qBittorrent reports ${torrent.state}` };
  }
  if (torrent.progress >= 1 || COMPLETE.has(torrent.state)) return { state: 'completed', progress: 1, path };
  return { state: WAITING.has(torrent.state) ? 'queued' : 'downloading', progress: torrent.progress || 0, path };
}

export async function testConnection(config) {
  const base = String(config.url || '').replace(/\/+$/, '');
  sessions.delete(base);
  const { text } = await call(config, '/api/v2/app/version');
  return `qBittorrent ${text.trim()}`;
}
