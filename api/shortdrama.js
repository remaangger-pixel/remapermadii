const http = require('http');
const https = require('https');
const url = require('url');

// Simple In-Memory Cache (TTL 10 minutes)
const apiCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

function getCached(key) {
  const item = apiCache.get(key);
  if (!item) return null;
  if (Date.now() - item.timestamp > CACHE_TTL) {
    apiCache.delete(key);
    return null;
  }
  return item.data;
}

function setCached(key, data) {
  apiCache.set(key, { timestamp: Date.now(), data });
}

/**
 * Vercel Serverless Function Proxy for Short Drama API (api.sansekai.my.id)
 */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
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
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Missing endpoint or url parameter' }));
    return;
  }

  // Check Cache
  const cachedData = getCached(targetUrl);
  if (cachedData) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Cache', 'HIT');
    res.end(cachedData);
    return;
  }

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*'
      }
    });

    const bodyText = await response.text();

    if (response.ok && !bodyText.includes('Too Many Requests') && !bodyText.includes('Forbidden') && !bodyText.includes('diblacklist')) {
      setCached(targetUrl, bodyText);
      res.statusCode = 200;
      res.setHeader('Content-Type', response.headers.get('content-type') || 'application/json');
      res.setHeader('X-Cache', 'MISS');
      res.end(bodyText);
      return;
    }

    // Upstream API rate-limited or blocked (403/429/400): return graceful fallback response
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      status: 200,
      message: "Stream fallback active",
      streamUrl: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8",
      data: {
        streamUrl: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"
      }
    }));
  } catch (err) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      status: 200,
      message: "Stream fallback active",
      streamUrl: "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"
    }));
  }
};
