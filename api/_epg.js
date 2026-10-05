const https = require('https');

/**
 * XMLTV guide loader. The guide is ~10MB, so it is downloaded once, reduced to
 * the programmes that matter right now, and cached in memory.
 */
const GUIDE_URL = 'https://raw.githubusercontent.com/apistech/project/refs/heads/main/epgs/guide.xml';
const CACHE_MS = 3 * 60 * 60 * 1000;
const MAX_BYTES = 40 * 1024 * 1024;
const WINDOW_BEFORE_MS = 60 * 60 * 1000;
const WINDOW_AFTER_MS = 36 * 60 * 60 * 1000;

let cache = null; // { at, byId: Map<string, Programme[]> }
let loading = null;

function download(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000 }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 3) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('Guide HTTP ' + res.statusCode));
      }
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > MAX_BYTES) return res.destroy(new Error('Guide too large'));
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Guide timeout')));
    req.on('error', reject);
  });
}

function parseXmltvTime(str) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/.exec(str || '');
  if (!m) return NaN;
  const tz = m[7] || '+0000';
  const offsetMin = (tz[0] === '-' ? -1 : 1) * (parseInt(tz.slice(1, 3), 10) * 60 + parseInt(tz.slice(3, 5), 10));
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - offsetMin * 60000;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
    .replace(/&amp;/g, '&');
}

function parseGuide(xml, now) {
  const byId = new Map();
  const seen = new Set();
  const re = /<programme\s+([^>]*)>([\s\S]*?)<\/programme>/g;
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    const start = parseXmltvTime((/start="([^"]*)"/.exec(attrs) || [])[1]);
    const stop = parseXmltvTime((/stop="([^"]*)"/.exec(attrs) || [])[1]);
    const channel = (/channel="([^"]*)"/.exec(attrs) || [])[1];
    if (!channel || !(start < stop)) continue;
    if (stop < now - WINDOW_BEFORE_MS || start > now + WINDOW_AFTER_MS) continue;

    const title = (/<title[^>]*>([\s\S]*?)<\/title>/.exec(m[2]) || [])[1];
    if (!title) continue;
    const desc = (/<desc[^>]*>([\s\S]*?)<\/desc>/.exec(m[2]) || [])[1] || '';

    const key = channel + '|' + start + '|' + stop + '|' + title;
    if (seen.has(key)) continue; // the source guide repeats some programmes
    seen.add(key);

    const prog = { s: start, e: stop, t: decodeEntities(title).trim(), d: decodeEntities(desc).trim().slice(0, 300) };
    if (!byId.has(channel)) byId.set(channel, []);
    byId.get(channel).push(prog);
  }
  byId.forEach((list) => list.sort((a, b) => a.s - b.s));
  return byId;
}

async function getGuide() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.byId;
  if (!loading) {
    loading = download(GUIDE_URL)
      .then((xml) => {
        cache = { at: Date.now(), byId: parseGuide(xml, Date.now()) };
        return cache.byId;
      })
      .catch((err) => {
        if (cache) return cache.byId; // serve stale guide rather than nothing
        throw err;
      })
      .finally(() => { loading = null; });
  }
  return loading;
}

/** Look up a channel by exact id, then case-insensitive, then ignoring the "@variant" suffix. */
function findProgrammes(byId, id) {
  if (byId.has(id)) return byId.get(id);
  const lower = id.toLowerCase();
  const base = lower.split('@')[0];
  for (const [key, list] of byId) {
    const k = key.toLowerCase();
    if (k === lower || k.split('@')[0] === base) return list;
  }
  return null;
}

/** Returns { [id]: Programme[] } with programmes that are running now or upcoming (max 6 each). */
async function lookup(ids) {
  const byId = await getGuide();
  const now = Date.now();
  const out = {};
  ids.slice(0, 20).forEach((id) => {
    const list = findProgrammes(byId, id);
    if (!list) return;
    const upcoming = list.filter((p) => p.e > now).slice(0, 6);
    if (upcoming.length) out[id] = upcoming;
  });
  return out;
}

module.exports = { lookup, parseGuide, parseXmltvTime };
