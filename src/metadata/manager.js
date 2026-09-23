import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasPrelims, prelimsEvent, promotions } from '../matching/index.js';
import metadataConfig from './config.cjs';
import refresh from './refresh.cjs';
import preview from './preview.cjs';
import providers from './providers.cjs';
import { logoCandidates } from './logos.js';
import { logger } from '../logger.js';

const log = logger('metadata');

// Replayarr's own schedule metadata, replacing the SSS install it used to
// read. Promotions are followed like Sonarr series: only followed promotions
// are fetched, each from its assigned provider (or its built-in source).
export class MetadataError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/gif': 'gif' };

// `fetchEvents` is the schedule fetch; tests replace it to avoid live APIs.
export function createMetadata(store, { settings, logoDir, clock = () => new Date(), fetchEvents = refresh.fetchPromotionEvents }) {
  const job = { running: false, queue: [], current: null, startedAt: null, finishedAt: null, results: [] };

  function applyKeys() {
    const m = settings().metadata;
    metadataConfig.configure({
      tsdbApiKey: m.tsdbApiKey, footballDataApiKey: m.footballDataApiKey, apiFootballApiKey: m.apiFootballApiKey,
      tmdbApiKey: m.tmdbApiKey, daysBack: m.daysBack, daysAhead: m.daysAhead,
    });
  }

  function allProviders() {
    return [...providers.SYSTEM_SOURCES.map((p) => ({ ...p })), ...store.listProviders()];
  }

  function requirePromotion(id) {
    const promotion = promotions.getById(String(id || ''));
    if (!promotion) throw new MetadataError('Promotion not found.', 404);
    return promotion;
  }

  // The source a promotion is fetched from: its assigned provider, else the
  // source it ships with.
  function resolve(promotion, meta = store.listPromotionMeta()[promotion.id] || {}) {
    const provider = meta.providerId && allProviders().find((p) => p.id === meta.providerId);
    const source = provider ? provider.source : promotion.source;
    const matching = provider || allProviders().find((p) => providers.sourceKey(p.source) === providers.sourceKey(source));
    return { source, providerId: provider?.id || null, providerName: matching?.name || describe(source) };
  }

  // A per-refresh view of the promotion with its source and start date
  // applied; methods still see the promotion's own state through the prototype.
  //
  // Without a start date, SSS reaches back to 2025-01-01, which for
  // TheSportsDB means walking every round of every season since (many minutes
  // per promotion at its rate limit). Replayarr instead starts at "Import past
  // days" unless the promotion has its own start date.
  function effective(promotion, meta) {
    const { source } = resolve(promotion, meta);
    const back = new Date(clock().getTime() - (Number(settings().metadata.daysBack) || 30) * 86400000).toISOString().slice(0, 10);
    return Object.create(promotion, {
      source: { value: source, enumerable: true },
      metadataStartDate: { value: meta?.startDate || promotion.defaultMetadataStartDate || back, enumerable: true },
    });
  }

  function describe(source = {}) {
    if (source.type === 'thesportsdb') return `TheSportsDB league ${source.leagueId}`;
    if (source.type === 'espn') return `ESPN ${source.league}`;
    if (source.type === 'football-data') return `football-data.org ${source.teamId ? 'team ' + source.teamId : source.competitionId}`;
    if (source.type === 'api-football') return `API-Football competition ${source.leagueId}`;
    if (source.type === 'uefa') return `UEFA competition ${source.competitionId}`;
    if (source.type === 'tmdb') return `TMDB ${(source.tvIds || [source.tvId]).join(', ')}`;
    if (source.type === 'json-feed') return `JSON feed ${source.url || ''}`;
    return { onefc: 'Official ONE schedule', aew: 'Official AEW schedule', mlb: 'Official MLB schedule' }[source.type] || source.type || 'Unknown';
  }

  async function refreshOne(promotionId) {
    const promotion = promotions.getById(promotionId);
    if (!promotion) return { promotionId, ok: false, error: 'Promotion no longer exists' };
    const meta = store.listPromotionMeta()[promotionId] || {};
    const started = Date.now();
    applyKeys();
    try {
      const view = effective(promotion, meta);
      log.info(`Refreshing ${promotion.name}`, { source: describe(view.source), from: view.metadataStartDate });
      // The ported SSS sources narrate each request and page; keep that at debug.
      const events = await fetchEvents(view, { log: (line) => log.debug(`${promotion.name}: ${String(line).trim()}`) });
      log.info(`${promotion.name}: ${events.length} event(s)`, { seconds: Math.round((Date.now() - started) / 1000) });
      const keep = [];
      for (const event of events) {
        const record = {
          id: event.id,
          promotionId: promotion.id,
          title: event.name,
          date: event.date,
          time: event.time ? String(event.time).slice(0, 5) : null,
          aliases: Array.isArray(event.aliases) ? event.aliases : [],
          source: 'metadata',
          sourceRevision: resolve(promotion, meta).source.type,
          payload: event,
        };
        // Cards released in parts (UFC) also get a prelims event.
        for (const each of hasPrelims(promotion.id) ? [record, prelimsEvent(record)] : [record]) {
          store.upsertEvent(each);
          keep.push(each.id);
        }
      }
      const removed = store.pruneEvents(promotion.id, keep);
      store.updatePromotionMeta(promotion.id, { refreshedAt: clock().toISOString(), refreshCount: events.length, refreshError: null });
      store.log('metadata', `${promotion.name}: ${events.length} events from ${resolve(promotion, meta).providerName}${removed ? `, ${removed} removed` : ''}`);
      return { promotionId, ok: true, count: events.length, removed, seconds: Math.round((Date.now() - started) / 1000) };
    } catch (error) {
      store.updatePromotionMeta(promotion.id, { refreshedAt: clock().toISOString(), refreshError: error.message });
      store.log('warning', `${promotion.name}: metadata refresh failed: ${error.message}`);
      log.warn(`${promotion.name}: refresh failed: ${error.message}`, error);
      return { promotionId, ok: false, error: error.message };
    }
  }

  async function drain() {
    if (job.running) return;
    job.running = true;
    job.startedAt = clock().toISOString();
    job.results = [];
    try {
      while (job.queue.length) {
        job.current = job.queue.shift();
        job.results.push(await refreshOne(job.current));
      }
    } finally {
      job.current = null;
      job.running = false;
      job.finishedAt = clock().toISOString();
      store.setSetting('metadataRefreshedAt', job.finishedAt);
    }
  }

  const manager = {
    describe,
    resolve,

    list() {
      const meta = store.listPromotionMeta();
      const stats = store.promotionStats();
      return promotions.all.map((p) => {
        const m = meta[p.id] || {};
        const resolved = resolve(p, m);
        return {
          id: p.id, name: p.name, idPrefix: p.idPrefix, custom: !!p.isCustom, overlay: !!p.matchingOverride,
          followed: !!m.followed, startDate: m.startDate || null, profileId: m.profileId || null,
          logo: m.logoUrl || '', defaultLogo: p.defaults?.logo || p.defaults?.poster || '', customLogo: !!m.logoUrl,
          posterShape: p.posterShape || 'landscape',
          sourceType: resolved.source.type, providerId: resolved.providerId, providerName: resolved.providerName,
          refreshedAt: m.refreshedAt || null, refreshCount: m.refreshCount ?? null, refreshError: m.refreshError || null,
          refreshing: job.current === p.id || job.queue.includes(p.id),
          refreshState: job.current === p.id ? 'running' : job.queue.includes(p.id) ? 'queued' : null,
          stats: stats[p.id] || { events: 0, requested: 0, downloaded: 0, nextDate: null, lastDate: null },
        };
      });
    },

    providers() {
      const list = manager.list();
      return allProviders().map((p) => ({
        ...p,
        description: describe(p.source),
        usedBy: list.filter((promo) => providers.sourceKey(resolve(promotions.getById(promo.id)).source) === providers.sourceKey(p.source)).map((promo) => promo.name),
      }));
    },

    update(promotionId, patch) {
      const promotion = requirePromotion(promotionId);
      const next = {};
      if ('followed' in patch) next.followed = !!patch.followed;
      if ('providerId' in patch) {
        const id = patch.providerId || null;
        if (id && !allProviders().some((p) => p.id === id)) throw new MetadataError('Unknown provider.');
        // Picking the provider the promotion ships with is the same as no override.
        next.providerId = id && providers.sourceKey(allProviders().find((p) => p.id === id).source) === providers.sourceKey(promotion.source) ? null : id;
      }
      if ('startDate' in patch) {
        if (patch.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(patch.startDate)) throw new MetadataError('Start date must be YYYY-MM-DD.');
        next.startDate = patch.startDate || null;
      }
      if ('logoUrl' in patch) {
        const url = String(patch.logoUrl || '').trim();
        if (url && !/^https:\/\/\S+$/i.test(url) && !/^\/logos\/[a-z0-9-]+\.(?:png|jpg|webp|svg|gif)$/.test(url)) throw new MetadataError('Logo must be an https:// image URL.');
        next.logoUrl = url || null;
      }
      if ('profileId' in patch) {
        const id = patch.profileId || null;
        if (id && !settings().profiles.some((p) => p.id === id)) throw new MetadataError('Unknown quality profile.');
        next.profileId = id;
      }
      const before = store.listPromotionMeta()[promotion.id] || {};
      store.updatePromotionMeta(promotion.id, next);
      const sourceChanged = 'providerId' in next && next.providerId !== (before.providerId || null);
      const startChanged = 'startDate' in next && next.startDate !== (before.startDate || null);
      if (next.followed && !before.followed) store.log('metadata', `Now following ${promotion.name}`);
      if ((next.followed && !before.followed) || ((sourceChanged || startChanged) && (next.followed ?? before.followed))) manager.refresh([promotion.id]);
      return manager.list().find((p) => p.id === promotion.id);
    },

    async uploadLogo(promotionId, dataUrl) {
      const promotion = requirePromotion(promotionId);
      const match = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
      const ext = match && LOGO_TYPES[match[1]];
      if (!ext) throw new MetadataError('Upload a PNG, JPEG, WebP, SVG or GIF image.');
      const bytes = Buffer.from(match[2], 'base64');
      if (bytes.length > MAX_LOGO_BYTES) throw new MetadataError('Logos must be 2 MB or smaller.');
      await mkdir(logoDir, { recursive: true });
      const base = promotion.id.replace(/[^a-z0-9-]/g, '');
      for (const file of await readdir(logoDir).catch(() => [])) if (file.startsWith(base + '.')) await unlink(join(logoDir, file)).catch(() => {});
      await writeFile(join(logoDir, `${base}.${ext}`), bytes);
      return manager.update(promotion.id, { logoUrl: `/logos/${base}.${ext}` });
    },

    async logoCandidates(promotionId, query) {
      const promotion = requirePromotion(promotionId);
      const keys = settings().metadata;
      const recentEvents = store.listEvents({ promotionId: promotion.id, to: clock().toISOString().slice(0, 10), limit: 4 });
      return logoCandidates({
        promotion, source: resolve(promotion).source, query, recentEvents,
        tsdbApiKey: keys.tsdbApiKey, tmdbApiKey: keys.tmdbApiKey,
      });
    },

    // Queue promotions for refresh (all followed ones when none are given).
    // Returns immediately; progress is in status().
    refresh(ids) {
      const meta = store.listPromotionMeta();
      const wanted = (ids && ids.length ? ids : promotions.all.filter((p) => meta[p.id]?.followed).map((p) => p.id))
        .filter((id) => promotions.getById(id));
      for (const id of wanted) if (id !== job.current && !job.queue.includes(id)) job.queue.push(id);
      drain();
      return manager.status();
    },

    status() {
      return {
        running: job.running, current: job.current, queued: [...job.queue],
        startedAt: job.startedAt, finishedAt: job.finishedAt || store.getSetting('metadataRefreshedAt', null), results: job.results,
      };
    },

    // Called from the worker tick: refresh followed promotions when the
    // configured interval has passed.
    maybeAutoRefresh() {
      const hours = Number(settings().metadata.refreshHours) || 0;
      if (!hours || job.running) return;
      const last = Date.parse(store.getSetting('metadataRefreshedAt', '') || '') || 0;
      if (clock().getTime() - last >= hours * 3600000) manager.refresh();
    },

    async waitForIdle() {
      while (job.running) await new Promise((r) => setTimeout(r, 25));
    },

    // --- providers -------------------------------------------------------
    createProvider(input) {
      const verdict = providers.validateDefinition(input || {}, { exists: (id) => allProviders().some((p) => p.id === id) });
      if (!verdict.ok) throw new MetadataError(verdict.error);
      store.saveProvider(verdict.definition);
      return verdict.definition;
    },

    deleteProvider(id) {
      if (providers.SYSTEM_SOURCES.some((p) => p.id === id)) throw new MetadataError('Shipped providers cannot be deleted.');
      store.deleteProvider(id);
    },

    async preview(input) {
      applyKeys();
      let definition;
      if (input?.providerId) {
        definition = allProviders().find((p) => p.id === input.providerId);
        if (!definition) throw new MetadataError('Provider not found.', 404);
      } else {
        const verdict = providers.validateDefinition({ ...input, id: input?.id || 'preview', name: input?.name || 'Preview' });
        if (!verdict.ok) throw new MetadataError(verdict.error);
        definition = verdict.definition;
      }
      try {
        return await preview.preview(definition, {});
      } catch (error) {
        return { ok: false, error: error.message };
      }
    },
  };
  return manager;
}
