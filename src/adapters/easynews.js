import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { requestJson, ServiceError } from '../http.js';
import { logger } from '../logger.js';

const log = logger('easynews');

// Easynews search, ported from SSS lib/sources/easynews.js, plus a built-in
// downloader. Easynews serves each result as a single already-decoded file
// over HTTPS, so neither qBittorrent nor SABnzbd can take it; Replayarr
// fetches it into the configured download folder and imports it from there.
//
// Credentials never leave the server: candidates carry only a token naming
// the file, and the Authorization header is added when downloading.
const SERVICE = 'Easynews';
const BASE_URL = 'https://members.easynews.com';
const SEARCH_PATH = '/2.0/search/solr-search/advanced';
const VIDEO_EXTS = 'm4v,3gp,mov,divx,xvid,wmv,avi,mpg,mpeg,mp4,mkv,avc,flv,webm';
const MAX_ACTIVE = 2;
const IDLE_TIMEOUT_MS = 60000;
const MAX_ATTEMPTS = 3;

const basicAuth = (config) => 'Basic ' + Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64');

// --- search -------------------------------------------------------------
export function normalise(file, context = {}) {
  if (!file || typeof file !== 'object' || file.passwd || file.virus) return null;
  if (String(file.type || '').toUpperCase() !== 'VIDEO') return null;
  // Easynews indexes thumbnail strips as short "videos".
  const duration = String(file['14'] || '');
  if (/^\d+s$/.test(duration) || /^[0-5]m/.test(duration)) return null;
  const postHash = String(file['0'] || '');
  const title = String(file['10'] || '');
  if (!postHash || !title) return null;
  const ext = String(file['11'] || file['2'] || '');
  const token = packToken({ h: postHash, t: title, e: ext, f: context.dlFarm || '', p: Number(context.dlPort) || 0, u: context.downURL || '' });
  return {
    identity: `easynews:${postHash}`,
    indexer: 'Easynews',
    protocol: 'easynews',
    title,
    downloadUrl: `easynews:${token}`,
    infoHash: null,
    size: Number(file.rawSize) || null,
    seeders: null,
    publishedAt: file['5'] ? new Date(file['5']).toISOString() : null,
  };
}

async function searchPage(config, query, perPage) {
  const params = new URLSearchParams({
    st: 'adv', sb: '1', fex: VIDEO_EXTS, 'fty[]': 'VIDEO', spamf: '1', u: '1', gx: '1', pno: '1', sS: '3',
    s1: 'dsize', s1d: '-', s2: 'relevance', s2d: '-', s3: 'dtime', s3d: '-',
    pby: String(perPage), safeO: '0', gps: query,
  });
  try {
    // Tests point this at a local stand-in; it is deliberately not a setting,
    // so saved configuration can never send the credentials elsewhere.
    const base = process.env.REPLAYARR_EASYNEWS_BASE_URL || BASE_URL;
    const { body } = await requestJson(SERVICE, `${base}${SEARCH_PATH}?${params}`, {
      headers: { authorization: basicAuth(config), accept: 'application/json' },
      timeoutMs: config.timeoutMs,
    });
    return body;
  } catch (error) {
    if (error.status === 401 || error.status === 403) throw new ServiceError(SERVICE, 'username or password rejected', error.status);
    throw error;
  }
}

export async function search(config, query) {
  if (!config.username || !config.password) throw new ServiceError(SERVICE, 'username and password are not configured');
  const body = await searchPage(config, query, 100);
  const context = { dlFarm: body?.dlFarm, dlPort: body?.dlPort, downURL: body?.downURL };
  const results = (Array.isArray(body?.data) ? body.data : []).map((file) => normalise(file, context)).filter(Boolean);
  log.debug(`Search "${query}": ${results.length} usable of ${Array.isArray(body?.data) ? body.data.length : 0} file(s)`, { ...context, downloadBase: downloadBase(context.downURL) });
  return results;
}

export async function testConnection(config) {
  if (!config.username || !config.password) throw new ServiceError(SERVICE, 'username and password are not configured');
  await searchPage(config, 'test', 1);
  if (!config.downloadFolder) return 'Easynews account works; set a download folder before grabbing';
  await mkdir(config.downloadFolder, { recursive: true });
  return 'Easynews account works';
}

// --- tokens and URLs ----------------------------------------------------
export function packToken(fields) {
  return Buffer.from(JSON.stringify(fields), 'utf8').toString('base64url');
}

export function unpackToken(token) {
  try {
    const value = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'));
    return value?.h ? value : null;
  } catch {
    return null;
  }
}

const isEasynewsHost = (host) => /(^|\.)easynews\.com(:\d+)?$/i.test(host);

// The download host comes from Easynews's search response (per-account
// affinity). Only an easynews.com host is accepted, because the account's
// credentials are sent to it.
//
// The download base is used as given, path included: Easynews returns e.g.
// "https://members.easynews.com/dl" (sometimes protocol-relative), and the
// file lives at <base>/<farm>/<port>/<hash><ext>/<title><ext>. Only its host
// is checked; dropping the "/dl" path makes every download a 404.
const DEFAULT_DOWNLOAD_BASE = 'https://members.easynews.com/dl';

export function downloadBase(downURL) {
  let value = String(downURL || '').trim();
  if (!value) return DEFAULT_DOWNLOAD_BASE;
  if (value.startsWith('//')) value = `https:${value}`;
  else if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let url;
  try { url = new URL(value); } catch { return DEFAULT_DOWNLOAD_BASE; }
  if (!isEasynewsHost(url.host)) return DEFAULT_DOWNLOAD_BASE;
  return `https://${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

export function fileUrl(file) {
  const path = `/${encodeURIComponent(file.f || 'auto')}/${Number(file.p) || 443}/${encodeURIComponent(file.h)}${file.e || ''}/${encodeURIComponent(file.t || file.h)}${file.e || ''}`;
  const override = process.env.REPLAYARR_EASYNEWS_BASE_URL;
  if (override) return override.replace(/\/+$/, '') + path;
  return downloadBase(file.u) + path;
}

// Credentials go only to Easynews hosts, and are re-attached by hand on each
// redirect hop (fetch drops Authorization on a cross-origin redirect).
async function openDownload(config, url, offset, signal) {
  const override = process.env.REPLAYARR_EASYNEWS_BASE_URL;
  const trusted = (host) => isEasynewsHost(host) || (override && host === new URL(override).host);
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    const headers = {};
    if (trusted(new URL(current).host)) headers.authorization = basicAuth(config);
    if (offset) headers.range = `bytes=${offset}-`;
    const response = await fetch(current, { headers, redirect: 'manual', signal });
    log.debug(`GET ${current} -> ${response.status}`, { range: headers.range, authenticated: !!headers.authorization });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      current = new URL(response.headers.get('location'), current).toString();
      log.debug(`Redirected to ${current}`);
      continue;
    }
    return response;
  }
  throw new ServiceError(SERVICE, 'too many redirects');
}

// --- downloader ---------------------------------------------------------
// Active and finished downloads in this process. After a restart the map is
// empty; status() then resumes from the partial file on disk.
const jobs = new Map();
const waiting = [];
let active = 0;

const safeName = (value) => String(value || 'download').replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) || 'download';

function paths(config, folderName, file) {
  const folder = join(config.downloadFolder, folderName);
  const final = join(folder, safeName(file.t) + (file.e || ''));
  return { folder, final, partial: final + '.part' };
}

function parseRemoteId(remoteId) {
  const [indexerId, folderName, token] = String(remoteId).split('|');
  return { indexerId, folderName, file: unpackToken(token) };
}

function schedule(config, remoteId) {
  const job = jobs.get(remoteId);
  if (job.state !== 'queued') return;
  if (active >= MAX_ACTIVE) {
    if (!waiting.includes(remoteId)) waiting.push(remoteId);
    return;
  }
  active += 1;
  job.state = 'downloading';
  run(config, remoteId).finally(() => {
    active -= 1;
    const nextId = waiting.shift();
    if (nextId && jobs.get(nextId)) schedule(jobs.get(nextId).config, nextId);
  });
}

async function run(config, remoteId) {
  const job = jobs.get(remoteId);
  const { folderName, file } = parseRemoteId(remoteId);
  const target = paths(config, folderName, file);
  await mkdir(target.folder, { recursive: true });
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    let idle = setTimeout(() => controller.abort(new Error('stalled')), IDLE_TIMEOUT_MS);
    try {
      let offset = (await stat(target.partial).catch(() => null))?.size || 0;
      log.info(`${offset ? 'Resuming' : 'Downloading'} ${file.t}${file.e || ''}`, { url: fileUrl(file), attempt, offset: offset || undefined, folder: target.folder });
      const response = await openDownload(config, fileUrl(file), offset, controller.signal);
      if (response.status === 401 || response.status === 403) throw Object.assign(new Error('Easynews rejected the username or password'), { fatal: true });
      // Name the address that failed (it carries no credentials), so a file
      // Easynews really removed can be told apart from a wrong URL.
      if (response.status === 404 || response.status === 410) throw Object.assign(new Error(`Easynews returned HTTP ${response.status} for ${fileUrl(file)}; the post may have been removed`), { fatal: true });
      if (response.status === 416) offset = 0;
      if (!response.ok) throw new Error(`Easynews HTTP ${response.status}`);
      // A server that ignores Range sends the whole file again.
      if (offset && response.status !== 206) { await truncate(target.partial, 0); offset = 0; }
      const length = Number(response.headers.get('content-length')) || 0;
      job.total = length ? offset + length : null;
      job.received = offset;
      const body = Readable.fromWeb(response.body);
      body.on('data', (chunk) => {
        job.received += chunk.length;
        clearTimeout(idle);
        idle = setTimeout(() => controller.abort(new Error('stalled')), IDLE_TIMEOUT_MS);
      });
      await pipeline(body, createWriteStream(target.partial, { flags: offset ? 'a' : 'w' }));
      clearTimeout(idle);
      if (job.total && job.received < job.total) throw new Error('connection closed early');
      await rename(target.partial, target.final);
      log.info(`Finished ${file.t}${file.e || ''}`, { bytes: job.received, path: target.final });
      Object.assign(job, { state: 'completed', path: target.folder, error: null });
      return;
    } catch (error) {
      clearTimeout(idle);
      job.error = error.message || String(error);
      log.warn(`${file.t}${file.e || ''}: ${job.error}`, { attempt, of: MAX_ATTEMPTS, giveUp: !!error.fatal || attempt === MAX_ATTEMPTS, received: job.received });
      if (error.fatal || attempt === MAX_ATTEMPTS) {
        Object.assign(job, { state: 'failed', path: target.folder });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
    }
  }
}

export async function add(config, candidate, { tag }) {
  if (!config.downloadFolder) throw new ServiceError(SERVICE, 'set a download folder for Easynews under Settings › Indexers');
  const token = String(candidate.downloadUrl || '').replace(/^easynews:/, '');
  if (!unpackToken(token)) throw new ServiceError(SERVICE, 'this result cannot be downloaded; search again');
  await mkdir(config.downloadFolder, { recursive: true });
  const remoteId = `${config.id}|${tag}|${token}`;
  if (!jobs.has(remoteId)) {
    jobs.set(remoteId, { config, state: 'queued', received: 0, total: null, path: null, error: null });
    schedule(config, remoteId);
  }
  return { remoteId };
}

export async function status(config, remoteId) {
  let job = jobs.get(remoteId);
  if (!job) {
    const { folderName, file } = parseRemoteId(remoteId);
    if (!file) return { state: 'failed', progress: 0, path: null, error: 'Unreadable Easynews job' };
    const target = paths(config, folderName, file);
    if (await stat(target.final).catch(() => null)) return { state: 'completed', progress: 1, path: target.folder };
    // Restarted mid-download: pick up from the partial file.
    jobs.set(remoteId, { config, state: 'queued', received: 0, total: null, path: null, error: null });
    schedule(config, remoteId);
    job = jobs.get(remoteId);
  }
  job.config = config;
  const progress = job.state === 'completed' ? 1 : job.total ? Math.min(0.999, job.received / job.total) : 0;
  return { state: job.state, progress, path: job.path, error: job.state === 'failed' ? job.error : undefined };
}
