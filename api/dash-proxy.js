const http = require('http');
const https = require('https');
const url = require('url');

/**
 * Vercel Serverless Function Proxy for DASH (.mpd) and HLS (.m3u8) Streams
 */
module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type, Accept-Ranges');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const query = parsedUrl.query;
  const targetUrlStr = query.url;

  if (!targetUrlStr) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing target url parameter' }));
    return;
  }

  const headers = {
    userAgent: query.user_agent || req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    referer: query.referer || '',
    origin: query.origin || ''
  };

  const isClearKey = query.clearkey === '1';

  try {
    fetchUpstream(targetUrlStr, req, headers, 0, (err, upstreamRes, finalUrl, bodyBuffer) => {
      if (err) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Upstream connection failed', details: err.message }));
        return;
      }

      const statusCode = upstreamRes.statusCode || 200;
      const contentType = (upstreamRes.headers['content-type'] || '').toLowerCase();
      const isM3U8 = targetUrlStr.includes('.m3u8') || contentType.includes('mpegurl');
      const isMPD = targetUrlStr.includes('.mpd') || contentType.includes('dash+xml');

      const protocol = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['host'];
      const proxyBaseUrl = `${protocol}://${host}/api/dash-proxy`;

      const proxyUrlBuilder = (target) => {
        const q = new URLSearchParams();
        q.set('url', target);
        if (headers.userAgent) q.set('user_agent', headers.userAgent);
        if (headers.referer) q.set('referer', headers.referer);
        if (headers.origin) q.set('origin', headers.origin);
        if (isClearKey) q.set('clearkey', '1');

        let pUrl = `${proxyBaseUrl}?` + q.toString();
        return pUrl
          .replace(/%24Number%24/g, '$Number$')
          .replace(/%24RepresentationID%24/g, '$RepresentationID$')
          .replace(/%24Time%24/g, '$Time$')
          .replace(/%24Bandwidth%24/g, '$Bandwidth$');
      };

      if (isM3U8 && bodyBuffer) {
        const manifestText = bodyBuffer.toString('utf-8');
        const rewritten = rewriteM3U8(manifestText, finalUrl, proxyUrlBuilder);
        res.statusCode = statusCode;
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(rewritten));
        res.end(rewritten);
        return;
      }

      if (isMPD && bodyBuffer) {
        const manifestText = bodyBuffer.toString('utf-8');
        const rewritten = rewriteMPD(manifestText, finalUrl, proxyUrlBuilder, isClearKey);
        res.statusCode = statusCode;
        res.setHeader('Content-Type', 'application/dash+xml; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(rewritten));
        res.end(rewritten);
        return;
      }

      // Stream segments directly
      const resHeaders = {};
      if (upstreamRes.headers['content-type']) resHeaders['Content-Type'] = upstreamRes.headers['content-type'];
      if (upstreamRes.headers['content-length']) resHeaders['Content-Length'] = upstreamRes.headers['content-length'];
      if (upstreamRes.headers['content-range']) resHeaders['Content-Range'] = upstreamRes.headers['content-range'];
      if (upstreamRes.headers['accept-ranges']) resHeaders['Accept-Ranges'] = upstreamRes.headers['accept-ranges'];

      res.statusCode = statusCode;
      Object.keys(resHeaders).forEach(h => res.setHeader(h, resHeaders[h]));

      if (bodyBuffer) {
        res.end(bodyBuffer);
      } else {
        upstreamRes.pipe(res);
      }
    });
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
};

function fetchUpstream(targetUrlStr, clientReq, headers, redirectCount, callback) {
  if (redirectCount > 5) return callback(new Error('Too many redirects'));

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrlStr);
  } catch (e) {
    return callback(new Error('Invalid upstream URL'));
  }

  const transport = parsedTarget.protocol === 'https:' ? https : http;

  const requestHeaders = {
    'User-Agent': headers.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'Accept': clientReq.headers['accept'] || '*/*',
    'Accept-Language': clientReq.headers['accept-language'] || 'en-US,en;q=0.9',
    'Connection': 'keep-alive'
  };

  if (headers.referer) requestHeaders['Referer'] = headers.referer;
  if (headers.origin) requestHeaders['Origin'] = headers.origin;
  if (clientReq.headers['range']) requestHeaders['Range'] = clientReq.headers['range'];

  const options = {
    protocol: parsedTarget.protocol,
    hostname: parsedTarget.hostname,
    port: parsedTarget.port || (parsedTarget.protocol === 'https:' ? 443 : 80),
    path: parsedTarget.pathname + parsedTarget.search,
    method: clientReq.method || 'GET',
    headers: requestHeaders
  };

  const req = transport.request(options, (upstreamRes) => {
    if ([301, 302, 303, 307, 308].includes(upstreamRes.statusCode) && upstreamRes.headers.location) {
      const redirectUrl = new URL(upstreamRes.headers.location, targetUrlStr).toString();
      return fetchUpstream(redirectUrl, clientReq, headers, redirectCount + 1, callback);
    }

    const contentType = (upstreamRes.headers['content-type'] || '').toLowerCase();
    const isManifest = targetUrlStr.includes('.m3u8') || targetUrlStr.includes('.mpd') || contentType.includes('mpegurl') || contentType.includes('dash+xml');

    if (isManifest) {
      const chunks = [];
      upstreamRes.on('data', chunk => chunks.push(chunk));
      upstreamRes.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        callback(null, upstreamRes, targetUrlStr, bodyBuffer);
      });
    } else {
      callback(null, upstreamRes, targetUrlStr, null);
    }
  });

  req.on('error', err => callback(err));
  req.end();
}

function rewriteM3U8(manifestText, baseUrlStr, proxyUrlBuilder) {
  const lines = manifestText.split(/\r?\n/);
  const rewritten = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    try {
      const absoluteUrl = new URL(trimmed, baseUrlStr).toString();
      return proxyUrlBuilder(absoluteUrl);
    } catch (e) {
      return line;
    }
  });
  return rewritten.join('\n');
}

function rewriteMPD(manifestText, baseUrlStr, proxyUrlBuilder, isClearKey) {
  let rewritten = manifestText;

  if (isClearKey && !rewritten.includes('1077efec-c0b2-4d02-ace3-3c1e52e2fb4b')) {
    const clearkeyXml = `<ContentProtection schemeIdUri="urn:uuid:1077efec-c0b2-4d02-ace3-3c1e52e2fb4b" value="ClearKey"/>`;
    if (rewritten.includes('<AdaptationSet')) {
      rewritten = rewritten.replace(/<AdaptationSet([^>]*)>/gi, `<AdaptationSet$1>\n      ${clearkeyXml}`);
    }
  }

  const baseUrlRegex = /<BaseURL>([^<]+)<\/BaseURL>/gi;
  rewritten = rewritten.replace(baseUrlRegex, (match, p1) => {
    try {
      const absUrl = new URL(p1.trim(), baseUrlStr).toString();
      return `<BaseURL>${proxyUrlBuilder(absUrl)}</BaseURL>`;
    } catch (e) {
      return match;
    }
  });

  return rewritten;
}
