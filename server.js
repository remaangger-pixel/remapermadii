const http = require('http');
const https = require('https');
const url = require('url');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 8000;
const PUBLIC_DIR = __dirname;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4'
};

const server = http.createServer((req, res) => {
  // CORS Headers for all incoming requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Content-Type, Accept-Ranges');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const reqUrl = req.url;
  const parsedUrl = url.parse(reqUrl, true);
  const pathname = parsedUrl.pathname;

  // ROUTE 1: DASH & HLS Proxy Endpoints (/api/dash-proxy, /proxy, /proxy-stream/...)
  if (pathname === '/api/dash-proxy' || pathname === '/proxy' || pathname.startsWith('/proxy-stream/')) {
    handleProxyRequest(req, res);
    return;
  }

  // ROUTE 1B: Short Drama API Proxy (/api/shortdrama)
  if (pathname === '/api/shortdrama') {
    handleShortDramaRequest(req, res);
    return;
  }

  // ROUTE 2: Static File Serving
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);

  // Security check: prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    if (!res.headersSent) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
    }
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      if (!res.headersSent) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      }
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    if (!res.headersSent) {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stats.size
      });
    }

    fs.createReadStream(filePath).pipe(res);
  });
});

/**
 * Construct Proxy URL for a target URL preserving DASH placeholders ($Number$, $RepresentationID$, etc.)
 */
function makeProxyUrl(targetUrlStr, headers = {}, isClearKey = false) {
  const q = new URLSearchParams();
  q.set('url', targetUrlStr);
  if (headers.userAgent) q.set('user_agent', headers.userAgent);
  if (headers.referer) q.set('referer', headers.referer);
  if (headers.origin) q.set('origin', headers.origin);
  if (isClearKey) q.set('clearkey', '1');

  let proxyUrl = `http://localhost:${PORT}/api/dash-proxy?` + q.toString();

  // Restore literal DASH placeholders if encoded (%24Number%24 -> $Number$)
  proxyUrl = proxyUrl
    .replace(/%24Number%24/g, '$Number$')
    .replace(/%24RepresentationID%24/g, '$RepresentationID$')
    .replace(/%24Time%24/g, '$Time$')
    .replace(/%24Bandwidth%24/g, '$Bandwidth$');

  return proxyUrl;
}

/**
 * Extract target URL and custom headers from incoming request (query string or path)
 */
function parseRequestDetails(clientReq) {
  const reqUrl = clientReq.url;

  if (reqUrl.startsWith('/proxy-stream/')) {
    const prefix = '/proxy-stream/';
    const rest = reqUrl.substring(prefix.length);
    const slashIdx = rest.indexOf('/');
    if (slashIdx === -1) return null;

    const hdrStr = rest.substring(0, slashIdx);
    const targetPart = rest.substring(slashIdx + 1);

    let targetUrlStr = null;
    if (targetPart.startsWith('https/')) {
      targetUrlStr = 'https://' + targetPart.substring(6);
    } else if (targetPart.startsWith('http/')) {
      targetUrlStr = 'http://' + targetPart.substring(5);
    } else {
      targetUrlStr = 'https://' + targetPart;
    }

    let headers = {
      userAgent: clientReq.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      referer: '',
      origin: ''
    };

    if (hdrStr !== '-' && hdrStr !== '') {
      try {
        const decoded = Buffer.from(hdrStr, 'base64url').toString('utf-8');
        const parsed = JSON.parse(decoded);
        if (parsed.ua) headers.userAgent = parsed.ua;
        if (parsed.ref) headers.referer = parsed.ref;
        if (parsed.orig) headers.origin = parsed.orig;
      } catch (e) {
        console.warn('⚠️ Header parse error:', e.message);
      }
    }

    return { targetUrlStr, headers, isClearKey: false };
  } else {
    const parsedUrl = url.parse(reqUrl, true);
    const query = parsedUrl.query;
    if (!query.url) return null;

    const headers = {
      userAgent: query.user_agent || clientReq.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      referer: query.referer || '',
      origin: query.origin || ''
    };

    const isClearKey = query.clearkey === '1';

    return { targetUrlStr: query.url, headers, isClearKey };
  }
}

/**
 * Handle Upstream Proxy Requests for M3U8, MPD, and Media Segments
 */
function handleProxyRequest(clientReq, clientRes) {
  const reqDetails = parseRequestDetails(clientReq);
  if (!reqDetails || !reqDetails.targetUrlStr) {
    if (!clientRes.headersSent) {
      clientRes.writeHead(400, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'Invalid or missing target URL' }));
    }
    return;
  }

  const { targetUrlStr, headers, isClearKey } = reqDetails;

  fetchUpstream(targetUrlStr, clientReq, headers, 0, (err, upstreamRes, finalUrl, bodyBuffer) => {
    if (clientRes.headersSent) return;

    if (err) {
      console.log(`[PROXY] TYPE: ERROR | UPSTREAM: ${targetUrlStr} | STATUS: 502 | ERROR: ${err.message}`);
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'Upstream connection failed', details: err.message, targetUrl: targetUrlStr }));
      return;
    }

    const statusCode = upstreamRes.statusCode || 200;
    const contentType = (upstreamRes.headers['content-type'] || '').toLowerCase();
    const isM3U8 = targetUrlStr.includes('.m3u8') || contentType.includes('mpegurl');
    const isMPD = targetUrlStr.includes('.mpd') || contentType.includes('dash+xml');

    const proxyUrlBuilder = (target) => makeProxyUrl(target, headers, isClearKey);

    // CASE 1: Manifest M3U8 Rewriting
    if (isM3U8 && bodyBuffer) {
      const manifestText = bodyBuffer.toString('utf-8');
      const rewrittenManifest = rewriteM3U8(manifestText, finalUrl, proxyUrlBuilder);

      const resHeaders = {
        'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
        'Content-Length': Buffer.byteLength(rewrittenManifest),
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      };

      console.log(`[PROXY] TYPE: MANIFEST (M3U8) | UPSTREAM: ${finalUrl} | STATUS: ${statusCode} | CONTENT-TYPE: ${resHeaders['Content-Type']} | RANGE: NONE | SIZE: ${resHeaders['Content-Length']}`);

      clientRes.writeHead(statusCode, resHeaders);
      clientRes.end(rewrittenManifest);
      return;
    }

    // CASE 2: Manifest MPD Rewriting
    if (isMPD && bodyBuffer) {
      const manifestText = bodyBuffer.toString('utf-8');
      const rewrittenManifest = rewriteMPD(manifestText, finalUrl, proxyUrlBuilder, isClearKey);

      const resHeaders = {
        'Content-Type': 'application/dash+xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(rewrittenManifest),
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      };

      console.log(`[PROXY] TYPE: MANIFEST (MPD) | UPSTREAM: ${finalUrl} | STATUS: ${statusCode} | CONTENT-TYPE: ${resHeaders['Content-Type']} | CLEARKEY: ${isClearKey} | SIZE: ${resHeaders['Content-Length']}`);

      clientRes.writeHead(statusCode, resHeaders);
      clientRes.end(rewrittenManifest);
      return;
    }

    // CASE 3: Segment / Binary Data Direct Pipe
    const responseHeaders = {};

    if (upstreamRes.headers['content-type']) responseHeaders['Content-Type'] = upstreamRes.headers['content-type'];
    if (upstreamRes.headers['content-length']) responseHeaders['Content-Length'] = upstreamRes.headers['content-length'];
    if (upstreamRes.headers['content-range']) responseHeaders['Content-Range'] = upstreamRes.headers['content-range'];
    if (upstreamRes.headers['accept-ranges']) responseHeaders['Accept-Ranges'] = upstreamRes.headers['accept-ranges'];

    const clientRange = clientReq.headers['range'] || 'NONE';
    const resSize = responseHeaders['Content-Length'] || (bodyBuffer ? bodyBuffer.length : 'STREAMING');

    console.log(`[PROXY] TYPE: SEGMENT | UPSTREAM: ${finalUrl} | STATUS: ${statusCode} | CONTENT-TYPE: ${responseHeaders['Content-Type'] || 'binary'} | RANGE: ${clientRange} | SIZE: ${resSize}`);

    clientRes.writeHead(statusCode, responseHeaders);

    if (bodyBuffer) {
      clientRes.end(bodyBuffer);
    } else {
      upstreamRes.pipe(clientRes);
    }
  });
}

/**
 * Perform HTTP/HTTPS upstream request with redirect following & header injection
 */
function fetchUpstream(targetUrlStr, clientReq, customHeaders, redirectCount, callback) {
  if (redirectCount > 6) {
    return callback(new Error('Too many redirects'));
  }

  let callbackCalled = false;
  const safeCallback = (err, upstreamRes, finalUrl, bodyBuffer) => {
    if (callbackCalled) return;
    callbackCalled = true;
    callback(err, upstreamRes, finalUrl, bodyBuffer);
  };

  let parsedUrl;
  try {
    parsedUrl = new url.URL(targetUrlStr);
  } catch (e) {
    return safeCallback(new Error('Invalid URL format: ' + targetUrlStr));
  }

  const lib = parsedUrl.protocol === 'https:' ? https : http;

  const reqHeaders = {
    'User-Agent': customHeaders.userAgent,
    'Accept': '*/*'
  };

  if (customHeaders.referer) reqHeaders['Referer'] = customHeaders.referer;
  if (customHeaders.origin) reqHeaders['Origin'] = customHeaders.origin;

  if (clientReq.headers['range']) {
    reqHeaders['Range'] = clientReq.headers['range'];
  }
  if (clientReq.headers['authorization']) {
    reqHeaders['Authorization'] = clientReq.headers['authorization'];
  }

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: clientReq.method || 'GET',
    headers: reqHeaders,
    timeout: 12000,
    rejectUnauthorized: false
  };

  const upstreamReq = lib.request(options, (upstreamRes) => {
    if ([301, 302, 303, 307, 308].includes(upstreamRes.statusCode) && upstreamRes.headers.location) {
      const redirectedUrl = new url.URL(upstreamRes.headers.location, parsedUrl.href).href;
      return fetchUpstream(redirectedUrl, clientReq, customHeaders, redirectCount + 1, safeCallback);
    }

    const contentType = (upstreamRes.headers['content-type'] || '').toLowerCase();
    const isManifest = targetUrlStr.includes('.m3u8') || targetUrlStr.includes('.mpd') ||
                       contentType.includes('mpegurl') || contentType.includes('dash+xml');

    if (isManifest || upstreamRes.statusCode >= 400) {
      const chunks = [];
      upstreamRes.on('data', chunk => chunks.push(chunk));
      upstreamRes.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        safeCallback(null, upstreamRes, targetUrlStr, bodyBuffer);
      });
      upstreamRes.on('error', err => safeCallback(err));
    } else {
      safeCallback(null, upstreamRes, targetUrlStr, null);
    }
  });

  upstreamReq.on('error', err => safeCallback(err));
  upstreamReq.on('timeout', () => {
    upstreamReq.destroy();
    safeCallback(new Error('Upstream request timeout'));
  });

  if (clientReq.method === 'POST' || clientReq.method === 'PUT') {
    clientReq.pipe(upstreamReq);
  } else {
    upstreamReq.end();
  }
}

/**
 * Rewrite HLS M3U8 Manifest lines so all segment & child playlist URLs route via proxy
 */
function rewriteM3U8(manifestText, manifestUrl, proxyUrlBuilder) {
  const lines = manifestText.split('\n');
  const rewritten = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) {
      rewritten.push('');
      continue;
    }

    if (line.startsWith('#')) {
      if (line.includes('URI="')) {
        line = line.replace(/URI=["']([^"']+)["']/g, (match, p1) => {
          let absUrl;
          try {
            absUrl = new url.URL(p1, manifestUrl).href;
          } catch (e) {
            absUrl = p1;
          }
          return `URI="${proxyUrlBuilder(absUrl)}"`;
        });
      }
      rewritten.push(line);
    } else {
      let absUrl;
      try {
        absUrl = new url.URL(line, manifestUrl).href;
      } catch (e) {
        absUrl = line;
      }
      rewritten.push(proxyUrlBuilder(absUrl));
    }
  }

  return rewritten.join('\n');
}

/**
 * Rewrite MPEG-DASH MPD Manifest XML by resolving all relative segment & template URLs against upstream base directory
 */
function rewriteMPD(manifestText, manifestUrl, proxyUrlBuilder, isClearKey = false) {
  let manifestDirUrl = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
  if (!manifestDirUrl.endsWith('/')) manifestDirUrl += '/';

  const toProxiedUrl = (urlStr) => {
    let absUrl;
    try {
      absUrl = new url.URL(urlStr.trim(), manifestDirUrl).href;
    } catch (e) {
      absUrl = urlStr;
    }
    return proxyUrlBuilder(absUrl);
  };

  // If isClearKey is true for this channel:
  if (isClearKey) {
    // 1. Remove Widevine ContentProtection (whether self-closing or with closing tag)
    manifestText = manifestText.replace(/<ContentProtection[^>]*schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"[\s\S]*?<\/ContentProtection>/gi, '');
    manifestText = manifestText.replace(/<ContentProtection[^>]*schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"[^>]*\/>/gi, '');

    // 2. Remove PlayReady ContentProtection (whether self-closing or with closing tag)
    manifestText = manifestText.replace(/<ContentProtection[^>]*schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"[\s\S]*?<\/ContentProtection>/gi, '');
    manifestText = manifestText.replace(/<ContentProtection[^>]*schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"[^>]*\/>/gi, '');

    // 3. Inject ClearKey ContentProtection as a valid SIBLING tag after mp4protection:2011
    if (!manifestText.includes('e2719d58-a985-b3c9-781a-b030af78d30e')) {
      manifestText = manifestText.replace(
        /(<ContentProtection[^>]*schemeIdUri="urn:mpeg:dash:mp4protection:2011"[^>]*>[\s\S]*?<\/ContentProtection>|<ContentProtection[^>]*schemeIdUri="urn:mpeg:dash:mp4protection:2011"[^>]*\/>)/gi,
        (match) => `${match}\n      <ContentProtection schemeIdUri="urn:uuid:e2719d58-a985-b3c9-781a-b030af78d30e" value="ClearKey"/>`
      );
    }
  }

  // 1. Rewrite initialization="..."
  manifestText = manifestText.replace(/initialization=["']([^"']+)["']/gi, (match, relUrl) => {
    const proxied = toProxiedUrl(relUrl).replace(/&/g, '&amp;');
    return `initialization="${proxied}"`;
  });

  // 2. Rewrite media="..."
  manifestText = manifestText.replace(/media=["']([^"']+)["']/gi, (match, relUrl) => {
    const proxied = toProxiedUrl(relUrl).replace(/&/g, '&amp;');
    return `media="${proxied}"`;
  });

  // 3. Rewrite sourceURL="..."
  manifestText = manifestText.replace(/sourceURL=["']([^"']+)["']/gi, (match, relUrl) => {
    const proxied = toProxiedUrl(relUrl).replace(/&/g, '&amp;');
    return `sourceURL="${proxied}"`;
  });

  // 4. Rewrite index="..."
  manifestText = manifestText.replace(/index=["']([^"']+)["']/gi, (match, relUrl) => {
    const proxied = toProxiedUrl(relUrl).replace(/&/g, '&amp;');
    return `index="${proxied}"`;
  });

  // 5. Rewrite or inject <BaseURL>
  const proxiedBaseDir = proxyUrlBuilder(manifestDirUrl).replace(/&/g, '&amp;');
  if (manifestText.includes('<BaseURL>')) {
    manifestText = manifestText.replace(/<BaseURL>([^<]+)<\/BaseURL>/gi, (match, origBase) => {
      const proxied = toProxiedUrl(origBase.trim()).replace(/&/g, '&amp;');
      return `<BaseURL>${proxied}</BaseURL>`;
    });
  } else {
    manifestText = manifestText.replace(/(<MPD[^>]*>)/i, `$1\n  <BaseURL>${proxiedBaseDir}</BaseURL>`);
  }

  // 6. Rewrite <Location> if present
  if (manifestText.includes('<Location>')) {
    manifestText = manifestText.replace(/<Location>([^<]+)<\/Location>/gi, (match, origLoc) => {
      const proxied = toProxiedUrl(origLoc.trim()).replace(/&/g, '&amp;');
      return `<Location>${proxied}</Location>`;
    });
  }

  return manifestText;
}

const shortDramaCache = new Map();
const SD_CACHE_TTL = 10 * 60 * 1000;

function handleShortDramaRequest(clientReq, clientRes) {
  const parsedUrl = url.parse(clientReq.url, true);
  const query = parsedUrl.query;
  const endpoint = query.endpoint;
  const targetUrlParam = query.url;

  let targetUrl = '';
  if (endpoint) {
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
    const queryParams = new URLSearchParams();
    Object.keys(query).forEach(k => {
      if (k !== 'endpoint' && k !== 'url') queryParams.set(k, query[k]);
    });
    const qs = queryParams.toString();
    targetUrl = `https://api.sansekai.my.id/api${cleanEndpoint}` + (qs ? `?${qs}` : '');
  } else if (targetUrlParam) {
    targetUrl = targetUrlParam;
  } else {
    clientRes.writeHead(400, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: 'Missing endpoint or url parameter' }));
    return;
  }

  const cached = shortDramaCache.get(targetUrl);
  if (cached && (Date.now() - cached.timestamp < SD_CACHE_TTL)) {
    clientRes.writeHead(200, {
      'Content-Type': 'application/json',
      'X-Cache': 'HIT'
    });
    clientRes.end(cached.data);
    return;
  }

  try {
    const parsedTarget = new URL(targetUrl);
    const transport = parsedTarget.protocol === 'https:' ? https : http;
    const options = {
      protocol: parsedTarget.protocol,
      hostname: parsedTarget.hostname,
      port: parsedTarget.port || (parsedTarget.protocol === 'https:' ? 443 : 80),
      path: parsedTarget.pathname + parsedTarget.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*'
      }
    };

    const req = transport.request(options, (upstreamRes) => {
      const chunks = [];
      upstreamRes.on('data', chunk => chunks.push(chunk));
      upstreamRes.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf-8');
        if (upstreamRes.statusCode === 200 && !bodyText.includes('Too Many Requests')) {
          shortDramaCache.set(targetUrl, { timestamp: Date.now(), data: bodyText });
        }
        clientRes.writeHead(upstreamRes.statusCode, {
          'Content-Type': upstreamRes.headers['content-type'] || 'application/json',
          'X-Cache': 'MISS'
        });
        clientRes.end(bodyText);
      });
    });

    req.on('error', err => {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'Upstream connection failed', details: err.message }));
    });

    req.end();
  } catch(e) {
    clientRes.writeHead(500, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: 'Invalid URL format', details: e.message }));
  }
}

server.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`🚀 ANVI IPTV Streaming Server & Proxy Active`);
  console.log(`📡 URL: http://localhost:${PORT}`);
  console.log(`⚡ Proxy Route: http://localhost:${PORT}/api/dash-proxy?url=...`);
  console.log(`🎭 Short Drama Route: http://localhost:${PORT}/api/shortdrama?endpoint=...`);
  console.log(`=================================================`);
});
