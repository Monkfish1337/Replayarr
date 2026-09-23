import * as prowlarrAdapter from './adapters/prowlarr.js';
import * as qbittorrentAdapter from './adapters/qbittorrent.js';
import * as sabnzbdAdapter from './adapters/sabnzbd.js';
import * as bitmagnetAdapter from './adapters/bitmagnet.js';
import * as easynewsAdapter from './adapters/easynews.js';
import { configurePromotions, evaluate, promotionFor, promotions, searchTitles } from './matching/index.js';
import { ImportError, importDownload } from './importer.js';
import { scoreCandidate } from './scoring.js';
import { indexerReady, loadSettings, mapRemotePath } from './settings.js';
import { createMetadata } from './metadata/manager.js';

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

export function createService(store, overrides = {}) {
  const adapters = {
    prowlarr: prowlarrAdapter, bitmagnet: bitmagnetAdapter, easynews: easynewsAdapter,
    qbittorrent: qbittorrentAdapter, sabnzbd: sabnzbdAdapter,
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

      const indexers = settings.indexers.filter(indexerReady);
      const found = new Map();
      const errors = [];
      const attempts = [];
      if (!indexers.length) errors.push('No indexer is configured; add one under Settings › Indexers');
      // Each indexer gets the promotion's search titles, most precise first,
      // up to its own query budget. The first indexer to report a release
      // (by info hash or indexer guid) keeps it.
      for (const indexer of indexers) {
        const queries = searchTitles(event, indexer.maxQueries);
        const attempt = { source: indexer.name, queries, started: Date.now(), results: 0, error: null, found: [] };
        for (const [index, query] of queries.entries()) {
          if (index && QUERY_PAUSE_MS[indexer.type]) await new Promise((r) => setTimeout(r, QUERY_PAUSE_MS[indexer.type]));
          try {
            for (const result of await adapters[indexer.type].search(indexer, query)) {
              attempt.results += 1;
              if (found.has(result.identity)) continue;
              const tagged = { ...result, source: indexer.name, sourceId: indexer.id };
              found.set(result.identity, tagged);
              attempt.found.push(tagged);
            }
          } catch (error) {
            attempt.error ||= error.message;
            // A configuration problem fails every query the same way.
            if (/not configured|rejected|HTTP 401|HTTP 403/.test(error.message)) break;
          }
        }
        if (attempt.error) errors.push(attempt.error);
        attempts.push(attempt);
      }

      const verify = (title) => evaluate(title, event);
      const scored = [...found.values()].map((result) => {
        const verdict = verify(result.title);
        const { score, quality, evidence } = scoreCandidate(result, {
          verdict, preferences: settings.preferences, minSizeMb: settings.library.minSizeMb,
        });
        if (verdict.ok && !clientConfigured(settings, CLIENT_FOR[result.protocol], result.sourceId)) {
          evidence.push(`No ${CLIENT_NAMES[CLIENT_FOR[result.protocol]]} connection configured`);
        }
        return { ...result, score, quality, evidence, decision: verdict.ok ? 'matched' : 'rejected', reason: verdict.ok ? null : `${verdict.stage}: ${verdict.reason}` };
      });
      const matched = scored.filter((c) => c.decision === 'matched');
      const rejected = scored.filter((c) => c.decision === 'rejected').slice(0, MAX_REJECTED_KEPT);
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

    async approve(requestId, candidateId) {
      const request = requireRequest(requestId);
      if (!['review', 'failed'].includes(request.status)) throw new UserError(`A ${request.status} request cannot take a new release.`, 409);
      const candidate = store.getCandidate(Number(candidateId));
      if (!candidate || candidate.requestId !== request.id) throw new UserError('That release does not belong to this request.', 404);
      if (candidate.decision !== 'matched') throw new UserError('Only a release that matched this event can be sent.');
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
      try {
        const { remoteId } = await adapters[client].add(clientConfig(settings, client, candidate.sourceId), candidate, { tag: `replayarr-${job.id}` });
        store.updateJob(job.id, { remoteId, state: 'queued' });
      } catch (error) {
        store.updateJob(job.id, { state: 'failed', error: error.message });
        store.setStatus(request.id, 'review', { error: error.message });
        store.log('warning', `${event.title}: could not send to ${CLIENT_NAMES[client]}: ${error.message}`, request.id);
        throw new UserError(error.message, 502);
      }
      store.log('download', `${event.title} sent to ${CLIENT_NAMES[client]}`, request.id);
      return store.setStatus(request.id, 'downloading', { candidateId: candidate.id });
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
          store.updateJob(job.id, { error: error.message });
          continue;
        }
        if (!remote) {
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
        const result = await importDownload({
          settings, localPath, event, candidate, promotionName: promotionName(event),
          verifyName: (name) => evaluate(name, event),
        });
        store.addLibraryItem({ eventId: event.id, requestId: request.id, path: result.path, size: result.size, quality: candidate?.quality, releaseTitle: candidate?.title });
        store.log('ready', `${event.title} imported (${result.method}) to ${result.path}`, request.id);
        return store.setStatus(request.id, 'ready');
      } catch (error) {
        let message = error instanceof ImportError ? error.message : `Import failed: ${error.code || error.message}`;
        // The usual cause: the client reports a path from inside its own
        // container and no Remote Path Mapping translates it.
        if (job?.remotePath && /ENOENT|No video file found/.test(message) && mapRemotePath(settings, job.remotePath) === job.remotePath) {
          message += `. ${CLIENT_NAMES[job.client] || 'The download client'} reported this path from its own container; add a Remote Path Mapping in Settings › Download Clients so Replayarr can find it, then Retry.`;
        }
        store.log('warning', `${event.title}: ${message}`, request.id);
        return store.setStatus(request.id, 'failed', { error: message });
      }
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
    catch (error) { console.error('[worker]', error); }
    finally { running = false; }
  };
  service.recover();
  const timer = setInterval(run, intervalMs);
  setTimeout(run, 1000);
  return () => clearInterval(timer);
}
