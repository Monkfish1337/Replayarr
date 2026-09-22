import { TransitionError } from './store.js';
import { UserError } from './service.js';
import { loadSettings, publicSettings, saveSettings } from './settings.js';
import { listPromotions, promotionAliases } from './matching/index.js';

const MAX_BODY = 256 * 1024;

async function readJson(request) {
  // Requiring a JSON content type means a cross-site form cannot reach these
  // routes without a CORS preflight, which this server never grants.
  if (!/^application\/json\b/i.test(request.headers['content-type'] || '')) {
    throw new UserError('Send the request body as application/json.', 415);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new UserError('Request body too large.', 413);
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new UserError('The request body is not valid JSON.'); }
}

function send(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
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

export function createApi(service, { testers, version = '', databasePath = '' }) {
  const { store } = service;
  const startedAt = new Date().toISOString();
  const routes = [
    ['GET', /^\/api\/overview$/, () => ({
      counts: store.counts(),
      review: store.listRequests({ status: 'review' }).map((r) => requestView(store, r)),
      activity: store.listActivity(8),
      configured: configuredServices(loadSettings(store)),
    })],
    ['GET', /^\/api\/promotions$/, () => {
      const stats = store.promotionStats();
      return listPromotions().map((p) => ({ ...p, stats: stats[p.id] || { events: 0, requested: 0, downloaded: 0, nextDate: null, lastDate: null } }));
    }],
    ['GET', /^\/api\/queue$/, () => store.queue().map((job) => ({
      ...job,
      request: requestView(store, store.getRequest(job.requestId)),
      candidate: store.getCandidate(job.candidateId),
    }))],
    ['GET', /^\/api\/health$/, () => service.health()],
    ['GET', /^\/api\/system\/status$/, () => ({
      version, node: process.version, platform: process.platform, database: databasePath,
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
    ['GET', /^\/api\/library$/, () => store.listLibrary().map((item) => ({ ...item, event: store.getEvent(item.eventId) }))],
    ['GET', /^\/api\/settings$/, () => ({ settings: publicSettings(loadSettings(store)), rules: store.listPromotionRules() })],
    ['PUT', /^\/api\/settings$/, (_m, body) => publicSettings(saveSettings(store, body))],
    ['POST', /^\/api\/settings\/test\/(sss|prowlarr|qbittorrent|sabnzbd)$/, async ([, name]) => {
      const settings = loadSettings(store);
      return { ok: true, message: await testers[name](settings[name]) };
    }],
    // SSS's alias learner: turn good/bad example release names into rules.
    ['POST', /^\/api\/promotion-rules\/suggest$/, (_m, body) => promotionAliases.suggestPromotionSetup(
      String(body.name || ''), String(body.examples || ''), String(body.badExamples || ''))],
    ['PUT', /^\/api\/promotion-rules$/, (_m, body) => { service.savePromotionRule(body); return listPromotions(); }],
    ['DELETE', /^\/api\/promotion-rules\/([a-z0-9-]+)$/, ([, id]) => { store.deletePromotionRule(id); service.reloadPromotions(); }],
  ];

  return async function handle(request, response, url) {
    const route = routes.find(([method, pattern]) => method === request.method && pattern.test(url.pathname));
    if (!route) return send(response, 404, { error: 'Not found' });
    try {
      const body = ['POST', 'PUT'].includes(request.method) ? await readJson(request) : {};
      const result = await route[2](url.pathname.match(route[1]), body, url);
      send(response, result === undefined ? 204 : 200, result);
    } catch (error) {
      if (error instanceof UserError) return send(response, error.status, { error: error.message });
      if (error instanceof TransitionError) return send(response, 409, { error: error.message });
      if (error.service) return send(response, 502, { error: error.message });
      console.error(error);
      send(response, 500, { error: 'Something went wrong. Check the server log.' });
    }
  };
}

function configuredServices(settings) {
  return {
    sss: !!settings.sss.manifestUrl,
    prowlarr: !!(settings.prowlarr.url && settings.prowlarr.apiKey),
    qbittorrent: !!settings.qbittorrent.url,
    sabnzbd: !!(settings.sabnzbd.url && settings.sabnzbd.apiKey),
    library: !!settings.library.root,
  };
}
