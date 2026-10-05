const dns = require('dns');
const net = require('net');

/**
 * SSRF guards shared by the Vercel proxy and the local dev server.
 * Files prefixed with "_" in /api are not deployed as routes.
 */

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => Number.isNaN(n))) return true;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local + cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast + reserved
  );
}

function isPrivateIP(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIPv4(mapped[1]);
    const hex = l.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
      return isPrivateIPv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return (
      l === '::' ||
      l === '::1' ||
      l.startsWith('fc') ||
      l.startsWith('fd') ||
      l.startsWith('fe8') ||
      l.startsWith('fe9') ||
      l.startsWith('fea') ||
      l.startsWith('feb') ||
      l.startsWith('ff')
    );
  }
  return true;
}

/**
 * Validate a URL string before connecting. Returns the parsed URL or throws.
 * IP literals are checked here; hostnames are checked at connect time by safeLookup.
 */
function assertSafeTarget(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch (e) {
    throw new Error('Invalid upstream URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http/https upstream URLs are allowed');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host.toLowerCase() === 'localhost' || host.toLowerCase().endsWith('.localhost')) {
    throw new Error('Upstream host not allowed');
  }
  if (net.isIP(host) && isPrivateIP(host)) {
    throw new Error('Upstream host not allowed');
  }
  return u;
}

/**
 * dns.lookup replacement for http(s).request({ lookup }). Rejects private
 * addresses at the moment of connection, so DNS rebinding cannot bypass it.
 */
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err);
    const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: 4 }];
    const bad = list.find(a => isPrivateIP(a.address));
    if (bad || !list.length) return callback(new Error('Upstream host not allowed'));
    if (options && options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

const ALLOWED_ORIGIN_RE = /^(localhost|127\.0\.0\.1|\[::1\]|anvicreate\.web\.id|([a-z0-9-]+\.)*vercel\.app)$/i;

/** True if a browser Origin header may use the proxy. Missing Origin (native players, curl) is allowed. */
function isAllowedOrigin(origin, requestHost) {
  if (!origin) return true;
  try {
    const h = new URL(origin).hostname;
    if (requestHost && h === requestHost.split(':')[0]) return true;
    return ALLOWED_ORIGIN_RE.test(h);
  } catch (e) {
    return false;
  }
}

module.exports = { assertSafeTarget, safeLookup, isAllowedOrigin, isPrivateIP };
