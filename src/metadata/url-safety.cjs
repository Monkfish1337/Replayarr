// Ported from SeriousSportSync (Monkfish1337/Serioussportsync @ 0706d4d), lib/security.js (URL checks only).
'use strict';

const net = require('net');

const CLOUD_METADATA_HOSTS = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  'metadata.google.internal',
  'metadata.google',
  'fd00:ec2::254',
]);

function isCloudMetadataHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (CLOUD_METADATA_HOSTS.has(host)) return true;
  if (net.isIP(host) === 4) {
    const parts = host.split('.').map(Number);
    return parts[0] === 169 && parts[1] === 254;
  }
  return false;
}

function cleanHttpUrl(value, options) {
  const opts = options || {};
  const raw = String(value || '').trim();
  if (!raw && opts.allowEmpty !== false) return '';
  if (raw.length > (opts.maxLength || 2048)) throw new Error((opts.label || 'URL') + ' is too long');
  let parsed;
  try { parsed = new URL(raw); }
  catch (_) { throw new Error((opts.label || 'URL') + ' is invalid'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error((opts.label || 'URL') + ' must use HTTP or HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new Error((opts.label || 'URL') + ' must not contain credentials');
  }
  if (!opts.allowSensitiveQuery) {
    for (const key of parsed.searchParams.keys()) {
      if (/^(?:api[_-]?key|apikey|token|access[_-]?token|passkey|password|secret)$/i.test(key)) {
        throw new Error((opts.label || 'URL') + ' must keep credentials in the separate secret field');
      }
    }
  }
  if (isCloudMetadataHost(parsed.hostname)) {
    throw new Error((opts.label || 'URL') + ' cannot target a cloud metadata address');
  }
  return raw.replace(/\/+$/, '');
}

module.exports = { cleanHttpUrl, isCloudMetadataHost };
