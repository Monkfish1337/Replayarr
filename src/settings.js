import { randomUUID } from 'node:crypto';
import { DEFAULT_PROFILE, normaliseProfile } from './profiles.js';

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
  // Quality profiles (see profiles.js); promotions pick one, else the first.
  profiles: [DEFAULT_PROFILE],
  // searchSeconds: a search ends when every indexer has finished or this
  // long has passed, whichever comes first.
  preferences: { protocol: 'any', minSeeders: 1, searchSeconds: 60 },
};

// Fields each indexer type keeps, with defaults. Every entry also has id,
// type, name and enabled.
// Query lists follow SSS: torrent indexers get the promotion's whole
// torrent query list (about 60), Easynews a few distinct spellings. All
// indexers search at once, within the preferences' time limit. Priority
// works like Sonarr's: lower first. It decides which indexer is credited
// with a release several report, and the order in the log.
export const INDEXER_TYPES = {
  prowlarr: { url: '', apiKey: '', priority: 30, maxQueries: 60, timeoutMs: 20000 },
  bitmagnet: { url: '', priority: 10, maxQueries: 60, limit: 100, timeoutMs: 15000 },
  easynews: { username: '', password: '', downloadFolder: '', priority: 20, maxQueries: 6, timeoutMs: 20000 },
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
const ZERO_ALLOWED = new Set(['minSeeders']);

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
  out.profiles = cleanProfiles(out.profiles);
  if (out.library.naming === OLD_DEFAULT_NAMING) out.library.naming = DEFAULTS.library.naming;
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
    if (section === 'profiles') {
      next.profiles = Array.isArray(value) ? cleanProfiles(value) : current.profiles;
      continue;
    }
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
  next.preferences.searchSeconds = Math.min(600, Math.max(10, Math.round(Number(next.preferences.searchSeconds) || DEFAULTS.preferences.searchSeconds)));
  store.setSetting('config', next);
  return next;
}

// The incoming list is the new list. A masked secret keeps the stored value
// of the indexer with the same id.
// Unique ids, and never an empty list: something must decide what to grab.
function cleanProfiles(list) {
  const seen = new Set();
  const profiles = (Array.isArray(list) ? list : []).map(normaliseProfile).filter((p) => p && !seen.has(p.id) && seen.add(p.id));
  return profiles.length ? profiles : [{ ...DEFAULT_PROFILE, qualities: [...DEFAULT_PROFILE.qualities] }];
}

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
