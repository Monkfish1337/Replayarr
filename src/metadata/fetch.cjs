'use strict';

// Stands in for node-fetch in the sources ported from SSS: the same call
// shape on Node's built-in fetch, including node-fetch's `timeout` option.
module.exports = function fetchCompat(url, options = {}) {
  const { timeout, agent: _agent, size: _size, compress: _compress, ...init } = options;
  if (Number(timeout) > 0 && !init.signal) init.signal = AbortSignal.timeout(Number(timeout));
  return fetch(url, init);
};
