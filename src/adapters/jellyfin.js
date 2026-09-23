import { joinUrl, requestJson, request, ServiceError } from '../http.js';

// Jellyfin: tell it to rescan its libraries after Replayarr adds or renames
// files, so new events appear without waiting for a scheduled scan.
const SERVICE = 'Jellyfin';

function headers(config) {
  return { 'x-emby-token': config.apiKey || '', accept: 'application/json' };
}

export async function refreshLibrary(config) {
  if (!config.url || !config.apiKey) throw new ServiceError(SERVICE, 'URL and API key are not configured');
  await request(SERVICE, joinUrl(config.url, '/Library/Refresh'), { method: 'POST', headers: headers(config), timeoutMs: 15000 });
}

export async function testConnection(config) {
  if (!config.url || !config.apiKey) throw new ServiceError(SERVICE, 'URL and API key are not configured');
  const { body } = await requestJson(SERVICE, joinUrl(config.url, '/System/Info'), { headers: headers(config), timeoutMs: 10000 });
  return `Jellyfin ${body.Version || ''} (${body.ServerName || 'server'})`.trim();
}
