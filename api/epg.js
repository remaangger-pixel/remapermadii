const { isAllowedOrigin } = require('./_safe-url');
const epg = require('./_epg');

/**
 * Vercel Serverless Function: Live TV programme guide (/api/epg?ids=RCTI.id,ANTV.id)
 *
 * A twin of the /api/epg route already wired into server.js (the self-hosted dev server).
 * Vercel only deploys files directly under /api as routes — _epg.js and _safe-url.js are
 * underscore-prefixed on purpose so they're treated as shared modules, not routes, which
 * means this file (not _epg.js) is what actually serves /api/epg in production.
 */
module.exports = async (req, res) => {
  const origin = req.headers.origin;
  if (!isAllowedOrigin(origin, req.headers.host)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Origin not allowed' }));
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = require('url');
  const query = url.parse(req.url, true).query;
  const ids = String(query.ids || '').split(',').map((x) => x.trim()).filter(Boolean);

  try {
    const data = await epg.lookup(ids);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.end(JSON.stringify(data));
  } catch (err) {
    console.log('[EPG] ERROR:', err.message);
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'EPG unavailable' }));
  }
};
