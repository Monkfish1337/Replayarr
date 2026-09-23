import { randomUUID } from 'node:crypto';

export const DEFAULTS = {
  // Schedule metadata. TheSportsDB's free key is public; the others are
  // needed only by promotions whose provider uses that service.
  metadata: {
    tsdbApiKey: '123', footballDataApiKey: '', apiFootballApiKey: '', tmdbApiKey: '',
    daysBack: 30, daysAhead: 90, refreshHours: 6,
  },
  // Search sources, like Sonarr's indexer list. See INDEXER_TYPES.
  indexers: [],
  // savePath is where qBittorrent saves Replayarr's torrents, as qBittorrent
  // sees it; blank uses the category's own save path.
  qbittorrent: { url: '', apiKey: '', username: '', password: '', category: 'replayarr', savePath: '' },
  sabnzbd: { url: '', apiKey: '', category: 'replayarr' },
  library: {
    root: '',
    mode: 'hardlink',
    naming: '{promotion}/Season {season}/{promotion} - S{season}E{episode} - {title} [{quality}]',
    minSizeMb: 100,
    // Kodi-style .nfo files and artwork next to each event, for Jellyfin.
    writeMetadata: 'yes',
  },
  // Told to rescan after imports and renames.
  jellyfin: { url: '', apiKey: '' },
  // System › Logs detail: 'info' normally, 'debug' when troubleshooting.
  logging: { level: 'info' },
  // Download clients often run in their own container and report paths as
  // they see them. Each mapping rewrites a remote prefix to the local one.
  pathMappings: [],
  // stopAtFirstMatch: once a release matches, skip an indexer's remaining
  // queries and the lower-priority indexers. 'no' searches everything.
  // minSearchSeconds: a match only stops the search after this long.
  preferences: { protocol: 'any', minSeeders: 1, stopAtFirstMatch: 'yes', minSearchSeconds: 60, searchPlan: 2 },
};

// Fields each indexer type keeps, with defaults. Every entry also has id,
// type, name and enabled.
// Query budgets follow SSS: torrent indexers get the promotion's whole
// torrent query list (about 60), stopping early once a release matches or
// searchMinutes runs out; Easynews gets a few distinct spellings.
// Priority works like Sonarr's: lower is searched first, and once one
// indexer finds a match the ones after it are not asked. The defaults put the
// fast ones first: Bitmagnet (self-hosted), Easynews, then Prowlarr (a
// fan-out to remote trackers).
export const INDEXER_TYPES = {
  prowlarr: { url: '', apiKey: '', priority: 30, maxQueries: 60, searchMinutes: 5, timeoutMs: 20000 },
  bitmagnet: { url: '', priority: 10, maxQueries: 60, searchMinutes: 2, limit: 100, timeoutMs: 15000 },
  easynews: { username: '', password: '', downloadFolder: '', priority: 20, maxQueries: 6, searchMinutes: 3, timeoutMs: 20000 },
};
// Earlier defaults sent only the first few queries, which missed releases
// SSS found. Indexers saved with them move to the current defaults.
const OLD_QUERY_DEFAULTS = { prowlarr: 6, bitmagnet: 12, easynews: 4 };
const QUERY_PLAN = 2;
function upgradeQueryLimit(item) {
  if (!item || Number(item.queryPlan) === QUERY_PLAN || Number(item.maxQueries) !== OLD_QUERY_DEFAULTS[item.type]) return item;
  return { ...item, maxQueries: INDEXER_TYPES[item.type].maxQueries };
}
const INDEXER_NAMES = { prowlarr: 'Prowlarr', bitmagnet: 'Bitmagnet', easynews: 'Easynews' };
const INDEXER_SECRETS = ['apiKey', 'password'];

// The first default naming pattern; installs still on it move to the current one.
const OLD_DEFAULT_NAMING = '{promotion}/Season {year}/{promotion} - {date} - {title} [{quality}]';

const SECRETS = [['jellyfin', 'apiKey'], ['qbittorrent', 'apiKey'], ['qbittorrent', 'password'], ['sabnzbd', 'apiKey'],
  ['metadata', 'footballDataApiKey'], ['metadata', 'apiFootballApiKey'], ['metadata', 'tmdbApiKey']];
export const MASK = '••••••••';
// Number settings where 0 is a real choice rather than "use the default".
const ZERO_ALLOWED = new Set(['minSearchSeconds', 'minSeeders']);

export function loadSettings(store) {
  const saved = store.getSetting('config', {});
  const out = {};
  for (const [section, defaults] of Object.entries(DEFAULTS)) {
    out[section] = Array.isArray(defaults)
      ? (Array.isArray(saved[section]) ? saved[section] : defaults)
      : { ...defaults, ...(saved[section] || {}) };
  }
  // Before multiple indexers, Prowlarr was a single settings section.
  if (!Array.isArray(saved.indexers) && saved.prowlarr?.url) {
    out.indexers = [normaliseIndexer({ id: 'prowlarr', type: 'prowlarr', ...saved.prowlarr })];
  }
  out.indexers = out.indexers.map(upgradeQueryLimit).map(normaliseIndexer).filter(Boolean);
  if (out.library.naming === OLD_DEFAULT_NAMING) out.library.naming = DEFAULTS.library.naming;
  // The minimum search time first shipped as 30 seconds; installs that saved
  // it move to the current default once.
  if (Number(saved.preferences?.searchPlan) !== 2 && Number(out.preferences.minSearchSeconds) === 30) out.preferences.minSearchSeconds = DEFAULTS.preferences.minSearchSeconds;
  out.preferences.searchPlan = 2;
  return out;
}

export function normaliseIndexer(item) {
  const defaults = INDEXER_TYPES[item?.type];
  if (!defaults) return null;
  const entry = {
    id: String(item.id || randomUUID()),
    type: item.type,
    name: String(item.name || '').trim() || INDEXER_NAMES[item.type],
    enabled: item.enabled !== false && item.enabled !== 'false',
  };
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = item[key];
    entry[key] = typeof fallback === 'number'
      ? (Number(value) > 0 ? Number(value) : fallback)
      : String(value ?? fallback).trim();
  }
  entry.queryPlan = QUERY_PLAN;
  entry.priority = Math.min(50, Math.round(entry.priority));
  entry.maxQueries = Math.min(100, Math.round(entry.maxQueries));
  return entry;
}

// What the browser sees: secrets are replaced with a mask so they can be
// shown as "set" without leaving the server.
export function publicSettings(settings) {
  const copy = structuredClone(settings);
  for (const [section, key] of SECRETS) copy[section][key] = copy[section][key] ? MASK : '';
  for (const indexer of copy.indexers) {
    for (const key of INDEXER_SECRETS) if (key in indexer) indexer[key] = indexer[key] ? MASK : '';
  }
  return copy;
}

export function saveSettings(store, incoming) {
  const current = loadSettings(store);
  const next = {};
  for (const [section, defaults] of Object.entries(DEFAULTS)) {
    const value = incoming?.[section];
    if (section === 'indexers') {
      next.indexers = Array.isArray(value) ? mergeIndexers(current.indexers, value) : current.indexers;
      continue;
    }
    if (Array.isArray(defaults)) {
      next[section] = Array.isArray(value) ? cleanMappings(value) : current[section];
      continue;
    }
    next[section] = { ...current[section] };
    if (!value || typeof value !== 'object') continue;
    for (const key of Object.keys(defaults)) {
      if (!(key in value)) continue;
      const isSecret = SECRETS.some(([s, k]) => s === section && k === key);
      if (isSecret && value[key] === MASK) continue;
      const number = Number(value[key]);
      next[section][key] = typeof defaults[key] !== 'number' ? String(value[key] ?? '').trim()
        : ZERO_ALLOWED.has(key) && value[key] !== '' && Number.isFinite(number) ? number
          : number || defaults[key];
    }
  }
  // Older clients (and the single-Prowlarr API) send a `prowlarr` section:
  // it updates the first Prowlarr indexer, or creates one.
  if (incoming?.prowlarr && typeof incoming.prowlarr === 'object' && !Array.isArray(incoming.indexers)) {
    const existing = next.indexers.find((i) => i.type === 'prowlarr');
    next.indexers = mergeIndexers(next.indexers, [
      ...next.indexers.filter((i) => i !== existing),
      { ...(existing || { id: 'prowlarr', type: 'prowlarr' }), ...incoming.prowlarr },
    ]);
  }
  if (!['hardlink', 'copy', 'move'].includes(next.library.mode)) next.library.mode = DEFAULTS.library.mode;
  if (!['yes', 'no'].includes(next.library.writeMetadata)) next.library.writeMetadata = 'yes';
  if (!['debug', 'info', 'warn', 'error'].includes(next.logging.level)) next.logging.level = 'info';
  if (!['any', 'torrent', 'usenet'].includes(next.preferences.protocol)) next.preferences.protocol = 'any';
  if (!['yes', 'no'].includes(next.preferences.stopAtFirstMatch)) next.preferences.stopAtFirstMatch = 'yes';
  next.preferences.minSearchSeconds = Math.min(600, Math.max(0, Math.round(Number(next.preferences.minSearchSeconds) || 0)));
  store.setSetting('config', next);
  return next;
}

// The incoming list is the new list. A masked secret keeps the stored value
// of the indexer with the same id.
function mergeIndexers(current, incoming) {
  return incoming.map((item) => {
    const before = current.find((i) => i.id === item?.id);
    const merged = { ...item };
    for (const key of INDEXER_SECRETS) if (merged[key] === MASK) merged[key] = before?.[key] ?? '';
    return normaliseIndexer(merged);
  }).filter(Boolean);
}

function cleanMappings(list) {
  return list
    .map((item) => ({ remote: String(item?.remote || '').trim(), local: String(item?.local || '').trim() }))
    .filter((item) => item.remote && item.local);
}

export function indexerReady(indexer) {
  if (!indexer?.enabled) return false;
  if (indexer.type === 'prowlarr') return !!(indexer.url && indexer.apiKey);
  if (indexer.type === 'bitmagnet') return !!indexer.url;
  if (indexer.type === 'easynews') return !!(indexer.username && indexer.password);
  return false;
}

export function mapRemotePath(settings, remotePath) {
  const value = String(remotePath || '');
  const sorted = [...settings.pathMappings].sort((a, b) => b.remote.length - a.remote.length);
  for (const { remote, local } of sorted) {
    const prefix = remote.replace(/[\\/]+$/, '');
    if (value === prefix || value.startsWith(prefix + '/') || value.startsWith(prefix + '\\')) {
      return local.replace(/[\\/]+$/, '') + value.slice(prefix.length);
    }
  }
  return value;
}
