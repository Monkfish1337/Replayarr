const QUALITIES = [
  { label: '2160p', pattern: /\b(?:2160[pi]?|4k|uhd)\b/i, points: 32 },
  { label: '1080p', pattern: /\b1080[pi]\b/i, points: 30 },
  { label: '720p', pattern: /\b720p\b|\b720\b(?=[._ -]*(?:50|60)?fps)/i, points: 20 },
  { label: '576p', pattern: /\b576[pi]\b/i, points: 8 },
  { label: '480p', pattern: /\b480p\b|\bsd\b/i, points: 5 },
];
const SOURCES = [
  { label: 'WEB-DL', pattern: /\bweb[._ -]?dl\b/i, points: 8 },
  { label: 'WEBRip', pattern: /\bweb[._ -]?rip\b/i, points: 6 },
  { label: 'WEB', pattern: /\bweb\b/i, points: 6 },
  { label: 'HDTV', pattern: /\bhdtv\b/i, points: 5 },
];

// Scene titles use separators everywhere; normalise before the \b tests.
const scene = (title) => String(title || '').replace(/[._]/g, ' ');

export function parseQuality(title) {
  const text = scene(title);
  return QUALITIES.find((q) => q.pattern.test(text))?.label || null;
}

export function formatSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index >= 3 ? 1 : 0)} ${units[index]}`;
}

// A score for ranking candidates that already passed the matcher, with the
// reasons that produced it. The reasons are what the review screen shows, so
// each line must be something the operator can check against the title.
export function scoreCandidate(candidate, { verdict, preferences = {}, minSizeMb = 0 } = {}) {
  const evidence = [];
  if (!verdict?.ok) {
    return { score: 0, quality: parseQuality(candidate.title), evidence: [`Rejected: ${verdict?.reason || 'did not match'}`] };
  }
  let score = 40;
  evidence.push(verdict.reason && verdict.reason !== 'matched' ? `Matched event (${verdict.reason})` : 'Matched event');
  const text = scene(candidate.title);
  const quality = QUALITIES.find((q) => q.pattern.test(text));
  if (quality) { score += quality.points; evidence.push(`${quality.label} +${quality.points}`); }
  else evidence.push('Quality not stated');
  const source = SOURCES.find((s) => s.pattern.test(text));
  if (source) { score += source.points; evidence.push(`${source.label} +${source.points}`); }

  const sizeMb = Number(candidate.size) / (1024 * 1024);
  if (Number.isFinite(sizeMb) && sizeMb > 0 && minSizeMb && sizeMb < minSizeMb) {
    score -= 30;
    evidence.push(`Smaller than ${minSizeMb} MB −30`);
  }
  if (candidate.protocol === 'torrent') {
    const seeders = Number(candidate.seeders) || 0;
    if (seeders < (preferences.minSeeders ?? 1)) { score -= 25; evidence.push(`${seeders} seeders −25`); }
    else {
      const bonus = Math.min(10, Math.round(Math.log2(seeders + 1) * 2));
      score += bonus;
      evidence.push(`${seeders} seeders +${bonus}`);
    }
  } else if (candidate.protocol === 'usenet') {
    score += 6;
    evidence.push('Usenet +6');
  } else if (candidate.protocol === 'easynews') {
    // A direct download: no swarm to depend on, nothing to repair or unpack.
    score += 6;
    evidence.push('Easynews direct +6');
  }
  // Easynews is Usenet content, so a Usenet preference covers it.
  const family = candidate.protocol === 'easynews' ? 'usenet' : candidate.protocol;
  if (preferences.protocol && preferences.protocol !== 'any' && family === preferences.protocol) {
    score += 6;
    evidence.push(`Preferred protocol +6`);
  }
  return { score: Math.max(1, Math.min(100, score)), quality: quality?.label || null, evidence };
}
