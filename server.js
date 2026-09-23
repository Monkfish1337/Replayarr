import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './src/db.js';
import { createStore } from './src/store.js';
import { createService, startWorker } from './src/service.js';
import { createApi } from './src/api.js';
import * as sss from './src/adapters/sss.js';
import * as prowlarr from './src/adapters/prowlarr.js';
import * as bitmagnet from './src/adapters/bitmagnet.js';
import * as easynews from './src/adapters/easynews.js';
import * as qbittorrent from './src/adapters/qbittorrent.js';
import * as sabnzbd from './src/adapters/sabnzbd.js';

const root = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(root, 'public');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const dataFile = resolve(process.env.REPLAYARR_DB || resolve(root, 'data', 'replayarr.db'));
const credentials = process.env.REPLAYARR_USERNAME && process.env.REPLAYARR_PASSWORD
  ? Buffer.from(`${process.env.REPLAYARR_USERNAME}:${process.env.REPLAYARR_PASSWORD}`)
  : null;

const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const store = createStore(openDatabase(dataFile));
const service = createService(store);
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const api = createApi(service, {
  version,
  databasePath: dataFile,
  testers: {
    sss: async (config) => `SSS ${(await sss.fetchManifest(config)).name || 'addon'} reachable`,
    prowlarr: prowlarr.testConnection,
    bitmagnet: bitmagnet.testConnection,
    easynews: easynews.testConnection,
    qbittorrent: qbittorrent.testConnection,
    sabnzbd: sabnzbd.testConnection,
  },
});

function authorised(request) {
  if (!credentials) return true;
  const [scheme, value] = String(request.headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !value) return false;
  const given = Buffer.from(value, 'base64');
  return given.length === credentials.length && timingSafeEqual(given, credentials);
}

async function serveStatic(request, response, pathname) {
  const file = resolve(publicDir, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname));
  if (request.method !== 'GET' || !file.startsWith(publicDir + sep)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }).end(body);
  } catch {
    response.writeHead(404).end('Not found');
  }
}

createServer(async (request, response) => {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('referrer-policy', 'no-referrer');
  // Liveness only, for container healthchecks; reveals nothing about the install.
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  if (!authorised(request)) {
    response.writeHead(401, { 'www-authenticate': 'Basic realm="Replayarr", charset="UTF-8"' }).end('Authentication required');
    return;
  }
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return api(request, response, url);
  return serveStatic(request, response, url.pathname);
}).listen(port, host, () => {
  console.log(`Replayarr: http://${host === '0.0.0.0' ? 'localhost' : host}:${port} (database ${dataFile})`);
  if (!credentials && host !== '127.0.0.1') console.warn('Replayarr is listening beyond localhost without REPLAYARR_USERNAME/REPLAYARR_PASSWORD.');
});

if (process.env.REPLAYARR_WORKER !== 'off') startWorker(service, Number(process.env.REPLAYARR_TICK_MS) || 30000);
