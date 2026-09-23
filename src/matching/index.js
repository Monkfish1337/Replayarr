import promotions from './promotions.cjs';
import releaseFilter from './release-filter.cjs';
import promotionAliases from './promotion-aliases.cjs';

export { promotions, promotionAliases };

// Rebuild the registry from Replayarr's stored rules: custom promotions are
// createGenericPromotion specs, overlays add learned aliases to a built-in.
export function configurePromotions(store) {
  const rules = store.listPromotionRules();
  promotions.configure({
    customPromotions: rules.filter((rule) => rule.kind === 'custom').map((rule) => ({ ...rule.spec, id: rule.id })),
    overlays: Object.fromEntries(rules.filter((rule) => rule.kind === 'overlay').map((rule) => [rule.id, rule.spec])),
  });
}

export function listPromotions() {
  return promotions.all.map((p) => ({
    id: p.id, name: p.name, idPrefix: p.idPrefix, custom: !!p.isCustom, overlay: !!p.matchingOverride,
    poster: p.defaults?.poster || '', posterShape: p.posterShape || 'poster',
  }));
}

export function promotionFor(event) {
  return (event.promotionId && promotions.getById(event.promotionId)) || promotions.getByEventId(event.id);
}

// The SSS matchers read SSS's event shape. Replayarr keeps its own record and
// translates at this one boundary.
// Events fetched by Replayarr keep the full normalised record (team names,
// week, season, round...) in `payload`, which the matchers use.
export function matcherEvent(event) {
  return {
    ...(event.payload || {}),
    id: event.id, name: event.title, date: event.date, time: event.payload?.time || event.time,
    aliases: event.aliases || [], searchAliases: event.aliases || [],
  };
}

const unique = (titles) => Array.from(new Set(titles.map((t) => String(t || '').trim()).filter(Boolean)));

export function searchTitles(event, limit = 6) {
  const promotion = promotionFor(event);
  const matcher = matcherEvent(event);
  const titles = promotion ? promotion.searchTitles(matcher) : [event.title];
  return unique([].concat(titles || [], event.aliases || [])).slice(0, Math.max(1, limit));
}

// The queries each kind of indexer gets, as SSS sends them (lib/streams.js):
// torrent indexers (Prowlarr, Bitmagnet) take the promotion's torrent list —
// its focused scene forms first, then every other spelling, scene code and
// date order, about sixty for a football fixture. Text-search providers
// (Easynews) take a few queries chosen to be different spellings.
export function queriesFor(event, indexerType, limit) {
  const promotion = promotionFor(event);
  const matcher = matcherEvent(event);
  if (!promotion) return unique([event.title, ...(event.aliases || [])]).slice(0, Math.max(1, limit));
  const titles = unique([].concat(promotion.searchTitles(matcher) || [], event.aliases || []));
  if (indexerType === 'easynews') return selectProviderQueries(titles, matcher, limit || promotion.uuMaxQueries || 6, promotion);
  const torrent = typeof promotion.torrentSearchTitles === 'function'
    ? unique([].concat(promotion.torrentSearchTitles(matcher) || [], event.aliases || [])) : titles;
  return torrent.slice(0, Math.max(1, limit || torrent.length));
}

// Ported from SSS lib/streams.js selectProviderQueries: score for an exact
// date, a matchup and the event's own words, then spend the slots on
// different spellings rather than the same one with the date moved.
const QUERY_CHROME = new Set([
  'epl', 'efl', 'premier', 'league', 'english', 'football', 'soccer', 'liga',
  'serie', 'bundesliga', 'ligue', 'eredivisie', 'primeira', 'championship',
  'cup', 'copa', 'coupe', 'uefa', 'fifa', 'champions', 'europa', 'conference',
  'nfl', 'nba', 'wnba', 'mlb', 'nhl', 'ncaa', 'matchday', 'round', 'week',
  'season', 'live', 'full', 'match', 'game', 'replay', 'versus',
]);
export function selectProviderQueries(titles, event, limit, promotion) {
  const date = String(event?.date || '');
  const dateParts = date.split('-');
  const dmy = dateParts.length === 3 ? `${dateParts[2]}.${dateParts[1]}.${dateParts[0]}` : '';
  const dateForms = date ? [date, date.replace(/-/g, ' '), date.replace(/-/g, '.'), dmy] : [];
  const fold = (text) => String(text).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const eventTokens = unique(fold(event?.name || '').match(/[a-z0-9]+/g) || [])
    .filter((token) => !/^(?:vs|v|at|fc|cf|sc|afc|sk|fk|de|the)$/.test(token));
  const chrome = new Set();
  for (const phrase of [].concat(promotion?.promotionAliases || [], promotion?.name ? [promotion.name] : [])) {
    for (const token of String(phrase).toLowerCase().match(/[a-z]+/g) || []) if (token.length > 2) chrome.add(token);
  }
  const scored = unique(titles || []).map((title, index) => {
    const lower = title.toLowerCase();
    const normalized = fold(title);
    const hasExactDate = dateForms.some((form) => form && lower.includes(form.toLowerCase()));
    let score = hasExactDate ? 100 : 0;
    if (/\b(?:vs\.?|v\.?|@)\b/i.test(title)) score += 20;
    if (/\b(?:19|20)\d{2}\b/.test(title)) score += 10;
    score += eventTokens.filter((token) => new RegExp(`\b${token}\b`).test(normalized)).length * 8;
    score += Math.max(0, 20 - Math.floor(title.length / 10));
    if (index === 0 && hasExactDate) score += 1000;
    return { title, index, score };
  }).sort((a, b) => b.score - a.score || a.title.length - b.title.length || a.index - b.index);
  const PER_SPELLING = 2;
  const signature = (title) => (fold(title).match(/[a-z]+/g) || [])
    .filter((token) => token.length > 2 && !QUERY_CHROME.has(token) && !chrome.has(token)).sort().join(' ');
  const cap = Math.max(1, limit || 6);
  const seen = new Map();
  const primary = [];
  const overflow = [];
  for (const row of scored) {
    const key = signature(row.title);
    const used = seen.get(key) || 0;
    if (used < PER_SPELLING) { seen.set(key, used + 1); primary.push(row.title); } else overflow.push(row.title);
    if (primary.length >= cap) break;
  }
  return primary.concat(overflow).slice(0, cap);
}

// Broad queries for when the precise ones find nothing: just the two teams,
// with no competition prefix, date or "vs" to trip an indexer that needs
// every word to match ("Manchester United Sabah", "Man Utd Sabah FC").
// Safe because every result still goes through the matcher, which checks the
// date and both teams. Events without structured teams get none: their
// search titles (e.g. "UFC 331") are already broad.
export function broadQueries(event, alreadyAsked = []) {
  const teams = event.payload?.teamNames;
  const home = Array.isArray(teams?.home) ? teams.home : [];
  const away = Array.isArray(teams?.away) ? teams.away : [];
  if (!home.length || !away.length) return [];
  // A readable alternative form: not a three-letter code, not the first form.
  const alternative = (forms) => forms.slice(1).find((name) => String(name).length > 3 && !/^[A-Z.]{2,4}$/.test(name));
  const pairs = [[home[0], away[0]], [alternative(home), alternative(away)]];
  const asked = new Set(alreadyAsked.map((q) => q.toLowerCase()));
  const out = [];
  for (const [a, b] of pairs) {
    if (!a || !b) continue;
    const query = `${a} ${b}`.replace(/\s+/g, ' ').trim();
    if (!asked.has(query.toLowerCase()) && !out.some((q) => q.toLowerCase() === query.toLowerCase())) out.push(query);
  }
  return out;
}

// Same order as SSS's candidate filter: shared noise filter first, then the
// promotion's relevance check, then an event alias may rescue a keyword miss
// provided the title does not name a different year.
export function evaluate(title, event) {
  const promotion = promotionFor(event);
  if (!promotion) return { ok: false, stage: 'promotion', reason: 'no promotion for this event' };
  const noise = releaseFilter.rejectionReason(title, null, { allowForeignLanguage: !!promotion.allowForeignLanguage });
  if (noise) return { ok: false, stage: 'release-filter', reason: noise };
  const matcher = matcherEvent(event);
  let verdict;
  try {
    verdict = promotion.isRelevantStreamTitle(title, matcher) || { ok: false, reason: 'unknown' };
  } catch (error) {
    return { ok: false, stage: 'relevance', reason: 'matcher error: ' + error.message };
  }
  if (!verdict.ok && ['no-keyword-match', 'relevance'].includes(verdict.reason)) {
    const eventYear = String(event.date || '').slice(0, 4);
    const titleYears = String(title).match(/\b20\d{2}\b/g) || [];
    const wrongYear = eventYear && titleYears.length > 0 && !titleYears.includes(eventYear);
    const alias = (event.aliases || []).find((value) => String(value).trim().length >= 4
      && String(title).toLowerCase().includes(String(value).trim().toLowerCase()));
    if (alias && !wrongYear) return { ok: true, stage: 'relevance', reason: 'event alias: ' + alias };
  }
  return { ok: !!verdict.ok, stage: 'relevance', reason: verdict.ok ? (verdict.reason || 'matched') : (verdict.reason || 'relevance') };
}

export function releaseDates(title) {
  return promotions.extractReleaseDates(String(title || ''));
}
