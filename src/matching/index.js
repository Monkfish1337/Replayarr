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
export function matcherEvent(event) {
  return { id: event.id, name: event.title, date: event.date, time: event.time, aliases: event.aliases || [], searchAliases: event.aliases || [] };
}

export function searchTitles(event, limit = 6) {
  const promotion = promotionFor(event);
  const matcher = matcherEvent(event);
  const titles = promotion ? promotion.searchTitles(matcher) : [event.title];
  return Array.from(new Set([].concat(titles || [], event.aliases || []).map((t) => String(t || '').trim()).filter(Boolean)))
    .slice(0, Math.max(1, limit));
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
