import { requestJson, ServiceError } from '../http.js';

// Read-only client for an SSS install's existing Stremio addon endpoints
// (manifest, catalog, meta). Replayarr never writes to SSS; the install URL
// is the per-user manifest URL shown on the SSS account page.
const SERVICE = 'SSS';
const MAX_PAGES = 40;

export function addonBase(manifestUrl) {
  const url = String(manifestUrl || '').trim();
  if (!/^https?:\/\/.+\/manifest\.json(?:\?.*)?$/i.test(url)) {
    throw new ServiceError(SERVICE, 'set the SSS install URL (it ends in /manifest.json)');
  }
  return url.replace(/\/manifest\.json(?:\?.*)?$/i, '');
}

const isoDate = (value) => (/^(\d{4}-\d{2}-\d{2})/.exec(String(value || '')) || [])[1] || null;

export async function fetchManifest(config) {
  const base = addonBase(config.manifestUrl);
  const { body } = await requestJson(SERVICE, `${base}/manifest.json`);
  return body;
}

// Every event in the install's catalogs within the date window, deduplicated
// by id. Catalogs overlap (upcoming/recent, league/team), which is expected.
export async function listEvents(config, { today = new Date() } = {}) {
  const base = addonBase(config.manifestUrl);
  const manifest = await fetchManifest(config);
  const from = new Date(today.getTime() - (config.lookbackDays || 30) * 86400000).toISOString().slice(0, 10);
  const to = new Date(today.getTime() + (config.lookaheadDays || 7) * 86400000).toISOString().slice(0, 10);
  const events = new Map();
  for (const catalog of manifest.catalogs || []) {
    if (!catalog?.id || !catalog?.type) continue;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const skip = page * 100;
      const path = skip
        ? `/catalog/${encodeURIComponent(catalog.type)}/${encodeURIComponent(catalog.id)}/skip=${skip}.json`
        : `/catalog/${encodeURIComponent(catalog.type)}/${encodeURIComponent(catalog.id)}.json`;
      const { body } = await requestJson(SERVICE, base + path);
      const metas = Array.isArray(body?.metas) ? body.metas : [];
      let added = 0;
      for (const meta of metas) {
        const date = isoDate(meta.releaseInfo || meta.released);
        if (!meta?.id || !meta.name || !date || events.has(meta.id)) continue;
        added += 1;
        if (date < from || date > to) continue;
        events.set(meta.id, { id: meta.id, type: catalog.type, title: meta.name, date, catalog: catalog.name || catalog.id });
      }
      if (!metas.length || !added) break;
    }
  }
  return [...events.values()];
}

// The detail record carries what the catalog omits: search aliases and the
// UTC start. Called when an event is requested, so the matcher has them.
export async function fetchEventDetail(config, id, type = 'movie') {
  const base = addonBase(config.manifestUrl);
  const { body } = await requestJson(SERVICE, `${base}/meta/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`);
  const meta = body?.meta;
  if (!meta) return null;
  const released = meta.released ? new Date(meta.released) : null;
  const valid = released && !Number.isNaN(released.getTime());
  return {
    title: meta.name,
    date: valid ? released.toISOString().slice(0, 10) : isoDate(meta.releaseInfo),
    time: valid ? released.toISOString().slice(11, 16) : null,
    aliases: Array.isArray(meta.searchHints) ? meta.searchHints.map(String).filter(Boolean) : [],
  };
}
