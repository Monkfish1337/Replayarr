export class ServiceError extends Error {
  constructor(service, message, status) {
    super(`${service}: ${message}`);
    this.service = service;
    this.status = status;
  }
}

export function joinUrl(base, path) {
  return String(base || '').replace(/\/+$/, '') + path;
}

// fetch with a hard timeout and a bounded body, so one slow or oversized
// response from an external service cannot stall the worker.
export async function request(service, url, { timeoutMs = 20000, maxBytes = 8 * 1024 * 1024, ...init } = {}) {
  if (!/^https?:\/\//i.test(String(url))) throw new ServiceError(service, 'URL is not configured');
  let response;
  try {
    response = await fetch(url, { ...init, redirect: init.redirect || 'follow', signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : (error.cause?.code || error.message);
    throw new ServiceError(service, reason);
  }
  const length = Number(response.headers.get('content-length') || 0);
  if (length > maxBytes) throw new ServiceError(service, 'response too large', response.status);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new ServiceError(service, 'response too large', response.status);
  const text = buffer.toString('utf8');
  if (!response.ok) throw new ServiceError(service, `HTTP ${response.status} ${text.slice(0, 160)}`.trim(), response.status);
  return { response, text };
}

export async function requestJson(service, url, options) {
  const { response, text } = await request(service, url, options);
  try {
    return { response, body: JSON.parse(text) };
  } catch {
    throw new ServiceError(service, 'returned invalid JSON', response.status);
  }
}
