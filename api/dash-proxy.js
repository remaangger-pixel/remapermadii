const http = require('http');
const https = require('https');
const url = require('url');

/**
 * Vercel Serverless Function Proxy for DASH (.mpd) and HLS (.m3u8) Streams
 */
module.exports = async (req, res) => {
  // CORS Headers allowing any origin including https://anvicreate.web.id
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
        res.end(JSON.stringify({ error: 'Upstream connection failed', details: err.message, targetUrl: targetUrlStr }));
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

      // CASE 1: M3U8 Manifest Rewriting
      if (isM3U8 && bodyBuffer) {
        const manifestText = bodyBuffer.toString('utf-8');
        const rewritten = rewriteM3U8(manifestText, finalUrl, proxyUrlBuilder);
        res.statusCode = statusCode;
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(rewritten));
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.end(rewritten);
        return;
      }

      // CASE 2: MPD Manifest Rewriting
      if (isMPD && bodyBuffer) {
        const manifestText = bodyBuffer.toString('utf-8');
        const rewritten = rewriteMPD(manifestText, finalUrl, proxyUrlBuilder, isClearKey);
        res.statusCode = statusCode;
        res.setHeader('Content-Type', 'application/dash+xml; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(rewritten));
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.end(rewritten);
        return;
      }

      // CASE 3: Segment / Binary Streaming
      const responseHeaders = {};
      if (upstreamRes.headers['content-type']) responseHeaders['Content-Type'] = upstreamRes.headers['content-type'];
      if (upstreamRes.headers['content-length']) responseHeaders['Content-Length'] = upstreamRes.headers['content-length'];
      if (upstreamRes.headers['content-range']) responseHeaders['Content-Range'] = upstreamRes.headers['content-range'];
      if (upstreamRes.headers['accept-ranges']) responseHeaders['Accept-Ranges'] = upstreamRes.headers['accept-ranges'];

      res.statusCode = statusCode;
      Object.keys(responseHeaders).forEach(h => res.setHeader(h, responseHeaders[h]));

      if (bodyBuffer) {
        res.end(bodyBuffer);
      } else {
        upstreamRes.pipe(res);
      }
    });
  } catch (e) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
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
  let manifestDirUrl = baseUrlStr;
  try {
    const u = new URL(baseUrlStr);
    const lastSlash = u.pathname.lastIndexOf('/');
    manifestDirUrl = u.origin + (lastSlash !== -1 ? u.pathname.substring(0, lastSlash + 1) : u.pathname);
  } catch (e) {}

  const toProxiedUrl = (relOrAbsUrl) => {
    try {
      const absUrl = new URL(relOrAbsUrl, manifestDirUrl).toString();
      return proxyUrlBuilder(absUrl);
    } catch (e) {
      return relOrAbsUrl;
    }
  };

  if (isClearKey) {
    manifestText = manifestText.replace(/<ContentProtection[^>]*schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"[\s\S]*?<\/ContentProtection>/gi, '');
    manifestText = manifestText.replace(/<ContentProtection[^>]*schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"[^>]*\/>/gi, '');
    manifestText = manifestText.replace(/<ContentProtection[^>]*schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"[\s\S]*?<\/ContentProtection>/gi, '');
    manifestText = manifestText.replace(/<ContentProtection[^>]*schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"[^>]*\/>/gi, '');

    if (!manifestText.includes('e2719d58-a985-b3c9-781a-b030af78d30e')) {
      manifestText = manifestText.replace(
        /(<ContentProtection[^>]*schemeIdUri="urn:mpeg:dash:mp4protection:2011"[^>]*>[\s\S]*?<\/ContentProtection>|<ContentProtection[^>]*schemeIdUri="urn:mpeg:dash:mp4protection:2011"[^>]*\/>)/gi,
        (match) => `${match}\n      <ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e" value="ClearKey"/>`
      );
    }
  }

  manifestText = manifestText.replace(/initialization=["']([^"']+)["']/gi, (match, relUrl) => {
    const proxied = toProxiedUrl(relUrl).replace(/&/g, '&amp;');
    return `initialization="${proxied}"`;
  });

  manifestText = manifestText.replace(/media=["']([^"']+)["']/gi, (match, relUrl) => {
    const proxied = toProxiedUrl(relUrl).replace(/&/g, '&amp;');
    return `media="${proxied}"`;
  });

  manifestText = manifestText.replace(/sourceURL=["']([^"']+)["']/gi, (match, relUrl) => {
    const proxied = toProxiedUrl(relUrl).replace(/&/g, '&amp;');
    return `sourceURL="${proxied}"`;
  });

  manifestText = manifestText.replace(/index=["']([^"']+)["']/gi, (match, relUrl) => {
    const proxied = toProxiedUrl(relUrl).replace(/&/g, '&amp;');
    return `index="${proxied}"`;
  });

  const proxiedBaseDir = proxyUrlBuilder(manifestDirUrl).replace(/&/g, '&amp;');
  if (manifestText.includes('<BaseURL>')) {
    manifestText = manifestText.replace(/<BaseURL>([^<]+)<\/BaseURL>/gi, (match, origBase) => {
      const proxied = toProxiedUrl(origBase.trim()).replace(/&/g, '&amp;');
      return `<BaseURL>${proxied}</BaseURL>`;
    });
  } else {
    manifestText = manifestText.replace(/(<MPD[^>]*>)/i, `$1\n  <BaseURL>${proxiedBaseDir}</BaseURL>`);
  }

  if (manifestText.includes('<Location>')) {
    manifestText = manifestText.replace(/<Location>([^<]+)<\/Location>/gi, (match, origLoc) => {
      const proxied = toProxiedUrl(origLoc.trim()).replace(/&/g, '&amp;');
      return `<Location>${proxied}</Location>`;
    });
  }

  return manifestText;
}
