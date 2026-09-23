import { randomUUID } from 'node:crypto';

// Quality profiles, as in Sonarr: which qualities a promotion accepts, the
// quality at which it stops upgrading (the cutoff), and whether Replayarr may
// grab and upgrade on its own.

// Best first. "unknown" is a release that does not state its resolution.
export const QUALITY_ORDER = ['2160p', '1080p', '720p', '576p', '480p', 'unknown'];

export const DEFAULT_PROFILE = {
  id: 'default',
  name: 'Any',
  qualities: [...QUALITY_ORDER],
  cutoff: '1080p',
  upgrades: 'yes',
  // Grab the best match of an automatic search on its own, when its score
  // reaches minScore. Interactive search never grabs.
  autoGrab: 'yes',
  minScore: 60,
};

// Higher is better; a quality not in the list ranks with "unknown".
export function qualityRank(quality) {
  const index = QUALITY_ORDER.indexOf(quality || 'unknown');
  return QUALITY_ORDER.length - (index < 0 ? QUALITY_ORDER.length - 1 : index);
}

export function allows(profile, quality) {
  return profile.qualities.includes(quality || 'unknown');
}

// Below the cutoff, and upgrades are on: keep looking for a better release.
export function wantsUpgrade(profile, quality) {
  return profile.upgrades === 'yes' && qualityRank(quality) < qualityRank(profile.cutoff);
}

// A release better than what is in the library, and allowed.
export function isUpgrade(profile, current, candidate) {
  return allows(profile, candidate) && qualityRank(candidate) > qualityRank(current)
    && qualityRank(current) < qualityRank(profile.cutoff);
}

export function normaliseProfile(input) {
  if (!input || typeof input !== 'object') return null;
  const qualities = QUALITY_ORDER.filter((q) => (Array.isArray(input.qualities) ? input.qualities : []).includes(q));
  const allowed = qualities.length ? qualities : [...QUALITY_ORDER];
  const cutoff = allowed.includes(input.cutoff) ? input.cutoff : allowed[0];
  const minScore = Number(input.minScore);
  return {
    id: String(input.id || randomUUID()),
    name: String(input.name || '').trim() || 'Profile',
    qualities: allowed,
    cutoff,
    upgrades: input.upgrades === 'no' ? 'no' : 'yes',
    autoGrab: input.autoGrab === 'no' ? 'no' : 'yes',
    minScore: Number.isFinite(minScore) ? Math.min(100, Math.max(1, Math.round(minScore))) : DEFAULT_PROFILE.minScore,
  };
}

// The profile a promotion uses: the one assigned to it, else the first.
export function profileFor(settings, promotionMeta) {
  return settings.profiles.find((p) => p.id === promotionMeta?.profileId) || settings.profiles[0];
}
