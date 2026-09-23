// Metadata providers: where a promotion's schedule comes from. Shipped
// providers and the validation for user-created ones are ported from
// SeriousSportSync (Monkfish1337/Serioussportsync @ 0706d4d),
// lib/metadata-sources.js; Replayarr adds ESPN, AEW and football-data entries
// for its built-in promotions. Custom providers and assignments live in
// Replayarr's database (see service.js).
'use strict';

const jsonFeed = require('./sources/json-feed.cjs');

const ID_RE = /^[a-z0-9_-]{2,50}$/;
const SYSTEM_SOURCES = Object.freeze([
  { id: 'tsdb-ufc', name: 'TheSportsDB · UFC', system: true, source: { type: 'thesportsdb', leagueId: '4443' } },
  { id: 'one-official', name: 'Official ONE Championship', system: true, source: { type: 'onefc' } },
  { id: 'tsdb-wwe', name: 'TheSportsDB · WWE', system: true, source: { type: 'thesportsdb', leagueId: '4444' } },
  { id: 'tsdb-aew', name: 'TheSportsDB · AEW', system: true, source: { type: 'thesportsdb', leagueId: '4563' } },
  { id: 'tsdb-f1', name: 'TheSportsDB · Formula 1', system: true, source: { type: 'thesportsdb', leagueId: '4370' } },
  { id: 'tsdb-boxing', name: 'TheSportsDB · Boxing', system: true, source: { type: 'thesportsdb', leagueId: '4445' } },
  { id: 'tsdb-motogp', name: 'TheSportsDB · MotoGP', system: true, source: { type: 'thesportsdb', leagueId: '4407' } },
  { id: 'tmdb-motd', name: 'TMDB · Match of the Day', system: true, source: { type: 'tmdb', tvIds: ['224', '3231'] } },
  { id: 'uefa-ucl', name: 'Official UEFA · Champions League', system: true, source: { type: 'uefa', competitionId: '1' } },
  { id: 'aew-official', name: 'Official AEW schedule', system: true, source: { type: 'aew' } },
  { id: 'mlb-official', name: 'Official MLB schedule', system: true, source: { type: 'mlb' } },
  { id: 'espn-nfl', name: 'ESPN · NFL', system: true, source: { type: 'espn', league: 'nfl' } },
  { id: 'espn-nba', name: 'ESPN · NBA', system: true, source: { type: 'espn', league: 'nba' } },
  { id: 'football-data-pl', name: 'football-data.org · Premier League', system: true, source: { type: 'football-data', competitionId: 'PL' } },
]);

function validateDefinition(input, opts) {
  opts = opts || {};
  const id = String(input.id || '').toLowerCase().trim();
  const name = String(input.name || '').trim();
  const type = String(input.type || '').trim();
  if (!ID_RE.test(id)) return { ok: false, error: 'Source ID must be 2-50 lowercase characters [a-z0-9_-]' };
  if (!name || name.length > 80) return { ok: false, error: 'Source name is required (max 80 characters)' };
  if (!opts.allowExistingId && typeof opts.exists === 'function' && opts.exists(id)) return { ok: false, error: 'Metadata source ID already exists: ' + id };
  let source;
  if (type === 'thesportsdb') {
    const leagueId = String(input.leagueId || '').trim();
    if (!/^\d+$/.test(leagueId)) return { ok: false, error: 'TheSportsDB league ID must be numeric' };
    source = { type, leagueId };
  } else if (type === 'football-data') {
    const teamId = String(input.teamId || '').trim();
    const competitionId = String(input.competitionId || '').trim();
    if (!teamId && !competitionId) return { ok: false, error: 'Enter a football-data team or competition ID' };
    if (teamId && !/^\d+$/.test(teamId)) return { ok: false, error: 'football-data team ID must be numeric' };
    if (competitionId && !/^(\d+|[A-Za-z0-9]{2,4})$/.test(competitionId)) return { ok: false, error: 'Invalid football-data competition ID/code' };
    source = teamId ? { type, teamId } : { type, competitionId };
  } else if (type === 'api-football') {
    const leagueId = String(input.apiFootballLeagueId || input.leagueId || '').trim();
    if (!/^\d+$/.test(leagueId)) return { ok: false, error: 'API-Football competition ID must be numeric' };
    source = { type, leagueId };
  } else if (type === 'uefa') {
    const competitionId = String(input.uefaCompetitionId || input.competitionId || '').trim();
    if (!/^\d+$/.test(competitionId)) return { ok: false, error: 'UEFA competition ID must be numeric' };
    source = { type, competitionId };
  } else if (type === 'tmdb') {
    const tvIds = String(input.tvIds || '').split(/[\s,]+/).map((v) => v.trim()).filter(Boolean);
    if (!tvIds.length || tvIds.some((v) => !/^\d+$/.test(v))) return { ok: false, error: 'TMDB TV IDs must be numeric and comma-separated' };
    source = tvIds.length === 1 ? { type, tvId: tvIds[0] } : { type, tvIds };
  } else if (type === 'onefc') {
    source = { type };
  } else if (type === 'aew') {
    source = { type };
  } else if (type === 'espn') {
    const league = String(input.league || '').trim().toLowerCase();
    if (!/^[a-z0-9.-]{2,20}$/.test(league)) return { ok: false, error: 'ESPN league must be a slug such as nfl, nba or eng.1' };
    source = { type, league };
  } else if (type === 'mlb') {
    source = { type };
  } else if (type === 'json-feed') {
    try { source = jsonFeed.definition(input); }
    catch (error) { return { ok: false, error: error.message }; }
  } else {
    return { ok: false, error: 'Unsupported metadata adapter: ' + type };
  }
  return { ok: true, definition: { id, name, system: false, source } };
}

// Stable key for comparing sources, e.g. to show which promotions use one.
function sourceKey(source) {
  const s = source || {};
  return JSON.stringify(Object.keys(s).sort().reduce((out, key) => { out[key] = s[key]; return out; }, {}));
}

module.exports = { SYSTEM_SOURCES, validateDefinition, sourceKey };
