// Ported from SeriousSportSync (Monkfish1337/Serioussportsync @ 0706d4d),
// scripts/refresh.js: per-promotion source dispatch, normalisation and scope.
// Replayarr changes: only the sources its built-in promotions use are wired
// (TheSportsDB, ESPN, MLB, UEFA, football-data.org, API-Football, TMDB, ONE,
// AEW and custom JSON feeds); keys come
// from ./config.cjs; results are returned instead of written to SSS's store.
'use strict';

const tsdb = require('./sources/thesportsdb.cjs');
const tsdbKnownEvents = require('./tsdb-known-events.cjs');
const transform = require('./transform.cjs');
const config = require('./config.cjs');
const onefc = require('./sources/onefc.cjs');
const mlb = require('./sources/mlb.cjs');
const aew = require('./sources/aew.cjs');
const espn = require('./sources/espn.cjs');
const footballData = require('./sources/football-data.cjs');
const uefa = require('./sources/uefa.cjs');
const tmdb = require('./sources/tmdb.cjs');
const apiFootball = require('./sources/api-football.cjs');
const jsonFeed = require('./sources/json-feed.cjs');

function withinWindow(ev) {
  if (!ev || !ev.date) return false;
  const back = Math.max(0, config.eventWindowDaysBack | 0);
  const ahead = Math.max(0, config.eventWindowDaysAhead | 0);
  if (back === 0 && ahead === 0) return true;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const evDate = new Date(ev.date + 'T00:00:00Z');
  const diffDays = (evDate - today) / (1000 * 60 * 60 * 24);
  if (diffDays >= 0) return diffDays <= ahead;
  return -diffDays <= back;
}

function inScope(ev, promotion) {
  if (promotion && promotion.metadataStartDate && (!ev || !ev.date || ev.date < promotion.metadataStartDate)) {
    return false;
  }
  if (promotion && typeof promotion.eventScope === 'function') {
    return promotion.eventScope(ev);
  }
  return withinWindow(ev);
}

function activeSeasons(promotion) {
  if (Array.isArray(config.tsdb.seasons) && config.tsdb.seasons.length > 0) {
    const floorYear = Number(String((promotion && promotion.metadataStartDate) || '').slice(0, 4));
    return floorYear
      ? config.tsdb.seasons.filter((season) => Number(String(season).slice(-4)) >= floorYear)
      : config.tsdb.seasons;
  }
  // Earliest = max(today - EVENT_WINDOW_DAYS_BACK, EVENT_WINDOW_START_DATE).
  // 0.31.1: the daysBack window alone misses everything before
  // (today - daysBack) even when EVENT_WINDOW_START_DATE is older — which
  // meant the 2025-01-01 floor never actually pulled 2025 seasons. Now
  // both bounds participate.
  const back = Math.max(0, config.eventWindowDaysBack | 0);
  const ahead = Math.max(0, config.eventWindowDaysAhead | 0);
  const today = new Date();
  let earliest = new Date(today); earliest.setDate(earliest.getDate() - back);
  // 0.31.1: same default as lib/promotions.js so the env var being unset
  // doesn't silently fall back to a daysBack-only window. Both files should
  // agree on the catalog floor.
  const windowStart = process.env.EVENT_WINDOW_START_DATE || '2025-01-01';
  if (/^\d{4}-\d{2}-\d{2}$/.test(windowStart)) {
    const startDate = new Date(windowStart + 'T00:00:00Z');
    if (startDate < earliest) earliest = startDate;
  }
  if (promotion && promotion.metadataStartDate) {
    const floor = new Date(promotion.metadataStartDate + 'T00:00:00Z');
    earliest = floor;
  }
  const latest = new Date(today); latest.setDate(latest.getDate() + ahead);
  const years = new Set();
  for (let y = earliest.getUTCFullYear(); y <= latest.getUTCFullYear(); y++) years.add(String(y));
  return Array.from(years).sort();
}


function sourceStartDate(promotion, dateFrom) {
  return promotion && promotion.metadataStartDate || dateFrom;
}


function windowRange(promotion) {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const from = new Date(today); from.setUTCDate(from.getUTCDate() - Math.max(0, config.eventWindowDaysBack | 0));
  const to = new Date(today); to.setUTCDate(to.getUTCDate() + Math.max(0, config.eventWindowDaysAhead | 0));
  return { dateFrom: sourceStartDate(promotion, from.toISOString().slice(0, 10)), dateTo: to.toISOString().slice(0, 10) };
}

// Raw records for one promotion from its schedule source. Throws when the
// source cannot be used (for example a missing API key), so the caller can
// report it per promotion.
async function fetchRaw(promotion, log, sourceCache) {
  const source = promotion.source || {};
  if (source.type === 'thesportsdb') {
    const seasons = activeSeasons(promotion);
    log('  TSDB seasons: ' + seasons.join(', '));
    const knownEvents = promotion.weeklyShow ? []
      : ((source.knownEvents && source.knownEvents.length) ? source.knownEvents : tsdbKnownEvents.knownEventsFor(source.leagueId));
    const weeklySeries = String(source.leagueId) === '4563'
      ? ['Dynamite', 'Collision']
      : (String(source.leagueId) === '4444' ? ['RAW', 'SmackDown', 'NXT'] : []);
    const options = {
      leagueId: source.leagueId, seasons, knownEvents, weeklySeries,
      startDate: promotion.metadataStartDate,
      dateOrderedRounds: ['4444', '4563'].includes(String(source.leagueId)),
      log,
    };
    // WWE's weekly shows share the WWE league; fetch it once per refresh.
    const key = JSON.stringify({ leagueId: options.leagueId, seasons, knownEvents, weeklySeries, startDate: options.startDate });
    if (sourceCache.has(key)) return sourceCache.get(key);
    const raw = await tsdb.fetchAll(options);
    sourceCache.set(key, raw);
    return raw;
  }
  if (source.type === 'onefc') return onefc.fetchAll({ log });
  if (source.type === 'aew') return aew.fetchAll({ log });
  if (source.type === 'mlb') return mlb.fetchAll({ ...windowRange(promotion), log });
  if (source.type === 'espn') {
    const range = windowRange(promotion);
    const key = 'espn:' + source.league + ':' + range.dateFrom + ':' + range.dateTo;
    if (sourceCache.has(key)) return sourceCache.get(key);
    const raw = await espn.fetchAll({ league: source.league, ...range, log });
    sourceCache.set(key, raw);
    return raw;
  }
  if (source.type === 'uefa') {
    const range = windowRange(promotion);
    return uefa.fetchAll({ competitionId: source.competitionId, seasons: uefa.seasonsForRange(range.dateFrom, range.dateTo), ...range, log });
  }
  if (source.type === 'football-data') {
    if (!config.footballData.apiKey) throw new Error('needs a football-data.org API key (Metadata › Settings)');
    if (source.teamId) {
      return footballData.fetchTeamMatches({ teamId: source.teamId, ...windowRange(promotion), apiKey: config.footballData.apiKey, log });
    }
    return footballData.fetchAll({ competitionId: source.competitionId, seasons: activeSeasons(promotion), apiKey: config.footballData.apiKey, log });
  }
  if (source.type === 'tmdb') {
    if (!config.tmdb.apiKey) throw new Error('needs a TMDB API key (Metadata › Settings)');
    const tvIds = Array.isArray(source.tvIds) && source.tvIds.length ? source.tvIds : [source.tvId];
    const range = typeof promotion.sourceDateRange === 'function' ? promotion.sourceDateRange() : {};
    const raw = [];
    for (const tvId of tvIds) raw.push(...await tmdb.fetchAll({ tvId, apiKey: config.tmdb.apiKey, log, dateFrom: range.dateFrom, dateTo: range.dateTo }));
    return raw;
  }
  if (source.type === 'api-football') {
    if (!config.apiFootball.apiKey) throw new Error('needs an API-Football key (Metadata › Settings)');
    const range = windowRange(promotion);
    return apiFootball.fetchAll({ leagueId: source.leagueId, seasons: apiFootball.seasonsForRange(range.dateFrom, range.dateTo), ...range, apiKey: config.apiFootball.apiKey, log });
  }
  if (source.type === 'json-feed') return jsonFeed.fetchAll(source, { log });
  throw new Error(`schedule source "${source.type}" is not supported`);
}

function normalizeRecord(raw, promotion) {
  const type = promotion && promotion.source && promotion.source.type;
  if (type === 'thesportsdb') return transform.fromTsdb(raw, promotion);
  if (type === 'football-data') return transform.fromFootballData(raw, promotion);
  if (type === 'uefa') return transform.fromUefa(raw, promotion);
  if (type === 'tmdb') return transform.fromTmdb(raw, promotion);
  if (type === 'api-football') return transform.fromApiFootball(raw, promotion);
  if (['onefc', 'mlb', 'espn', 'aew', 'json-feed'].includes(type)) return transform.fromWiki(raw, promotion);
  return null;
}

// One promotion's events, as SSS's refresh builds them: normalised, filtered
// by the promotion and the date window, sanity-checked across the batch, and
// with any events the promotion derives (e.g. MotoGP qualifying) added.
async function fetchPromotionEvents(promotion, { log = () => {}, sourceCache = new Map() } = {}) {
  const raw = await fetchRaw(promotion, log, sourceCache);
  let events = [];
  const seen = new Set();
  for (const record of Array.isArray(raw) ? raw : []) {
    const event = normalizeRecord(record, promotion);
    if (!event || seen.has(event.id)) continue;
    if (typeof promotion.includeEvent === 'function' && !promotion.includeEvent(event, config)) continue;
    if (!inScope(event, promotion)) continue;
    seen.add(event.id);
    events.push(event);
  }
  if (typeof promotion.sanitizeEvents === 'function') events = promotion.sanitizeEvents(events, log) || [];
  if (typeof promotion.expandEvents === 'function') {
    for (const extra of promotion.expandEvents(events) || []) {
      if (extra && extra.id && !seen.has(extra.id) && inScope(extra, promotion)) {
        seen.add(extra.id);
        events.push(extra);
      }
    }
  }
  return events;
}

module.exports = { fetchPromotionEvents, normalizeRecord, inScope, activeSeasons };
