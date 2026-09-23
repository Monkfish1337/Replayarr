import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, timingSafeEqual } from 'node:crypto';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './src/db.js';
import { createStore } from './src/store.js';
import { createService, startWorker } from './src/service.js';
import { createApi } from './src/api.js';
import * as prowlarr from './src/adapters/prowlarr.js';
import * as bitmagnet from './src/adapters/bitmagnet.js';
import * as easynews from './src/adapters/easynews.js';
import * as qbittorrent from './src/adapters/qbittorrent.js';
import * as sabnzbd from './src/adapters/sabnzbd.js';
import * as jellyfin from './src/adapters/jellyfin.js';
import { configureLogging, logger } from './src/logger.js';
import { loadSettings } from './src/settings.js';

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
// Log files sit beside the database (in Docker: /config/logs); every line is
// also printed, so `docker logs` and Dozzle show them.
configureLogging({ console: true, dir: resolve(dirname(dataFile), 'logs'), level: loadSettings(store).logging.level });
const log = logger('system');
// Uploaded promotion logos live beside the database.
const logoDir = resolve(dirname(dataFile), 'logos');
const service = createService(store, { logoDir });
const { version } = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
// Changes whenever the served UI changes, so an open tab can tell it is stale.
const uiBuild = createHash('sha256')
  .update(await readFile(resolve(publicDir, 'app.js'))).update(await readFile(resolve(publicDir, 'styles.css'))).update(await readFile(resolve(publicDir, 'index.html')))
  .digest('hex').slice(0, 12);
const revision = (process.env.REPLAYARR_REVISION || '').slice(0, 7);
const api = createApi(service, {
  version,
  revision,
  uiBuild,
  databasePath: dataFile,
  testers: {
    prowlarr: prowlarr.testConnection,
    bitmagnet: bitmagnet.testConnection,
    easynews: easynews.testConnection,
    qbittorrent: qbittorrent.testConnection,
    sabnzbd: sabnzbd.testConnection,
    jellyfin: jellyfin.testConnection,
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

const LOGO_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', gif: 'image/gif' };
async function serveLogo(response, name) {
  const match = /^([a-z0-9-]+)\.(png|jpg|webp|svg|gif)$/.exec(name);
  if (!match) return response.writeHead(404).end();
  try {
    const body = await readFile(resolve(logoDir, name));
    // An uploaded SVG opened directly must not run script in this origin.
    response.writeHead(200, {
      'content-type': LOGO_TYPES[match[2]], 'cache-control': 'no-cache',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    }).end(body);
  } catch {
    response.writeHead(404).end();
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
  if (url.pathname.startsWith('/logos/')) return serveLogo(response, url.pathname.slice('/logos/'.length));
  return serveStatic(request, response, url.pathname);
}).listen(port, host, () => {
  log.info(`Replayarr ${version}${revision ? ` (${revision})` : ''} listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`, { database: dataFile, logLevel: loadSettings(store).logging.level });
  if (!credentials && host !== '127.0.0.1') log.warn('Listening beyond localhost without REPLAYARR_USERNAME/REPLAYARR_PASSWORD.');
});

if (process.env.REPLAYARR_WORKER !== 'off') startWorker(service, Number(process.env.REPLAYARR_TICK_MS) || 30000);
