import { transaction } from './db.js';

export const STATUSES = ['wanted', 'searching', 'review', 'downloading', 'importing', 'ready', 'failed'];

// The only moves a request may make. Everything that changes a request's
// status goes through setStatus, so an out-of-order worker tick or a stale
// UI click cannot, for example, mark a request ready without an import.
const TRANSITIONS = {
  wanted: ['searching'],
  searching: ['review', 'wanted', 'failed'],
  review: ['downloading', 'wanted'],
  downloading: ['importing', 'failed', 'wanted'],
  importing: ['ready', 'failed'],
  failed: ['wanted', 'importing', 'review'],
  ready: [],
};

export class TransitionError extends Error {
  constructor(from, to) {
    super(`A request cannot move from ${from} to ${to}.`);
    this.code = 'INVALID_TRANSITION';
  }
}

const now = () => new Date().toISOString();
const json = (value, fallback) => {
  try { return JSON.parse(value); } catch { return fallback; }
};

function eventRow(row) {
  if (!row) return null;
  return {
    id: row.id, promotionId: row.promotion_id, title: row.title, date: row.date, time: row.time,
    aliases: json(row.aliases, []), source: row.source, sourceRevision: row.source_revision, updatedAt: row.updated_at,
    payload: row.payload ? json(row.payload, null) : null,
  };
}

function requestRow(row) {
  if (!row) return null;
  return {
    id: row.id, eventId: row.event_id, status: row.status, candidateId: row.candidate_id,
    searchCount: row.search_count, nextSearchAt: row.next_search_at, error: row.error,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function candidateRow(row) {
  if (!row) return null;
  return {
    id: row.id, requestId: row.request_id, identity: row.identity, source: row.source, sourceId: row.source_id, indexer: row.indexer,
    protocol: row.protocol, title: row.title, downloadUrl: row.download_url, infoHash: row.info_hash,
    size: row.size, seeders: row.seeders, quality: row.quality, score: row.score, decision: row.decision,
    reason: row.reason, evidence: json(row.evidence, []), publishedAt: row.published_at, foundAt: row.found_at,
  };
}

function jobRow(row) {
  if (!row) return null;
  return {
    id: row.id, requestId: row.request_id, candidateId: row.candidate_id, client: row.client,
    remoteId: row.remote_id, state: row.state, progress: row.progress, remotePath: row.remote_path,
    error: row.error, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function libraryRow(row) {
  if (!row) return null;
  return {
    id: row.id, eventId: row.event_id, requestId: row.request_id, path: row.path, size: row.size,
    quality: row.quality, releaseTitle: row.release_title, importedAt: row.imported_at,
    season: row.season, episode: row.episode,
  };
}

export function createStore(db) {
  const q = (sql) => db.prepare(sql);

  const store = {
    db,

    // --- settings -------------------------------------------------------
    getSetting(key, fallback) {
      const row = q('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? json(row.value, fallback) : fallback;
    },
    setSetting(key, value) {
      q('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
        .run(key, JSON.stringify(value));
    },

    // --- events ---------------------------------------------------------
    upsertEvent(event) {
      q(`INSERT INTO events (id, promotion_id, title, date, time, aliases, source, source_revision, payload, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET promotion_id = excluded.promotion_id, title = excluded.title,
           date = excluded.date, time = excluded.time, aliases = excluded.aliases, source = excluded.source,
           source_revision = excluded.source_revision, payload = excluded.payload, updated_at = excluded.updated_at`)
        .run(event.id, event.promotionId || null, event.title, event.date, event.time || null,
          JSON.stringify(event.aliases || []), event.source, event.sourceRevision || null,
          event.payload ? JSON.stringify(event.payload) : null, now());
      return store.getEvent(event.id);
    },
    getEvent(id) {
      return eventRow(q('SELECT * FROM events WHERE id = ?').get(id));
    },
    listEvents({ search = '', promotionId = '', from = '', to = '', limit = 200 } = {}) {
      const where = [];
      const args = [];
      if (search) { where.push('(title LIKE ? OR aliases LIKE ?)'); args.push(`%${search}%`, `%${search}%`); }
      if (promotionId) { where.push('promotion_id = ?'); args.push(promotionId); }
      if (from) { where.push('date >= ?'); args.push(from); }
      if (to) { where.push('date <= ?'); args.push(to); }
      const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                   ORDER BY date DESC, title LIMIT ?`;
      return q(sql).all(...args, Math.min(Math.max(Number(limit) || 200, 1), 1000)).map(eventRow);
    },

    // Drop a promotion's fetched events that its source no longer lists,
    // keeping anything requested, imported, or added by hand.
    pruneEvents(promotionId, keepIds) {
      const keep = new Set(keepIds);
      const rows = q(`SELECT events.id FROM events
                      LEFT JOIN requests ON requests.event_id = events.id
                      LEFT JOIN library ON library.event_id = events.id
                      WHERE events.promotion_id = ? AND events.source != 'manual'
                        AND requests.id IS NULL AND library.id IS NULL`).all(promotionId);
      const remove = q('DELETE FROM events WHERE id = ?');
      let removed = 0;
      transaction(db, () => {
        for (const row of rows) if (!keep.has(row.id)) { remove.run(row.id); removed += 1; }
      });
      return removed;
    },

    // --- metadata providers and per-promotion settings -------------------
    listProviders() {
      return q('SELECT * FROM providers ORDER BY name').all()
        .map((row) => ({ id: row.id, name: row.name, source: json(row.source, {}), system: false, createdAt: row.created_at }));
    },
    saveProvider(provider) {
      q(`INSERT INTO providers (id, name, source, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, source = excluded.source`)
        .run(provider.id, provider.name, JSON.stringify(provider.source), now());
    },
    deleteProvider(id) {
      transaction(db, () => {
        q('DELETE FROM providers WHERE id = ?').run(id);
        q('UPDATE promotion_meta SET provider_id = NULL WHERE provider_id = ?').run(id);
      });
    },
    listPromotionMeta() {
      return Object.fromEntries(q('SELECT * FROM promotion_meta').all().map((row) => [row.promotion_id, {
        followed: !!row.followed, providerId: row.provider_id, startDate: row.start_date, logoUrl: row.logo_url,
        refreshedAt: row.refreshed_at, refreshCount: row.refresh_count, refreshError: row.refresh_error,
      }]));
    },
    updatePromotionMeta(promotionId, patch) {
      const current = store.listPromotionMeta()[promotionId] || {};
      const next = { followed: false, providerId: null, startDate: null, logoUrl: null, refreshedAt: null, refreshCount: null, refreshError: null, ...current, ...patch };
      q(`INSERT INTO promotion_meta (promotion_id, followed, provider_id, start_date, logo_url, refreshed_at, refresh_count, refresh_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (promotion_id) DO UPDATE SET followed = excluded.followed, provider_id = excluded.provider_id,
           start_date = excluded.start_date, logo_url = excluded.logo_url, refreshed_at = excluded.refreshed_at,
           refresh_count = excluded.refresh_count, refresh_error = excluded.refresh_error`)
        .run(promotionId, next.followed ? 1 : 0, next.providerId || null, next.startDate || null, next.logoUrl || null,
          next.refreshedAt || null, next.refreshCount ?? null, next.refreshError || null);
      return store.listPromotionMeta()[promotionId];
    },

    // --- requests -------------------------------------------------------
    createRequest(eventId) {
      return transaction(db, () => {
        const existing = requestRow(q('SELECT * FROM requests WHERE event_id = ?').get(eventId));
        if (existing) return { request: existing, created: false };
        const stamp = now();
        const { lastInsertRowid } = q(`INSERT INTO requests (event_id, status, created_at, updated_at, next_search_at)
                                       VALUES (?, 'wanted', ?, ?, ?)`).run(eventId, stamp, stamp, stamp);
        return { request: store.getRequest(Number(lastInsertRowid)), created: true };
      });
    },
    getRequest(id) {
      return requestRow(q('SELECT * FROM requests WHERE id = ?').get(id));
    },
    listRequests({ status } = {}) {
      const rows = status
        ? q('SELECT * FROM requests WHERE status = ? ORDER BY updated_at DESC').all(status)
        : q('SELECT * FROM requests ORDER BY updated_at DESC').all();
      return rows.map(requestRow);
    },
    dueForSearch(at = now()) {
      return q(`SELECT * FROM requests WHERE status = 'wanted' AND (next_search_at IS NULL OR next_search_at <= ?)
                ORDER BY next_search_at`).all(at).map(requestRow);
    },
    setStatus(id, to, patch = {}) {
      const current = store.getRequest(id);
      if (!current) throw new Error(`Request ${id} not found.`);
      if (current.status !== to && !TRANSITIONS[current.status].includes(to)) {
        throw new TransitionError(current.status, to);
      }
      const next = {
        candidate_id: 'candidateId' in patch ? patch.candidateId : current.candidateId,
        search_count: 'searchCount' in patch ? patch.searchCount : current.searchCount,
        next_search_at: 'nextSearchAt' in patch ? patch.nextSearchAt : current.nextSearchAt,
        error: 'error' in patch ? patch.error : null,
      };
      q(`UPDATE requests SET status = ?, candidate_id = ?, search_count = ?, next_search_at = ?, error = ?, updated_at = ?
         WHERE id = ?`).run(to, next.candidate_id, next.search_count, next.next_search_at, next.error, now(), id);
      return store.getRequest(id);
    },
    deleteRequest(id) {
      q('DELETE FROM requests WHERE id = ?').run(id);
    },

    // --- search attempts and candidates ---------------------------------
    recordSearch(attempt) {
      q(`INSERT INTO search_attempts (request_id, source, queries, result_count, matched_count, duration_ms, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(attempt.requestId, attempt.source, JSON.stringify(attempt.queries), attempt.resultCount,
          attempt.matchedCount, attempt.durationMs, attempt.error || null, now());
    },
    listSearches(requestId) {
      return q('SELECT * FROM search_attempts WHERE request_id = ? ORDER BY id DESC LIMIT 20').all(requestId)
        .map((row) => ({
          id: row.id, source: row.source, queries: json(row.queries, []), resultCount: row.result_count,
          matchedCount: row.matched_count, durationMs: row.duration_ms, error: row.error, createdAt: row.created_at,
        }));
    },
    // Re-finding a release refreshes its score and verdict but keeps its id,
    // so an approval the operator is looking at never points at a new row.
    saveCandidates(requestId, candidates) {
      const insert = q(`INSERT INTO candidates (request_id, identity, source, source_id, indexer, protocol, title, download_url, info_hash,
                          size, seeders, quality, score, decision, reason, evidence, published_at, found_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT (request_id, identity) DO UPDATE SET download_url = excluded.download_url,
                          source = excluded.source, source_id = excluded.source_id, seeders = excluded.seeders, score = excluded.score, decision = excluded.decision,
                          reason = excluded.reason, evidence = excluded.evidence, found_at = excluded.found_at`);
      transaction(db, () => {
        for (const c of candidates) {
          insert.run(requestId, c.identity, c.source, c.sourceId || null, c.indexer || null, c.protocol, c.title, c.downloadUrl || null,
            c.infoHash || null, c.size ?? null, c.seeders ?? null, c.quality || null, c.score, c.decision,
            c.reason || null, JSON.stringify(c.evidence || []), c.publishedAt || null, now());
        }
      });
    },
    listCandidates(requestId) {
      return q(`SELECT * FROM candidates WHERE request_id = ?
                ORDER BY decision = 'matched' DESC, score DESC, id`).all(requestId).map(candidateRow);
    },
    getCandidate(id) {
      return candidateRow(q('SELECT * FROM candidates WHERE id = ?').get(id));
    },

    // --- download jobs --------------------------------------------------
    createJob(job) {
      const stamp = now();
      const { lastInsertRowid } = q(`INSERT INTO jobs (request_id, candidate_id, client, remote_id, state, created_at, updated_at)
                                     VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(job.requestId, job.candidateId, job.client, job.remoteId || null, job.state || 'queued', stamp, stamp);
      return store.getJob(Number(lastInsertRowid));
    },
    updateJob(id, patch) {
      const current = store.getJob(id);
      const merged = { ...current, ...patch };
      q(`UPDATE jobs SET remote_id = ?, state = ?, progress = ?, remote_path = ?, error = ?, updated_at = ? WHERE id = ?`)
        .run(merged.remoteId || null, merged.state, merged.progress || 0, merged.remotePath || null,
          merged.error || null, now(), id);
      return store.getJob(id);
    },
    getJob(id) {
      return jobRow(q('SELECT * FROM jobs WHERE id = ?').get(id));
    },
    latestJob(requestId) {
      return jobRow(q('SELECT * FROM jobs WHERE request_id = ? ORDER BY id DESC LIMIT 1').get(requestId));
    },
    activeJobs() {
      return q(`SELECT jobs.* FROM jobs JOIN requests ON requests.id = jobs.request_id
                WHERE requests.status = 'downloading' AND jobs.remote_id IS NOT NULL AND jobs.state NOT IN ('completed', 'failed')
                AND jobs.id = (SELECT MAX(id) FROM jobs latest WHERE latest.request_id = jobs.request_id)`)
        .all().map(jobRow);
    },

    // --- library --------------------------------------------------------
    addLibraryItem(item) {
      q(`INSERT INTO library (event_id, request_id, path, size, quality, release_title, imported_at, season, episode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (event_id) DO UPDATE SET request_id = excluded.request_id, path = excluded.path,
           size = excluded.size, quality = excluded.quality, release_title = excluded.release_title,
           imported_at = excluded.imported_at, season = excluded.season, episode = excluded.episode`)
        .run(item.eventId, item.requestId, item.path, item.size, item.quality || null, item.releaseTitle || null, now(),
          item.season ?? null, item.episode ?? null);
      return libraryRow(q('SELECT * FROM library WHERE event_id = ?').get(item.eventId));
    },
    updateLibraryItem(eventId, { path, season, episode }) {
      q('UPDATE library SET path = ?, season = ?, episode = ? WHERE event_id = ?').run(path, season ?? null, episode ?? null, eventId);
      return store.libraryFor(eventId);
    },
    eventsOnDate(promotionId, date) {
      return q('SELECT * FROM events WHERE promotion_id = ? AND date = ?').all(promotionId, date).map(eventRow);
    },
    listLibrary() {
      return q('SELECT * FROM library ORDER BY imported_at DESC').all().map(libraryRow);
    },
    libraryFor(eventId) {
      return libraryRow(q('SELECT * FROM library WHERE event_id = ?').get(eventId));
    },

    // --- activity -------------------------------------------------------
    log(kind, text, requestId = null) {
      q('INSERT INTO activity (request_id, kind, text, created_at) VALUES (?, ?, ?, ?)').run(requestId, kind, text, now());
    },
    listActivity(limit = 100) {
      return q('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(Math.min(Number(limit) || 100, 500))
        .map((row) => ({ id: row.id, requestId: row.request_id, kind: row.kind, text: row.text, createdAt: row.created_at }));
    },

    // --- promotion rules ------------------------------------------------
    listPromotionRules() {
      return q('SELECT * FROM promotion_rules ORDER BY id').all()
        .map((row) => ({ id: row.id, kind: row.kind, spec: json(row.spec, {}), updatedAt: row.updated_at }));
    },
    savePromotionRule(id, kind, spec) {
      q(`INSERT INTO promotion_rules (id, kind, spec, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, spec = excluded.spec, updated_at = excluded.updated_at`)
        .run(id, kind, JSON.stringify(spec), now());
    },
    deletePromotionRule(id) {
      q('DELETE FROM promotion_rules WHERE id = ?').run(id);
    },

    // Per-promotion totals for the promotion index, like Sonarr's episode
    // count bar: events known, events requested, events in the library.
    promotionStats() {
      return Object.fromEntries(q(`SELECT events.promotion_id AS id, COUNT(*) AS events,
                COUNT(requests.id) AS requested, COUNT(library.id) AS downloaded,
                MIN(CASE WHEN events.date >= date('now') THEN events.date END) AS next_date,
                MAX(CASE WHEN events.date < date('now') THEN events.date END) AS last_date
              FROM events
              LEFT JOIN requests ON requests.event_id = events.id
              LEFT JOIN library ON library.event_id = events.id
              GROUP BY events.promotion_id`).all()
        .map((row) => [row.id, { events: row.events, requested: row.requested, downloaded: row.downloaded, nextDate: row.next_date, lastDate: row.last_date }]));
    },
    queue() {
      return q(`SELECT jobs.* FROM jobs JOIN requests ON requests.id = jobs.request_id
                WHERE requests.status IN ('downloading', 'importing')
                AND jobs.id = (SELECT MAX(id) FROM jobs latest WHERE latest.request_id = jobs.request_id)
                ORDER BY jobs.created_at`).all().map(jobRow);
    },
    markAllDue(at = now()) {
      return q(`UPDATE requests SET next_search_at = ? WHERE status = 'wanted'`).run(at).changes;
    },

    counts() {
      const rows = q('SELECT status, COUNT(*) AS n FROM requests GROUP BY status').all();
      const by = Object.fromEntries(rows.map((row) => [row.status, row.n]));
      return {
        wanted: rows.reduce((sum, row) => sum + row.n, 0),
        review: by.review || 0,
        active: (by.wanted || 0) + (by.searching || 0) + (by.downloading || 0) + (by.importing || 0),
        failed: by.failed || 0,
        ready: by.ready || 0,
      };
    },
  };
  return store;
}
