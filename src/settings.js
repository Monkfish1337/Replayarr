export const DEFAULTS = {
  sss: { manifestUrl: '', lookbackDays: 30, lookaheadDays: 7 },
  prowlarr: { url: '', apiKey: '', maxQueries: 6, timeoutMs: 20000 },
  qbittorrent: { url: '', apiKey: '', username: '', password: '', category: 'replayarr' },
  sabnzbd: { url: '', apiKey: '', category: 'replayarr' },
  library: {
    root: '',
    mode: 'hardlink',
    naming: '{promotion}/Season {year}/{promotion} - {date} - {title} [{quality}]',
    minSizeMb: 100,
  },
  // Download clients often run in their own container and report paths as
  // they see them. Each mapping rewrites a remote prefix to the local one.
  pathMappings: [],
  preferences: { protocol: 'any', minSeeders: 1 },
};

const SECRETS = [['prowlarr', 'apiKey'], ['qbittorrent', 'apiKey'], ['qbittorrent', 'password'], ['sabnzbd', 'apiKey']];
export const MASK = '••••••••';

export function loadSettings(store) {
  const saved = store.getSetting('config', {});
  const out = {};
  for (const [section, defaults] of Object.entries(DEFAULTS)) {
    out[section] = Array.isArray(defaults)
      ? (Array.isArray(saved[section]) ? saved[section] : defaults)
      : { ...defaults, ...(saved[section] || {}) };
  }
  return out;
}

// What the browser sees: secrets are replaced with a mask so they can be
// shown as "set" without leaving the server.
export function publicSettings(settings) {
  const copy = structuredClone(settings);
  for (const [section, key] of SECRETS) copy[section][key] = copy[section][key] ? MASK : '';
  return copy;
}

export function saveSettings(store, incoming) {
  const current = loadSettings(store);
  const next = {};
  for (const [section, defaults] of Object.entries(DEFAULTS)) {
    const value = incoming?.[section];
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
      next[section][key] = typeof defaults[key] === 'number' ? Number(value[key]) || defaults[key] : String(value[key] ?? '').trim();
    }
  }
  if (!['hardlink', 'copy', 'move'].includes(next.library.mode)) next.library.mode = DEFAULTS.library.mode;
  if (!['any', 'torrent', 'usenet'].includes(next.preferences.protocol)) next.preferences.protocol = 'any';
  store.setSetting('config', next);
  return next;
}

function cleanMappings(list) {
  return list
    .map((item) => ({ remote: String(item?.remote || '').trim(), local: String(item?.local || '').trim() }))
    .filter((item) => item.remote && item.local);
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
