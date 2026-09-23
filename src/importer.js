import { copyFile, link, mkdir, readdir, rename, stat, unlink, constants } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';

const VIDEO = new Set(['.mkv', '.mp4', '.m4v', '.avi', '.ts', '.m2ts', '.mov', '.wmv', '.webm']);

export class ImportError extends Error {}

async function videoFiles(path, depth = 0) {
  const info = await stat(path);
  if (info.isFile()) return VIDEO.has(extname(path).toLowerCase()) ? [{ path, size: info.size }] : [];
  if (!info.isDirectory() || depth > 4) return [];
  const out = [];
  for (const entry of await readdir(path)) out.push(...await videoFiles(join(path, entry), depth + 1));
  return out;
}

// The main feature: the largest video that is not a sample. Multi-part
// events are not imported in Phase 1; the operator sees why.
export async function pickVideo(path) {
  let files;
  try { files = await videoFiles(path); }
  catch (error) { throw new ImportError(`Cannot read ${path}: ${error.code || error.message}`); }
  const main = files.filter((file) => !/(?:^|[\\/._ -])sample(?:[\\/._ -]|$)/i.test(file.path.slice(path.length)));
  if (!main.length) throw new ImportError(files.length ? 'Only sample files were found' : `No video file found in ${path}`);
  return main.sort((a, b) => b.size - a.size)[0];
}

const segment = (value) => String(value ?? '')
  .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/^[\s.]+|[\s.]+$/g, '')
  .slice(0, 150);

// Tokens: {promotion} {title} {date} {year} {quality} {release} {season} {episode}
export function destinationFor(settings, tokens, extension) {
  const root = resolve(settings.library.root || '');
  if (!settings.library.root) throw new ImportError('Set a library folder in Settings before importing');
  const parts = String(settings.library.naming || '').split(/[\\/]/).map((part) =>
    segment(part.replace(/\{(\w+)\}/g, (_, key) => tokens[key] ?? ''))
      .replace(/\[\s*\]|\(\s*\)/g, '').replace(/\s+-\s*$/, '').trim())
    .filter(Boolean);
  if (!parts.length) throw new ImportError('The naming pattern produced an empty path');
  const target = resolve(root, ...parts) + extension.toLowerCase();
  if (!target.startsWith(root + sep)) throw new ImportError('The naming pattern points outside the library folder');
  return target;
}

async function place(source, target, mode) {
  await mkdir(dirname(target), { recursive: true });
  if (mode === 'hardlink') {
    try { await link(source, target); return 'hardlink'; }
    catch (error) {
      if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EMLINK'].includes(error.code)) throw error;
    }
  }
  if (mode === 'move') {
    try { await rename(source, target); return 'move'; }
    catch (error) { if (error.code !== 'EXDEV') throw error; }
  }
  // Copy to a temporary name first, so a half-written file is never visible
  // to a media server scanning the library.
  const partial = target + '.replayarr-partial';
  await copyFile(source, partial, constants.COPYFILE_EXCL);
  await rename(partial, target);
  if (mode === 'move') await unlink(source);
  return 'copy';
}

// Import one completed download. Idempotent: re-running after a crash finds
// the file already in place and reports it rather than failing.
export async function importDownload({ settings, localPath, event, promotionName, candidate, verifyName, season, episode, replacing = null }) {
  const video = await pickVideo(localPath);
  const minBytes = (Number(settings.library.minSizeMb) || 0) * 1024 * 1024;
  if (video.size < minBytes) {
    throw new ImportError(`${basename(video.path)} is ${Math.round(video.size / 1048576)} MB, below the ${settings.library.minSizeMb} MB minimum`);
  }
  if (verifyName) {
    const verdict = verifyName(basename(video.path, extname(video.path)));
    if (verdict && !verdict.ok && /^(?:wrong-date|wrong-year|wrong-season|wrong-event)/.test(verdict.reason)) {
      throw new ImportError(`File name does not match this event (${verdict.reason}): ${basename(video.path)}`);
    }
  }
  const tokens = {
    promotion: promotionName || 'Sports',
    title: event.title,
    date: event.date,
    year: String(event.date).slice(0, 4),
    quality: candidate.quality || '',
    release: candidate.title,
    season: season ?? String(event.date).slice(0, 4),
    episode: episode === undefined ? '' : String(episode).padStart(6, '0'),
  };
  const target = destinationFor(settings, tokens, extname(video.path));
  const existing = await stat(target).catch(() => null);
  if (existing) {
    if (existing.size === video.size) return { path: target, size: video.size, method: 'existing' };
    // An upgrade whose new name is the old one (the naming pattern has no
    // {quality}): place it beside the old file, then swap it in.
    if (replacing && resolve(replacing) === resolve(target)) {
      const incoming = `${target}.replayarr-upgrade`;
      await unlink(incoming).catch(() => {});
      const method = await place(video.path, incoming, settings.library.mode);
      await rename(incoming, target);
      return { path: target, size: video.size, method };
    }
    throw new ImportError(`A different file already exists at ${target}`);
  }
  const method = await place(video.path, target, settings.library.mode);
  return { path: target, size: video.size, method };
}
