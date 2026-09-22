import * as sssAdapter from './adapters/sss.js';
import * as prowlarrAdapter from './adapters/prowlarr.js';
import * as qbittorrentAdapter from './adapters/qbittorrent.js';
import * as sabnzbdAdapter from './adapters/sabnzbd.js';
import { configurePromotions, evaluate, promotionFor, promotions, searchTitles } from './matching/index.js';
import { ImportError, importDownload } from './importer.js';
import { scoreCandidate } from './scoring.js';
import { loadSettings, mapRemotePath } from './settings.js';

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

const CLIENT_FOR = { torrent: 'qbittorrent', usenet: 'sabnzbd' };
const CLIENT_NAMES = { qbittorrent: 'qBittorrent', sabnzbd: 'SABnzbd' };

export function createService(store, overrides = {}) {
  const adapters = {
    sss: sssAdapter, prowlarr: prowlarrAdapter, qbittorrent: qbittorrentAdapter, sabnzbd: sabnzbdAdapter,
    ...overrides.adapters,
  };
  const clock = overrides.now || (() => new Date());
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

  function clientConfigured(settings, client) {
    const config = settings[client];
    return client === 'qbittorrent' ? !!config.url : !!(config.url && config.apiKey);
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
    async syncEvents() {
      const settings = loadSettings(store);
      const events = await adapters.sss.listEvents(settings.sss, { today: clock() });
      let count = 0;
      for (const item of events) {
        const promotion = promotions.getByEventId(item.id);
        const existing = store.getEvent(item.id);
        store.upsertEvent({
          id: item.id,
          promotionId: promotion?.id || existing?.promotionId || null,
          title: item.title,
          date: item.date,
          time: existing?.time || null,
          aliases: existing?.aliases || [],
          source: 'sss',
          sourceRevision: item.catalog,
        });
        count += 1;
      }
      store.log('metadata', `Imported ${count} events from SSS`);
      return { count };
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
      let event = store.getEvent(String(eventId || ''));
      if (!event) throw new UserError('Event not found.', 404);
      const owned = store.libraryFor(event.id);
      if (owned) throw new UserError('This event is already in your library.', 409);
      if (event.source === 'sss') {
        // Aliases and the exact start time live on the SSS detail record.
        try {
          const detail = await adapters.sss.fetchEventDetail(loadSettings(store).sss, event.id);
          if (detail) event = store.upsertEvent({ ...event, ...detail, title: detail.title || event.title, date: detail.date || event.date });
        } catch (error) {
          store.log('warning', `Could not refresh ${event.title} from SSS: ${error.message}`);
        }
      }
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

      const queries = searchTitles(event, settings.prowlarr.maxQueries);
      const started = Date.now();
      const found = new Map();
      const errors = [];
      for (const query of queries) {
        try {
          for (const result of await adapters.prowlarr.search(settings.prowlarr, query)) {
            if (!found.has(result.identity)) found.set(result.identity, result);
          }
        } catch (error) {
          errors.push(error.message);
          // A configuration problem fails every query the same way.
          if (/not configured|HTTP 401|HTTP 403/.test(error.message)) break;
        }
      }

      const verify = (title) => evaluate(title, event);
      const scored = [...found.values()].map((result) => {
        const verdict = verify(result.title);
        const { score, quality, evidence } = scoreCandidate(result, {
          verdict, preferences: settings.preferences, minSizeMb: settings.library.minSizeMb,
        });
        if (verdict.ok && !clientConfigured(settings, CLIENT_FOR[result.protocol])) {
          evidence.push(`No ${CLIENT_NAMES[CLIENT_FOR[result.protocol]]} connection configured`);
        }
        return { ...result, score, quality, evidence, decision: verdict.ok ? 'matched' : 'rejected', reason: verdict.ok ? null : `${verdict.stage}: ${verdict.reason}` };
      });
      const matched = scored.filter((c) => c.decision === 'matched');
      const rejected = scored.filter((c) => c.decision === 'rejected').slice(0, MAX_REJECTED_KEPT);
      store.saveCandidates(request.id, [...matched, ...rejected]);
      store.recordSearch({
        requestId: request.id, source: 'Prowlarr', queries, resultCount: found.size, matchedCount: matched.length,
        durationMs: Date.now() - started, error: errors.length ? errors[0] : null,
      });

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
      if (!clientConfigured(settings, client)) throw new UserError(`Connect ${CLIENT_NAMES[client]} in Settings first.`);
      const event = store.getEvent(request.eventId);
      if (request.status === 'failed') store.setStatus(request.id, 'review');

      const job = store.createJob({ requestId: request.id, candidateId: candidate.id, client, state: 'submitting' });
      try {
        const { remoteId } = await adapters[client].add(settings[client], candidate, { tag: `replayarr-${job.id}` });
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
          remote = await adapters[job.client].status(settings[job.client], job.remoteId);
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
        const message = error instanceof ImportError ? error.message : `Import failed: ${error.code || error.message}`;
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
      if (!settings.sss.manifestUrl) add('warning', 'No SSS install is connected, so events must be added by hand', 'settings/metadata');
      if (!settings.prowlarr.url || !settings.prowlarr.apiKey) add('error', 'Prowlarr is not configured; searches cannot run', 'settings/indexers');
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
        { name: 'sync-events', title: 'Refresh Events', interval: 'Manual', lastRun: last['sync-events'] || null },
        { name: 'search-missing', title: 'Search Missing', interval: '30 seconds (due requests)', lastRun: last['search-missing'] || null },
        { name: 'check-downloads', title: 'Check For Finished Downloads', interval: '30 seconds', lastRun: last['check-downloads'] || null },
      ];
    },

    async runTask(name) {
      const record = () => store.setSetting('tasks', { ...store.getSetting('tasks', {}), [name]: iso() });
      if (name === 'sync-events') { const result = await service.syncEvents(); record(); return result; }
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
