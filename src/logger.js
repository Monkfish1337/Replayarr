import { createWriteStream, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Troubleshooting log, like Sonarr's System › Logs. Every entry has a level,
// a component (search, download, import, http, metadata...) and a message,
// optionally with details. Entries are kept in memory for the Logs page and,
// once configured by the server, written to rotating files and stdout (so
// `docker logs` / Dozzle show them too). Secrets are scrubbed from every entry.
export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_ENTRIES = 5000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const KEEP_FILES = 3;

const state = {
  level: LEVELS.info,
  entries: [],
  nextId: 1,
  console: false,
  dir: null,
  stream: null,
  bytes: 0,
};

// Credentials must never reach a log line, whatever a caller passes in.
const SECRET_PATTERNS = [
  [/([?&](?:api[_-]?key|apikey|token|access_token|password|passkey|secret|sig)=)[^&\s"']+/gi, '$1<redacted>'],
  [/(\b(?:x-api-key|x-emby-token|authorization|cookie)\b["']?\s*[:=]\s*["']?)(?:(?:basic|bearer)\s+)?[^\s,"'}]+/gi, '$1<redacted>'],
  [/(\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1<redacted>@'],
  [/(\/u\/[^/\s]+\/)[A-Za-z0-9_-]{12,}(\/)/g, '$1<redacted>$2'],
  [/\b(qbt_)[A-Za-z0-9]{8,}/g, '$1<redacted>'],
  // A paid TheSportsDB key sits in the URL path (the free key 123 is public).
  [/(thesportsdb\.com\/api\/v\d\/json\/)(?!123\/)[^/\s]+/gi, '$1<redacted>'],
];
export function redact(text) {
  let out = String(text ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function detailText(details) {
  if (details === undefined || details === null) return '';
  if (details instanceof Error) return details.stack || details.message;
  if (typeof details !== 'object') return String(details);
  return Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join(' ');
}

export function formatEntry(entry) {
  const line = `${entry.time} ${entry.level.toUpperCase().padEnd(5)} [${entry.component}] ${entry.message}`;
  return entry.details ? `${line} | ${entry.details}` : line;
}

function openStream() {
  const file = join(state.dir, 'replayarr.txt');
  try { state.bytes = statSync(file).size; } catch { state.bytes = 0; }
  state.stream = createWriteStream(file, { flags: 'a' });
  state.stream.on('error', () => { state.stream = null; });
}

function rotate() {
  state.stream?.end();
  const base = join(state.dir, 'replayarr');
  for (let i = KEEP_FILES - 1; i >= 1; i -= 1) {
    try { renameSync(i === 1 ? `${base}.txt` : `${base}.${i - 1}.txt`, `${base}.${i}.txt`); } catch { /* missing is fine */ }
  }
  openStream();
}

function write(level, component, message, details) {
  if (LEVELS[level] < state.level) return;
  const entry = {
    id: state.nextId++,
    time: new Date().toISOString(),
    level,
    component,
    message: redact(message),
    details: redact(detailText(details)),
  };
  state.entries.push(entry);
  if (state.entries.length > MAX_ENTRIES) state.entries.splice(0, state.entries.length - MAX_ENTRIES);
  const line = formatEntry(entry);
  if (state.console) (level === 'error' ? console.error : console.log)(line);
  if (state.stream) {
    state.stream.write(line + '\n');
    state.bytes += Buffer.byteLength(line) + 1;
    if (state.bytes > MAX_FILE_BYTES) rotate();
  }
}

// A logger for one component: log.info('message', { key: value }).
export function logger(component) {
  return {
    debug: (message, details) => write('debug', component, message, details),
    info: (message, details) => write('info', component, message, details),
    warn: (message, details) => write('warn', component, message, details),
    error: (message, details) => write('error', component, message, details),
  };
}

export function configureLogging({ level, dir, console: toConsole } = {}) {
  if (level) setLogLevel(level);
  if (toConsole !== undefined) state.console = !!toConsole;
  if (dir && dir !== state.dir) {
    try {
      mkdirSync(dir, { recursive: true });
      state.stream?.end();
      state.dir = dir;
      openStream();
    } catch (error) {
      write('warn', 'system', `Cannot write log files to ${dir}`, error.message);
    }
  }
}

export function setLogLevel(level) {
  if (LEVELS[level]) state.level = LEVELS[level];
}

export function logLevel() {
  return Object.keys(LEVELS).find((key) => LEVELS[key] === state.level);
}

// Newest first. Filters: minimum level, component, text, and entries after an id.
export function listLogs({ level = 'debug', component = '', q = '', after = 0, limit = 500 } = {}) {
  const min = LEVELS[level] || LEVELS.debug;
  const needle = String(q || '').toLowerCase();
  const out = [];
  for (let i = state.entries.length - 1; i >= 0 && out.length < Math.min(Number(limit) || 500, MAX_ENTRIES); i -= 1) {
    const entry = state.entries[i];
    if (entry.id <= Number(after || 0)) break;
    if (LEVELS[entry.level] < min) continue;
    if (component && entry.component !== component) continue;
    if (needle && !`${entry.message} ${entry.details}`.toLowerCase().includes(needle)) continue;
    out.push(entry);
  }
  return out;
}

export function logComponents() {
  return [...new Set(state.entries.map((entry) => entry.component))].sort();
}

export function clearLogs() {
  state.entries = [];
}
