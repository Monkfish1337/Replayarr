import { TransitionError } from './store.js';
import { UserError } from './service.js';
import { indexerReady, loadSettings, MASK, normaliseIndexer, publicSettings, saveSettings } from './settings.js';
import { listPromotions, promotionAliases } from './matching/index.js';
import { MetadataError } from './metadata/manager.js';
import { clearLogs, formatEntry, listLogs, logComponents, logger, setLogLevel } from './logger.js';

const log = logger('api');

const MAX_BODY = 256 * 1024;
// Logo uploads arrive as a base64 data URL (2 MB image, plus encoding).
const MAX_UPLOAD_BODY = 3 * 1024 * 1024;

async function readJson(request, maxBody = MAX_BODY) {
  // Requiring a JSON content type means a cross-site form cannot reach these
  // routes without a CORS preflight, which this server never grants.
  if (!/^application\/json\b/i.test(request.headers['content-type'] || '')) {
    throw new UserError('Send the request body as application/json.', 415);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBody) throw new UserError('Request body too large.', 413);
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new UserError('The request body is not valid JSON.'); }
}

let uiBuildHeader = '';
function send(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-replayarr-ui': uiBuildHeader });
  response.end(payload === undefined ? '' : JSON.stringify(payload));
}

function requestView(store, request) {
  const event = store.getEvent(request.eventId);
  const job = store.latestJob(request.id);
  const candidate = request.candidateId ? store.getCandidate(request.candidateId) : null;
  const candidates = store.listCandidates(request.id);
  return {
    ...request,
    event,
    job,
    candidate,
    matchedCount: candidates.filter((c) => c.decision === 'matched').length,
    library: event ? store.libraryFor(event.id) : null,
  };
}

export function createApi(service, { testers, version = '', revision = '', uiBuild = '', databasePath = '' }) {
  uiBuildHeader = uiBuild;
  const { store } = service;
  const startedAt = new Date().toISOString();
  const routes = [
    ['GET', /^\/api\/overview$/, () => ({
      counts: store.counts(),
      review: store.listRequests({ status: 'review' }).map((r) => requestView(store, r)),
      activity: store.listActivity(8),
      configured: configuredServices(loadSettings(store)),
    })],
    ['GET', /^\/api\/promotions$/, () => service.metadata.list()],
    // --- Metadata section ---------------------------------------------------
    ['PUT', /^\/api\/metadata\/promotions\/([a-z0-9-]+)$/, ([, id], body) => service.metadata.update(id, body)],
    ['GET', /^\/api\/metadata\/promotions\/([a-z0-9-]+)\/logos$/, ([, id], _b, url) => service.metadata.logoCandidates(id, url.searchParams.get('q') || '')],
    ['POST', /^\/api\/metadata\/promotions\/([a-z0-9-]+)\/logo$/, ([, id], body) => service.metadata.uploadLogo(id, body.dataUrl), { maxBody: MAX_UPLOAD_BODY }],
    ['GET', /^\/api\/metadata\/providers$/, () => service.metadata.providers()],
    ['POST', /^\/api\/metadata\/providers$/, (_m, body) => service.metadata.createProvider(body)],
    ['DELETE', /^\/api\/metadata\/providers\/([a-z0-9_-]+)$/, ([, id]) => { service.metadata.deleteProvider(id); }],
    ['POST', /^\/api\/metadata\/providers\/preview$/, (_m, body) => service.metadata.preview(body)],
    ['POST', /^\/api\/metadata\/refresh$/, (_m, body) => service.syncEvents(Array.isArray(body.ids) ? body.ids : undefined)],
    ['GET', /^\/api\/metadata\/status$/, () => service.metadata.status()],
    ['GET', /^\/api\/queue$/, () => store.queue().map((job) => ({
      ...job,
      request: requestView(store, store.getRequest(job.requestId)),
      candidate: store.getCandidate(job.candidateId),
    }))],
    ['GET', /^\/api\/health$/, () => service.health()],
    ['GET', /^\/api\/system\/status$/, () => ({
      version, revision, uiBuild, node: process.version, platform: process.platform, database: databasePath,
      startedAt, promotions: listPromotions().length,
    })],
    ['GET', /^\/api\/system\/tasks$/, () => service.tasks()],
    ['POST', /^\/api\/system\/tasks\/([a-z-]+)$/, ([, name]) => service.runTask(name)],
    ['GET', /^\/api\/events$/, (_m, _b, url) => {
      const events = store.listEvents({
        search: url.searchParams.get('q') || '', promotionId: url.searchParams.get('promotion') || '',
        from: url.searchParams.get('from') || '', to: url.searchParams.get('to') || '', limit: url.searchParams.get('limit'),
      });
      const requests = new Map(store.listRequests().map((r) => [r.eventId, r]));
      return events.map((event) => ({ ...event, request: requests.get(event.id) || null, library: store.libraryFor(event.id) }));
    }],
    ['POST', /^\/api\/events$/, (_m, body) => service.addManualEvent(body)],
    ['POST', /^\/api\/events\/sync$/, () => service.syncEvents()],
    ['GET', /^\/api\/requests$/, () => store.listRequests().map((r) => requestView(store, r))],
    ['POST', /^\/api\/requests$/, async (_m, body) => requestView(store, await service.requestEvent(body.eventId))],
    ['GET', /^\/api\/requests\/(\d+)$/, ([, id]) => {
      const request = store.getRequest(Number(id));
      if (!request) throw new UserError('Request not found.', 404);
      return { ...requestView(store, request), candidates: store.listCandidates(request.id), searches: store.listSearches(request.id) };
    }],
    ['DELETE', /^\/api\/requests\/(\d+)$/, ([, id]) => { service.remove(id); }],
    ['POST', /^\/api\/requests\/(\d+)\/search$/, async ([, id]) => requestView(store, await service.searchRequest(id))],
    ['POST', /^\/api\/requests\/(\d+)\/approve$/, async ([, id], body) => requestView(store, await service.approve(id, body.candidateId))],
    ['POST', /^\/api\/requests\/(\d+)\/retry$/, ([, id]) => requestView(store, service.retry(id))],
    ['GET', /^\/api\/activity$/, () => store.listActivity(200)],
    ['GET', /^\/api\/library\/rename$/, () => service.renamePlan()],
    ['POST', /^\/api\/library\/rename$/, () => service.renameFiles()],
    ['POST', /^\/api\/library\/metadata$/, () => service.writeAllMetadata()],
    ['GET', /^\/api\/library$/, () => store.listLibrary().map((item) => ({ ...item, event: store.getEvent(item.eventId) }))],
    ['GET', /^\/api\/settings$/, () => ({ settings: publicSettings(loadSettings(store)), rules: store.listPromotionRules() })],
    ['PUT', /^\/api\/settings$/, (_m, body) => {
      const saved = saveSettings(store, body);
      setLogLevel(saved.logging.level);
      return publicSettings(saved);
    }],
    // --- System › Logs --------------------------------------------------
    ['GET', /^\/api\/logs$/, (_m, _b, url) => ({
      entries: listLogs(Object.fromEntries(url.searchParams)),
      components: logComponents(),
      level: loadSettings(store).logging.level,
    })],
    ['DELETE', /^\/api\/logs$/, () => { clearLogs(); }],
    ['POST', /^\/api\/settings\/test\/(qbittorrent|sabnzbd|jellyfin)$/, async ([, name]) => {
      const settings = loadSettings(store);
      return { ok: true, message: await testers[name](settings[name]) };
    }],
    // Tests the indexer as entered in the edit dialog, before it is saved. A
    // masked secret means "unchanged", so the saved value is used.
    ['POST', /^\/api\/indexers\/test$/, async (_m, body) => {
      const saved = loadSettings(store).indexers.find((i) => i.id === body.id) || {};
      const indexer = { ...body };
      for (const key of ['apiKey', 'password']) if (indexer[key] === MASK) indexer[key] = saved[key] || '';
      const tester = testers[indexer.type];
      if (!tester) throw new UserError('Unknown indexer type.');
      // Clean the form values exactly as saving would (numbers, trimming).
      return { ok: true, message: await tester(normaliseIndexer({ ...saved, ...indexer })) };
    }],
    // SSS's alias learner: turn good/bad example release names into rules.
    ['POST', /^\/api\/promotion-rules\/suggest$/, (_m, body) => promotionAliases.suggestPromotionSetup(
      String(body.name || ''), String(body.examples || ''), String(body.badExamples || ''))],
    ['PUT', /^\/api\/promotion-rules$/, (_m, body) => { service.savePromotionRule(body); return listPromotions(); }],
    ['DELETE', /^\/api\/promotion-rules\/([a-z0-9-]+)$/, ([, id]) => { store.deletePromotionRule(id); service.reloadPromotions(); }],
  ];

  return async function handle(request, response, url) {
    // Plain-text download of the in-memory log (oldest first), for sharing.
    if (request.method === 'GET' && url.pathname === '/api/logs/download') {
      const text = listLogs({ level: url.searchParams.get('level') || 'debug', limit: 5000 }).reverse().map(formatEntry).join('\n') + '\n';
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
        'content-disposition': `attachment; filename="replayarr-${stamp}.txt"`,
      });
      return response.end(text);
    }
    const route = routes.find(([method, pattern]) => method === request.method && pattern.test(url.pathname));
    if (!route) return send(response, 404, { error: 'Not found' });
    try {
      const body = ['POST', 'PUT'].includes(request.method) ? await readJson(request, route[3]?.maxBody) : {};
      const result = await route[2](url.pathname.match(route[1]), body, url);
      send(response, result === undefined ? 204 : 200, result);
    } catch (error) {
      if (error instanceof UserError || error instanceof MetadataError) {
        log.debug(`${request.method} ${url.pathname}: ${error.message}`, { status: error.status });
        return send(response, error.status, { error: error.message });
      }
      if (error instanceof TransitionError) return send(response, 409, { error: error.message });
      if (error.service) {
        log.warn(`${request.method} ${url.pathname}: ${error.message}`);
        return send(response, 502, { error: error.message });
      }
      log.error(`${request.method} ${url.pathname} failed`, error);
      send(response, 500, { error: 'Something went wrong. See System › Logs.' });
    }
  };
}

function configuredServices(settings) {
  return {

    indexers: settings.indexers.some(indexerReady),
    qbittorrent: !!settings.qbittorrent.url,
    sabnzbd: !!(settings.sabnzbd.url && settings.sabnzbd.apiKey),
    library: !!settings.library.root,
  };
}
