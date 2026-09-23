import * as prowlarrAdapter from './adapters/prowlarr.js';
import * as qbittorrentAdapter from './adapters/qbittorrent.js';
import * as sabnzbdAdapter from './adapters/sabnzbd.js';
import * as bitmagnetAdapter from './adapters/bitmagnet.js';
import * as easynewsAdapter from './adapters/easynews.js';
import * as jellyfinAdapter from './adapters/jellyfin.js';
import { mkdir, rename as renameFile, stat } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { episodeNumber, moveSidecars, pruneEmptyFolders, writeMediaFiles } from './mediaFiles.js';
import { broadQueries, configurePromotions, evaluate, promotionFor, promotions, queriesFor } from './matching/index.js';
import { destinationFor, ImportError, importDownload } from './importer.js';
import { scoreCandidate } from './scoring.js';
import { indexerReady, loadSettings, mapRemotePath } from './settings.js';
import { createMetadata } from './metadata/manager.js';
import { logger } from './logger.js';

const searchLog = logger('search');
const downloadLog = logger('download');
const importLog = logger('import');
const workerLog = logger('worker');

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const MINUTE = 60000;
// Wait after a search that found nothing: releases for a fixture usually
// appear within hours, and the indexers should not be asked every minute.
const BACKOFF_MINUTES = [30, 120, 360, 720, 1440];
const MISSING_JOB_GRACE_MS = 10 * MINUTE;
const MAX_REJECTED_KEPT = 60;

// Easynews results are direct HTTPS files, fetched by the built-in downloader
// in adapters/easynews.js using the credentials of the indexer that found them.
const CLIENT_FOR = { torrent: 'qbittorrent', usenet: 'sabnzbd', easynews: 'easynews' };
const CLIENT_NAMES = { qbittorrent: 'qBittorrent', sabnzbd: 'SABnzbd', easynews: 'Easynews' };
// Easynews asks for a pause between queries; the others take them back to back.
const QUERY_PAUSE_MS = { easynews: 800 };

// Lowest priority number first, as in Sonarr; ties keep the settings order.
export function byPriority(indexers) {
  return indexers.map((indexer, index) => ({ indexer, index }))
    .sort((a, b) => a.indexer.priority - b.indexer.priority || a.index - b.index)
    .map(({ indexer }) => indexer);
}

export function createService(store, overrides = {}) {
  const adapters = {
    prowlarr: prowlarrAdapter, bitmagnet: bitmagnetAdapter, easynews: easynewsAdapter,
    qbittorrent: qbittorrentAdapter, sabnzbd: sabnzbdAdapter, jellyfin: jellyfinAdapter,
    ...overrides.adapters,
  };
  const clock = overrides.now || (() => new Date());
  const metadata = overrides.metadata || createMetadata(store, {
    settings: () => loadSettings(store), logoDir: overrides.logoDir || 'data/logos', clock,
    ...(overrides.fetchEvents ? { fetchEvents: overrides.fetchEvents } : {}),
  });
  const iso = (offsetMs = 0) => new Date(clock().getTime() + offsetMs).toISOString();

  configurePromotions(store);

  function requireRequest(id) {
    const request = store.getRequest(Number(id));
    if (!request) throw new UserError('Request not found.', 404);
    return request;
  }

  function promotionName(event) {
    return promotionFor(event)?.name || 'Sports';
  }

  // --- media-server files -------------------------------------------------
  const logoDir = overrides.logoDir || 'data/logos';

  function numberFor(event) {
    const sameDay = event.promotionId ? store.eventsOnDate(event.promotionId, event.date) : [];
    return episodeNumber(event, sameDay.length ? sameDay : [event]);
  }

  // The promotion as the media-server files need it: name and chosen logo.
  function promotionInfo(event) {
    const promotion = promotionFor(event);
    const listed = promotion && metadata.list().find((p) => p.id === promotion.id);
    return { id: promotion?.id || 'sports', name: promotion?.name || 'Sports', logo: listed?.logo || '', defaultLogo: listed?.defaultLogo || '' };
  }

  // .nfo and artwork for Jellyfin. Best effort: problems are logged, the
  // import itself has already succeeded.
  async function writeSidecars(event, item, settings, { overwrite = false } = {}) {
    if (settings.library.writeMetadata === 'no' || !item) return;
    try {
      const problems = await writeMediaFiles({
        videoPath: item.path, libraryRoot: settings.library.root, event, promotion: promotionInfo(event),
        season: item.season, episode: item.episode, quality: item.quality, logoDir, overwrite,
        fetchImpl: overrides.fetchImage,
      });
      if (problems.length) store.log('warning', `${event.title}: some artwork was not saved (${problems.join('; ')})`);
    } catch (error) {
      store.log('warning', `${event.title}: could not write media-server files: ${error.code || error.message}`);
    }
  }

  // Ask Jellyfin to rescan, at most once per burst of imports or renames.
  let refreshTimer = null;
  function notifyMediaServer(settings) {
    if (!settings.jellyfin.url || !settings.jellyfin.apiKey) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      adapters.jellyfin.refreshLibrary(loadSettings(store).jellyfin)
        .then(() => store.log('metadata', 'Asked Jellyfin to rescan its libraries'))
        .catch((error) => store.log('warning', `Jellyfin rescan failed: ${error.message}`));
    }, overrides.mediaServerDelayMs ?? 10000);
    refreshTimer.unref?.();
  }

  function clientConfigured(settings, client, sourceId) {
    if (client === 'easynews') return !!clientConfig(settings, client, sourceId)?.downloadFolder;
    const config = settings[client];
    return client === 'qbittorrent' ? !!config.url : !!(config.url && config.apiKey);
  }

  // The settings a download client runs with. Easynews downloads use the
  // Easynews indexer they came from; its id is the first part of a job's
  // remote id.
  function clientConfig(settings, client, sourceId) {
    if (client !== 'easynews') return settings[client];
    return settings.indexers.find((i) => i.type === 'easynews' && i.id === sourceId) || null;
  }

  // Send queries to one indexer, collecting new releases into `found` (keyed
  // by info hash or guid, first indexer wins). Returns false when the indexer
  // is unusable (bad key, unreachable), in which case the rest are skipped.
  // With `stopAtMatch`, stops as soon as this indexer has returned a release
  // that matches `event`; with `deadline`, stops when its time is up.
  async function runQueries(indexer, queries, attempt, found, { event = null, deadline = 0, stopAtMatch = false } = {}) {
    for (const [index, query] of queries.entries()) {
      if (index && stopAtMatch && attempt.matched) {
        searchLog.info(`${indexer.name}: found a match after ${index} of ${queries.length} queries; skipping the rest`);
        break;
      }
      if (index && deadline && Date.now() >= deadline) {
        searchLog.info(`${indexer.name}: out of time after ${index} of ${queries.length} queries (${indexer.searchMinutes} min budget)`);
        attempt.partial = true;
        break;
      }
      if (index && QUERY_PAUSE_MS[indexer.type]) await new Promise((r) => setTimeout(r, QUERY_PAUSE_MS[indexer.type]));
      try {
        attempt.queries.push(query);
        const results = await adapters[indexer.type].search(indexer, query);
        searchLog.debug(`${indexer.name}: "${query}" returned ${results.length} result(s)`);
        for (const result of results) {
          attempt.results += 1;
          if (found.has(result.identity)) continue;
          const tagged = { ...result, source: indexer.name, sourceId: indexer.id };
          found.set(result.identity, tagged);
          attempt.found.push(tagged);
          if (event && !attempt.matched && evaluate(tagged.title, event).ok) attempt.matched = true;
        }
      } catch (error) {
        attempt.error ||= error.message;
        searchLog.warn(`${indexer.name}: "${query}" failed: ${error.message}`);
        // A configuration problem, or an indexer that cannot be reached at
        // all, fails every query the same way; skip the rest.
        if (/not configured|rejected|HTTP 401|HTTP 403|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|EAI_AGAIN/.test(error.message)) {
          searchLog.warn(`${indexer.name}: skipping its remaining queries this search`);
          return false;
        }
      }
    }
    return true;
  }

  // Match and score releases found for an event, the same way for every kind
  // of search.
  function judge(event, releases, settings) {
    return releases.map((result) => {
      const verdict = evaluate(result.title, event);
      const { score, quality, evidence } = scoreCandidate(result, {
        verdict, preferences: settings.preferences, minSizeMb: settings.library.minSizeMb,
      });
      if (verdict.ok && !clientConfigured(settings, CLIENT_FOR[result.protocol], result.sourceId)) {
        evidence.push(`No ${CLIENT_NAMES[CLIENT_FOR[result.protocol]]} connection configured`);
      }
      return { ...result, score, quality, evidence, decision: verdict.ok ? 'matched' : 'rejected', reason: verdict.ok ? null : `${verdict.stage}: ${verdict.reason}` };
    });
  }

  // Searching before an event has finished only returns older fixtures.
  function firstSearchAt(event) {
    const start = Date.parse(`${event.date}T${event.time || '00:00'}:00Z`);
    const earliest = Number.isFinite(start) ? start + 3 * 60 * MINUTE : 0;
    return new Date(Math.max(clock().getTime(), earliest)).toISOString();
  }

  const service = {
    store,

    settings: () => loadSettings(store),

    reloadPromotions() {
      configurePromotions(store);
    },

    // --- metadata -------------------------------------------------------
    metadata,

    // Refresh followed promotions in the background; progress via metadata.status().
    syncEvents(ids) {
      return metadata.refresh(ids);
    },

    addManualEvent({ promotionId, title, date, time, aliases }) {
      const promotion = promotions.getById(String(promotionId || ''));
      if (!promotion) throw new UserError('Choose a promotion for this event.');
      if (!String(title || '').trim()) throw new UserError('Enter the event name.');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new UserError('Enter the date as YYYY-MM-DD.');
      if (time && !/^\d{2}:\d{2}$/.test(String(time))) throw new UserError('Enter the start time as HH:MM (UTC).');
      const slug = `${date}-${String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`.slice(0, 80);
      return store.upsertEvent({
        id: `${promotion.idPrefix}:manual-${slug}`,
        promotionId: promotion.id,
        title: String(title).trim(),
        date,
        time: time || null,
        aliases: (Array.isArray(aliases) ? aliases : String(aliases || '').split('\n')).map((a) => String(a).trim()).filter(Boolean),
        source: 'manual',
      });
    },

    // --- requests -------------------------------------------------------
    async requestEvent(eventId) {
      const event = store.getEvent(String(eventId || ''));
      if (!event) throw new UserError('Event not found.', 404);
      const owned = store.libraryFor(event.id);
      if (owned) throw new UserError('This event is already in your library.', 409);
      const { request, created } = store.createRequest(event.id);
      if (!created) return request;
      store.setStatus(request.id, 'wanted', { nextSearchAt: firstSearchAt(event) });
      store.log('request', `${event.title} added to requests`, request.id);
      return store.getRequest(request.id);
    },

    async searchRequest(id) {
      let request = requireRequest(id);
      if (request.status === 'review') request = store.setStatus(request.id, 'wanted');
      if (request.status !== 'wanted') throw new UserError(`A ${request.status} request cannot be searched.`, 409);
      const event = store.getEvent(request.eventId);
      const settings = loadSettings(store);
      request = store.setStatus(request.id, 'searching', { searchCount: request.searchCount + 1 });
      // Events saved before Replayarr kept the provider's full record (or by
      // the old SSS sync) have no team names or codes, so the queries built
      // from them ("MUN SAB", "Sabah Man Utd ...") are missing. Refreshing the
      // promotion replaces the record; the next search uses it.
      if (!event.payload && event.source !== 'manual' && event.promotionId) {
        searchLog.warn(`${event.title} has no stored metadata (team names, codes), so some searches are missing; refreshing ${promotionName(event)} metadata`);
        metadata.refresh([event.promotionId]);
      }

      const indexers = byPriority(settings.indexers.filter(indexerReady));
      const stopAtFirstMatch = settings.preferences.stopAtFirstMatch !== 'no';
      const found = new Map();
      const errors = [];
      const attempts = [];
      if (!indexers.length) errors.push('No indexer is configured; add one under Settings › Indexers');
      // Indexers are asked in priority order (fast ones first by default).
      // Each gets the queries SSS would send it, stopping at its first match
      // or when its time is up; once one has a match, the slower ones after
      // it are not asked. The first indexer to report a release (by info
      // hash or indexer guid) keeps it.
      searchLog.info(`Searching for ${event.title} (${event.date}) on ${indexers.length} indexer(s)`, { request: request.id, event: event.id, attempt: request.searchCount, order: indexers.map((i) => `${i.name} (${i.priority})`).join(', ') });
      for (const indexer of indexers) {
        if (stopAtFirstMatch && attempts.some((a) => a.matched)) {
          searchLog.info(`${indexer.name}: skipped, a higher-priority indexer already found a match`);
          continue;
        }
        const queries = queriesFor(event, indexer.type, indexer.maxQueries);
        const attempt = { source: indexer.name, queries: [], started: Date.now(), results: 0, error: null, found: [], matched: false };
        const deadline = attempt.started + indexer.searchMinutes * MINUTE;
        const reachable = await runQueries(indexer, queries, attempt, found, { event, deadline, stopAtMatch: stopAtFirstMatch });
        // Last resort when the whole list found nothing: just the two teams,
        // and let the matcher sort out the rest.
        if (reachable && attempt.results === 0 && !attempt.partial) {
          const broad = broadQueries(event, attempt.queries);
          if (broad.length) {
            searchLog.info(`${indexer.name}: nothing for ${attempt.queries.length} queries; trying broad ones`, { queries: broad.join(' | ') });
            await runQueries(indexer, broad, attempt, found, { event, deadline: deadline + MINUTE, stopAtMatch: stopAtFirstMatch });
          }
        }
        searchLog.info(`${indexer.name}: ${attempt.results} result(s), ${attempt.found.length} new, from ${attempt.queries.length} quer${attempt.queries.length === 1 ? 'y' : 'ies'}`, { ms: Date.now() - attempt.started, error: attempt.error });
        if (attempt.error) errors.push(attempt.error);
        attempts.push(attempt);
      }

      const scored = judge(event, [...found.values()], settings);
      // Every verdict, so "why wasn't X picked up?" can be answered from the log.
      for (const candidate of scored) {
        searchLog.debug(`${candidate.decision === 'matched' ? 'Matched' : 'Rejected'} ${candidate.title}`, {
          source: candidate.source, indexer: candidate.indexer, reason: candidate.reason, score: candidate.decision === 'matched' ? candidate.score : undefined,
        });
      }
      const matched = scored.filter((c) => c.decision === 'matched');
      const rejected = scored.filter((c) => c.decision === 'rejected').slice(0, MAX_REJECTED_KEPT);
      searchLog.info(`${event.title}: ${matched.length} matched, ${scored.length - matched.length} rejected of ${found.size} unique result(s)`);
      store.saveCandidates(request.id, [...matched, ...rejected]);
      const matchedIds = new Set(matched.map((c) => c.identity));
      for (const attempt of attempts) {
        store.recordSearch({
          requestId: request.id, source: attempt.source, queries: attempt.queries, resultCount: attempt.results,
          matchedCount: attempt.found.filter((c) => matchedIds.has(c.identity)).length,
          durationMs: Date.now() - attempt.started, error: attempt.error,
        });
      }
      if (!attempts.length) {
        store.recordSearch({ requestId: request.id, source: 'None', queries: [], resultCount: 0, matchedCount: 0, durationMs: 0, error: errors[0] });
      }

      const everyQueryFailed = errors.length > 0 && found.size === 0;
      if (matched.length || store.listCandidates(request.id).some((c) => c.decision === 'matched')) {
        store.log('match', `${matched.length} matching release${matched.length === 1 ? '' : 's'} for ${event.title}`, request.id);
        return store.setStatus(request.id, 'review');
      }
      const delay = BACKOFF_MINUTES[Math.min(request.searchCount - 1, BACKOFF_MINUTES.length - 1)] * MINUTE;
      const message = everyQueryFailed
        ? `Search failed: ${errors[0]}`
        : `No matching release yet (${found.size} checked)`;
      store.log(everyQueryFailed ? 'warning' : 'search', `${event.title}: ${message}`, request.id);
      return store.setStatus(request.id, 'wanted', { nextSearchAt: iso(delay), error: message });
    },

    // Send a release to its download client. `override` sends one the matcher
    // rejected: the operator has looked at it and says it is the event.
    async approve(requestId, candidateId, { override = false } = {}) {
      let request = requireRequest(requestId);
      if (!['review', 'failed', 'wanted'].includes(request.status)) throw new UserError(`A ${request.status} request cannot take a new release.`, 409);
      const candidate = store.getCandidate(Number(candidateId));
      if (!candidate || candidate.requestId !== request.id) throw new UserError('That release does not belong to this request.', 404);
      if (candidate.decision !== 'matched' && !override) throw new UserError('Only a release that matched this event can be sent; use Grab anyway to override.');
      if (candidate.decision !== 'matched') downloadLog.warn(`Grabbing ${candidate.title} despite the matcher (${candidate.reason})`, { request: request.id });
      // A still-wanted request (e.g. after a manual search) moves through review first.
      if (request.status === 'wanted') {
        store.setStatus(request.id, 'searching');
        request = store.setStatus(request.id, 'review');
      }
      const settings = loadSettings(store);
      const client = CLIENT_FOR[candidate.protocol];
      if (client === 'easynews' && !clientConfig(settings, client, candidate.sourceId)) {
        throw new UserError('The Easynews indexer that found this release has been removed; search again.');
      }
      if (!clientConfigured(settings, client, candidate.sourceId)) {
        throw new UserError(client === 'easynews'
          ? 'Set a download folder for Easynews under Settings › Indexers first.'
          : `Connect ${CLIENT_NAMES[client]} in Settings first.`);
      }
      const event = store.getEvent(request.eventId);
      if (request.status === 'failed') store.setStatus(request.id, 'review');

      const job = store.createJob({ requestId: request.id, candidateId: candidate.id, client, state: 'submitting' });
      downloadLog.info(`Sending ${candidate.title} to ${CLIENT_NAMES[client]}`, { event: event.title, job: job.id, source: candidate.source, indexer: candidate.indexer, size: candidate.size });
      try {
        const { remoteId } = await adapters[client].add(clientConfig(settings, client, candidate.sourceId), candidate, { tag: `replayarr-${job.id}` });
        store.updateJob(job.id, { remoteId, state: 'queued' });
        downloadLog.info(`${CLIENT_NAMES[client]} accepted job ${job.id}`, { remoteId: String(remoteId).slice(0, 80) });
      } catch (error) {
        downloadLog.warn(`${CLIENT_NAMES[client]} refused ${candidate.title}: ${error.message}`, { job: job.id });
        store.updateJob(job.id, { state: 'failed', error: error.message });
        store.setStatus(request.id, 'review', { error: error.message });
        store.log('warning', `${event.title}: could not send to ${CLIENT_NAMES[client]}: ${error.message}`, request.id);
        throw new UserError(error.message, 502);
      }
      store.log('download', `${event.title} sent to ${CLIENT_NAMES[client]}`, request.id);
      return store.setStatus(request.id, 'downloading', { candidateId: candidate.id });
    },

    // Search the operator's own words on one indexer or all of them. Results
    // are matched and scored like any search and kept as candidates, so they
    // can be grabbed (or grabbed anyway) from the same list. The request's
    // status is left alone; grabbing moves it on.
    async manualSearch(requestId, { query, indexerId } = {}) {
      const request = requireRequest(requestId);
      const text = String(query || '').trim().replace(/\s+/g, ' ');
      if (text.length < 2) throw new UserError('Type something to search for.');
      if (text.length > 200) throw new UserError('That search is too long.');
      const settings = loadSettings(store);
      const indexers = byPriority(settings.indexers.filter(indexerReady).filter((i) => !indexerId || i.id === indexerId));
      if (!indexers.length) throw new UserError(indexerId ? 'That indexer is disabled or not set up.' : 'No indexer is configured; add one under Settings › Indexers.');
      const event = store.getEvent(request.eventId);
      searchLog.info(`Manual search for ${event.title}: "${text}"`, { indexers: indexers.map((i) => i.name).join(', ') });
      const found = new Map();
      const attempts = [];
      for (const indexer of indexers) {
        const attempt = { source: indexer.name, queries: [], started: Date.now(), results: 0, error: null, found: [] };
        await runQueries(indexer, [text], attempt, found);
        attempts.push(attempt);
      }
      const scored = judge(event, [...found.values()], settings);
      for (const candidate of scored) {
        candidate.evidence = [...candidate.evidence, `Manual search: "${text}"`];
        searchLog.debug(`${candidate.decision === 'matched' ? 'Matched' : 'Rejected'} ${candidate.title}`, { source: candidate.source, reason: candidate.reason });
      }
      store.saveCandidates(request.id, scored);
      for (const attempt of attempts) {
        store.recordSearch({
          requestId: request.id, source: `${attempt.source} (manual)`, queries: attempt.queries, resultCount: attempt.results,
          matchedCount: scored.filter((c) => c.decision === 'matched' && attempt.found.some((f) => f.identity === c.identity)).length,
          durationMs: Date.now() - attempt.started, error: attempt.error,
        });
      }
      const identities = new Set(scored.map((c) => c.identity));
      const candidates = store.listCandidates(request.id).filter((c) => identities.has(c.identity));
      searchLog.info(`Manual search "${text}": ${found.size} result(s), ${candidates.filter((c) => c.decision === 'matched').length} matched`);
      return { query: text, candidates, errors: attempts.filter((a) => a.error).map((a) => `${a.source}: ${a.error}`) };
    },

    async reconcileJobs() {
      const settings = loadSettings(store);
      for (const job of store.activeJobs()) {
        const event = store.getEvent(store.getRequest(job.requestId).eventId);
        let remote;
        try {
          const config = clientConfig(settings, job.client, String(job.remoteId).split('|')[0]);
          if (!config) throw new Error('its Easynews indexer has been removed from Settings');
          remote = await adapters[job.client].status(config, job.remoteId);
        } catch (error) {
          downloadLog.warn(`Could not check job ${job.id} (${event.title}) in ${CLIENT_NAMES[job.client]}: ${error.message}`);
          store.updateJob(job.id, { error: error.message });
          continue;
        }
        if (remote) {
          const change = remote.state !== job.state;
          downloadLog[change ? 'info' : 'debug'](`Job ${job.id} (${event.title}): ${remote.state}${remote.state === 'downloading' ? ` ${Math.round((remote.progress || 0) * 100)}%` : ''}`, { client: CLIENT_NAMES[job.client], path: remote.path, error: remote.error });
        }
        if (!remote) {
          downloadLog.debug(`Job ${job.id} (${event.title}) not found in ${CLIENT_NAMES[job.client]} yet`, { remoteId: String(job.remoteId).slice(0, 80) });
          if (clock().getTime() - Date.parse(job.createdAt) < MISSING_JOB_GRACE_MS) continue;
          store.updateJob(job.id, { state: 'failed', error: `No longer in ${CLIENT_NAMES[job.client]}` });
          store.setStatus(job.requestId, 'failed', { error: `The download was removed from ${CLIENT_NAMES[job.client]}.` });
          store.log('warning', `${event.title}: download missing from ${CLIENT_NAMES[job.client]}`, job.requestId);
          continue;
        }
        if (remote.state === 'failed') {
          store.updateJob(job.id, { state: 'failed', progress: remote.progress, remotePath: remote.path, error: remote.error });
          store.setStatus(job.requestId, 'failed', { error: remote.error });
          store.log('warning', `${event.title}: download failed: ${remote.error}`, job.requestId);
        } else if (remote.state === 'completed') {
          store.updateJob(job.id, { state: 'completed', progress: 1, remotePath: remote.path, error: null });
          store.setStatus(job.requestId, 'importing');
          store.log('download', `${event.title} finished downloading`, job.requestId);
        } else {
          store.updateJob(job.id, { state: remote.state, progress: remote.progress, error: null });
        }
      }
    },

    async importRequest(id) {
      const request = requireRequest(id);
      if (request.status !== 'importing') throw new UserError(`A ${request.status} request is not waiting to import.`, 409);
      const event = store.getEvent(request.eventId);
      const job = store.latestJob(request.id);
      const candidate = store.getCandidate(request.candidateId || job?.candidateId);
      const settings = loadSettings(store);
      try {
        if (!job?.remotePath) throw new ImportError('The download client did not report where the files are');
        const localPath = mapRemotePath(settings, job.remotePath);
        const { season, episode } = numberFor(event);
        importLog.info(`Importing ${event.title}`, { reported: job.remotePath, local: localPath, season, episode, mode: settings.library.mode });
        const result = await importDownload({
          settings, localPath, event, candidate, promotionName: promotionName(event),
          verifyName: (name) => evaluate(name, event), season, episode,
        });
        store.addLibraryItem({ eventId: event.id, requestId: request.id, path: result.path, size: result.size, quality: candidate?.quality, releaseTitle: candidate?.title, season, episode });
        store.log('ready', `${event.title} imported (${result.method}) to ${result.path}`, request.id);
        importLog.info(`Imported ${event.title}`, { method: result.method, path: result.path, bytes: result.size });
        await writeSidecars(event, store.libraryFor(event.id), settings);
        notifyMediaServer(settings);
        return store.setStatus(request.id, 'ready');
      } catch (error) {
        let message = error instanceof ImportError ? error.message : `Import failed: ${error.code || error.message}`;
        // The usual cause: the client reports a path from inside its own
        // container and no Remote Path Mapping translates it.
        if (job?.remotePath && /ENOENT|No video file found/.test(message) && mapRemotePath(settings, job.remotePath) === job.remotePath) {
          message += `. ${CLIENT_NAMES[job.client] || 'The download client'} reported this path from its own container; add a Remote Path Mapping in Settings › Download Clients so Replayarr can find it, then Retry.`;
        }
        store.log('warning', `${event.title}: ${message}`, request.id);
        importLog.warn(`Import failed for ${event.title}: ${message}`, error instanceof ImportError ? undefined : error);
        return store.setStatus(request.id, 'failed', { error: message });
      }
    },

    // --- library: rename files and media-server metadata -----------------
    // Where each imported event would go under the current naming pattern.
    // Events imported before numbering existed get their numbers now.
    renamePlan() {
      const settings = loadSettings(store);
      const plan = [];
      for (const item of store.listLibrary()) {
        const event = store.getEvent(item.eventId);
        if (!event) continue;
        const numbers = item.season && item.episode ? { season: item.season, episode: item.episode } : numberFor(event);
        const to = destinationFor(settings, {
          promotion: promotionName(event), title: event.title, date: event.date, year: String(event.date).slice(0, 4),
          quality: item.quality || '', release: item.releaseTitle || '', season: numbers.season,
          episode: String(numbers.episode).padStart(6, '0'),
        }, extname(item.path));
        plan.push({ eventId: event.id, title: event.title, from: item.path, to, ...numbers, changed: to !== item.path });
      }
      return plan;
    },

    async renameFiles() {
      const settings = loadSettings(store);
      const results = [];
      for (const entry of service.renamePlan()) {
        const event = store.getEvent(entry.eventId);
        try {
          if (entry.changed) {
            if (await stat(entry.to).catch(() => null)) throw new Error(`${entry.to} already exists`);
            await mkdir(dirname(entry.to), { recursive: true });
            await renameFile(entry.from, entry.to);
            await moveSidecars(entry.from, entry.to);
            await pruneEmptyFolders(dirname(entry.from), settings.library.root);
            store.log('ready', `Renamed ${entry.from} to ${entry.to}`);
          }
          const item = store.updateLibraryItem(entry.eventId, { path: entry.to, season: entry.season, episode: entry.episode });
          if (entry.changed) await writeSidecars(event, item, settings);
          results.push({ eventId: entry.eventId, ok: true, renamed: entry.changed });
        } catch (error) {
          store.log('warning', `${entry.title}: rename failed: ${error.code || error.message}`);
          results.push({ eventId: entry.eventId, ok: false, error: error.code || error.message });
        }
      }
      if (results.some((r) => r.renamed)) notifyMediaServer(settings);
      return results;
    },

    // Rewrite every imported event's .nfo and artwork, and each promotion's
    // show files (e.g. after choosing a new logo).
    async writeAllMetadata() {
      const settings = { ...loadSettings(store) };
      settings.library = { ...settings.library, writeMetadata: 'yes' };
      let count = 0;
      for (const item of store.listLibrary()) {
        const event = store.getEvent(item.eventId);
        if (!event || !(await stat(item.path).catch(() => null))) continue;
        const numbered = item.season && item.episode ? item : store.updateLibraryItem(item.eventId, { path: item.path, ...numberFor(event) });
        await writeSidecars(event, numbered, settings, { overwrite: true });
        count += 1;
      }
      store.log('metadata', `Wrote media-server metadata for ${count} event${count === 1 ? '' : 's'}`);
      notifyMediaServer(settings);
      return { count };
    },

    retry(id) {
      const request = requireRequest(id);
      if (request.status !== 'failed') throw new UserError('Only a failed request can be retried.', 409);
      const job = store.latestJob(request.id);
      if (job?.state === 'completed') return store.setStatus(request.id, 'importing');
      return store.setStatus(request.id, 'wanted', { nextSearchAt: iso() });
    },

    remove(id) {
      const request = requireRequest(id);
      store.deleteRequest(request.id);
      store.log('request', `${store.getEvent(request.eventId)?.title || 'Request'} removed from requests`);
    },

    // --- promotion rules -------------------------------------------------
    savePromotionRule({ id, kind, spec }) {
      const cleanId = String(id || '').trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(cleanId)) throw new UserError('Promotion ids use lowercase letters, numbers and hyphens.');
      const builtIn = promotions.getById(cleanId);
      if (kind === 'custom' && builtIn && !builtIn.isCustom) throw new UserError('That id belongs to a built-in promotion; add an alias overlay instead.');
      if (kind === 'overlay' && (!builtIn || builtIn.isCustom)) throw new UserError('Overlays apply to built-in promotions only.');
      if (kind === 'custom' && !String(spec?.name || '').trim()) throw new UserError('Custom promotions need a name.');
      store.savePromotionRule(cleanId, kind, { ...spec, idPrefix: kind === 'custom' ? cleanId : undefined });
      configurePromotions(store);
    },

    // --- health and tasks (Sonarr's System > Status and System > Tasks) ---
    health() {
      const settings = loadSettings(store);
      const issues = [];
      const add = (type, message, link) => issues.push({ type, message, link });
      const followed = metadata.list().filter((p) => p.followed);
      if (!followed.length) add('warning', 'No promotions are followed yet; add some under Metadata › Promotions', 'metadata/promotions');
      for (const promotion of followed.filter((p) => p.refreshError)) {
        add('warning', `${promotion.name}: ${promotion.refreshError}`, 'metadata/promotions');
      }
      if (!settings.indexers.some(indexerReady)) add('error', 'No indexer is configured; searches cannot run', 'settings/indexers');
      for (const indexer of settings.indexers.filter((i) => i.type === 'easynews' && indexerReady(i) && !i.downloadFolder)) {
        add('warning', `${indexer.name} has no download folder, so its results cannot be grabbed`, 'settings/indexers');
      }
      if (!clientConfigured(settings, 'qbittorrent') && !clientConfigured(settings, 'sabnzbd')) add('error', 'No download client is configured', 'settings/downloadclients');
      if (!settings.library.root) add('error', 'No library folder is set; completed downloads cannot be imported', 'settings/mediamanagement');
      for (const job of store.queue().filter((j) => j.error && !['failed', 'completed'].includes(j.state))) {
        add('warning', `${CLIENT_NAMES[job.client]} could not be reached: ${job.error}`, 'activity/queue');
        break;
      }
      const failed = store.counts().failed;
      if (failed) add('warning', `${failed} request${failed === 1 ? '' : 's'} failed and need attention`, 'wanted/missing');
      return issues;
    },

    tasks() {
      const last = store.getSetting('tasks', {});
      return [
        { name: 'sync-events', title: 'Refresh Metadata', interval: `${loadSettings(store).metadata.refreshHours || 'Manual'}${loadSettings(store).metadata.refreshHours ? ' hours' : ''}`, lastRun: metadata.status().finishedAt || null },
        { name: 'search-missing', title: 'Search Missing', interval: '30 seconds (due requests)', lastRun: last['search-missing'] || null },
        { name: 'check-downloads', title: 'Check For Finished Downloads', interval: '30 seconds', lastRun: last['check-downloads'] || null },
      ];
    },

    async runTask(name) {
      const record = () => store.setSetting('tasks', { ...store.getSetting('tasks', {}), [name]: iso() });
      if (name === 'sync-events') { const result = service.syncEvents(); record(); return result; }
      if (name === 'search-missing') {
        const count = store.markAllDue(iso());
        store.log('search', `Search queued for ${count} missing request${count === 1 ? '' : 's'}`);
        record();
        // Searches run on the worker, a few per tick, so the indexers are not flooded.
        return { queued: count };
      }
      if (name === 'check-downloads') {
        await service.reconcileJobs();
        for (const request of store.listRequests({ status: 'importing' })) await service.importRequest(request.id);
        record();
        return { ok: true };
      }
      throw new UserError('Unknown task.', 404);
    },

    // --- worker ---------------------------------------------------------
    async tick() {
      metadata.maybeAutoRefresh();
      for (const request of store.dueForSearch(iso()).slice(0, 3)) {
        try { await service.searchRequest(request.id); }
        catch (error) {
          store.log('warning', `Search error: ${error.message}`, request.id);
          const current = store.getRequest(request.id);
          if (current?.status === 'searching') store.setStatus(request.id, 'wanted', { nextSearchAt: iso(30 * MINUTE), error: error.message });
        }
      }
      await service.reconcileJobs();
      for (const request of store.listRequests({ status: 'importing' })) await service.importRequest(request.id);
      store.setSetting('tasks', { ...store.getSetting('tasks', {}), 'check-downloads': iso() });
    },

    // Requests left mid-search by a restart would otherwise never move again.
    recover() {
      for (const request of store.listRequests({ status: 'searching' })) {
        store.setStatus(request.id, 'wanted', { nextSearchAt: iso(), error: 'Search interrupted by a restart' });
      }
    },
  };
  return service;
}

export function startWorker(service, intervalMs = 30000) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await service.tick(); }
    catch (error) { workerLog.error('Worker tick failed', error); }
    finally { running = false; }
  };
  service.recover();
  const timer = setInterval(run, intervalMs);
  setTimeout(run, 1000);
  return () => clearInterval(timer);
}
