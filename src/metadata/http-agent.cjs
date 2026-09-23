'use strict';

// SSS routes some requests through a proxy agent; Replayarr does not, so the
// options pass through unchanged.
module.exports = { fetchOpts: (options) => options };
