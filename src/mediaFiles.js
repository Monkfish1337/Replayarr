import { copyFile, mkdir, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

// Local metadata for media servers: Kodi-style .nfo files and artwork next to
// each imported event, which Jellyfin (and Kodi, and Plex with an NFO agent)
// read instead of guessing from online databases that do not carry sports.
//
// Layout, with the default naming pattern:
//   <library>/<Promotion>/tvshow.nfo, poster.*, fanart.*
//   <library>/<Promotion>/Season 2026/<name>.mkv, <name>.nfo, <name>-thumb.*

const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const USER_AGENT = 'Replayarr/0.2 (https://github.com/Monkfish1337/Replayarr; self-hosted sports replay manager)';

const xml = (value) => String(value ?? '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const tag = (name, value) => (value === undefined || value === null || value === '' ? '' : `  <${name}>${xml(value)}</${name}>\n`);
const exists = (path) => stat(path).then(() => true, () => false);

// Stable season/episode numbers for an event: the season is the year and the
// episode is MMDD followed by the event's two-digit position among the
// promotion's events that day (e.g. 20 Sept, first event -> 92001). Numbers
// sort by date, never collide, and do not shift when other events are added.
export function episodeNumber(event, sameDayEvents) {
  const [year, month, day] = String(event.date).split('-').map(Number);
  const ordered = [...sameDayEvents].sort((a, b) => String(a.time || '').localeCompare(String(b.time || '')) || String(a.id).localeCompare(String(b.id)));
  const position = Math.max(0, ordered.findIndex((e) => e.id === event.id)) + 1;
  return { season: year, episode: (month * 100 + day) * 100 + Math.min(position, 99) };
}

export function formatEpisode(episode) {
  return String(episode).padStart(6, '0');
}

export function sidecarBase(videoPath) {
  return videoPath.slice(0, videoPath.length - extname(videoPath).length);
}

// The promotion's show folder: the first folder under the library root, when
// the naming pattern creates one.
export function showFolder(libraryRoot, videoPath) {
  const parts = relative(resolve(libraryRoot), dirname(videoPath)).split(sep).filter(Boolean);
  return parts.length ? join(resolve(libraryRoot), parts[0]) : null;
}

function episodeNfo({ event, promotionName, season, episode, quality }) {
  const p = event.payload || {};
  const where = [p.venue, p.city, p.country].filter(Boolean).join(', ');
  const plot = [p.description || p.shortDescription, where && `Venue: ${where}`].filter(Boolean).join('\n\n');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<episodedetails>\n'
    + tag('title', event.title)
    + tag('showtitle', promotionName)
    + tag('season', season)
    + tag('episode', episode)
    + tag('aired', event.date)
    + tag('premiered', event.date)
    + tag('plot', plot)
    + tag('genre', 'Sports')
    + tag('studio', promotionName)
    + (quality ? tag('tag', quality) : '')
    + `  <uniqueid type="replayarr" default="true">${xml(event.id)}</uniqueid>\n`
    + '</episodedetails>\n';
}

function showNfo({ promotionName, promotionId }) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<tvshow>\n'
    + tag('title', promotionName)
    + tag('sorttitle', promotionName)
    + tag('genre', 'Sports')
    + tag('studio', promotionName)
    + `  <uniqueid type="replayarr" default="true">${xml(promotionId)}</uniqueid>\n`
    + '</tvshow>\n';
}

// Fetch an image to `<targetBase>.<ext>`, replacing any earlier image (of
// any type) only once the new one is saved. Accepts https URLs, or
// /logos/... for logos uploaded to Replayarr. Returns the written path.
export async function saveImage(source, targetBase, { logoDir, fetchImpl = fetch } = {}) {
  const url = String(source || '');
  const local = /^\/logos\/([a-z0-9-]+\.(png|jpg|webp|gif|svg))$/.exec(url);
  if (local) {
    if (local[2] === 'svg') throw new Error('SVG logos cannot be used as media-server artwork');
    const target = `${targetBase}.${local[2]}`;
    await copyFile(join(logoDir, local[1]), `${target}.part`);
    await removeImages(targetBase);
    await rename(`${target}.part`, target);
    return target;
  }
  if (!/^https:\/\//i.test(url)) throw new Error(`not an https image URL: ${url}`);
  const response = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const ext = IMAGE_TYPES[String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()];
  if (!ext) throw new Error(`not a supported image (${response.headers.get('content-type')}): ${url}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_IMAGE_BYTES) throw new Error(`image too large: ${url}`);
  const target = `${targetBase}.${ext}`;
  await writeFile(`${target}.part`, body);
  await removeImages(targetBase);
  await rename(`${target}.part`, target);
  return target;
}

async function findImage(base) {
  for (const ext of ['jpg', 'png', 'webp', 'gif']) if (await exists(`${base}.${ext}`)) return `${base}.${ext}`;
  return null;
}

async function removeImages(base) {
  for (const ext of ['jpg', 'png', 'webp', 'gif']) await unlink(`${base}.${ext}`).catch(() => {});
}

// Write the event's .nfo and thumbnail, and the promotion's show files when
// missing (or always, with overwrite). Returns a list of problems; artwork is
// best effort and never fails an import.
export async function writeMediaFiles({ videoPath, libraryRoot, event, promotion, season, episode, quality, logoDir, overwrite = false, fetchImpl }) {
  const problems = [];
  const base = sidecarBase(videoPath);
  const payload = event.payload || {};
  await writeFile(`${base}.nfo`, episodeNfo({ event, promotionName: promotion.name, season, episode, quality }));

  const thumb = payload.thumb || payload.fanart || payload.poster || payload.square;
  if (thumb && (overwrite || !(await findImage(`${base}-thumb`)))) {
    try {
      await saveImage(thumb, `${base}-thumb`, { logoDir, fetchImpl });
    } catch (error) {
      problems.push(`event artwork: ${error.message}`);
    }
  }

  const show = showFolder(libraryRoot, videoPath);
  if (show) {
    await mkdir(show, { recursive: true });
    if (overwrite || !(await exists(join(show, 'tvshow.nfo')))) {
      await writeFile(join(show, 'tvshow.nfo'), showNfo({ promotionName: promotion.name, promotionId: promotion.id }));
    }
    const art = [
      ['poster', promotion.logo || promotion.defaultLogo],
      ['fanart', payload.fanart || payload.banner],
    ];
    for (const [name, url] of art) {
      if (!url || (!overwrite && await findImage(join(show, name)))) continue;
      try {
        await saveImage(url, join(show, name), { logoDir, fetchImpl });
      } catch (error) {
        problems.push(`${name}: ${error.message}`);
      }
    }

    // Jellyfin does not carry the show poster down to its seasons, so each
    // season folder gets its own copy (taken from the show's, not refetched).
    const season = dirname(videoPath);
    const showPoster = await findImage(join(show, 'poster'));
    if (resolve(season) !== resolve(show) && showPoster && (overwrite || !(await findImage(join(season, 'poster'))))) {
      try {
        const target = join(season, `poster${extname(showPoster)}`);
        await copyFile(showPoster, `${target}.part`);
        await removeImages(join(season, 'poster'));
        await rename(`${target}.part`, target);
      } catch (error) {
        problems.push(`season poster: ${error.code || error.message}`);
      }
    }
  }
  return problems;
}

// Move an event's .nfo and thumbnail along with its video.
export async function moveSidecars(fromVideo, toVideo) {
  const from = sidecarBase(fromVideo);
  const to = sidecarBase(toVideo);
  const moves = [[`${from}.nfo`, `${to}.nfo`]];
  for (const ext of ['jpg', 'png', 'webp', 'gif']) moves.push([`${from}-thumb.${ext}`, `${to}-thumb.${ext}`]);
  for (const [a, b] of moves) if (await exists(a)) await rename(a, b);
}

// Remove folders left empty by a rename, up to (not including) the library root.
// A season folder holding only its copied poster counts as empty; the show
// folder (tvshow.nfo, fanart) never does.
export async function pruneEmptyFolders(folder, libraryRoot) {
  const root = resolve(libraryRoot);
  let current = resolve(folder);
  while (current.startsWith(root + sep)) {
    const entries = await readdir(current).catch(() => null);
    if (!entries) return;
    const onlyPoster = entries.length && entries.every((name) => /^poster\.(?:jpg|png|webp|gif)$/.test(name));
    if (entries.length && !onlyPoster) return;
    if (onlyPoster) await removeImages(join(current, 'poster'));
    await rmdir(current).catch(() => {});
    current = dirname(current);
  }
}
