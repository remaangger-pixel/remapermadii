const https = require('https');
const zlib = require('zlib');

/**
 * Curated global channel list built from the iptv-org API.
 * The two source files are ~11MB of JSON, so they are reduced here (once per 12h) to the
 * few hundred KB the Live TV page actually uses.
 */
const CACHE_MS = 12 * 60 * 60 * 1000;
const MAX_BACKUPS = 5;

const CATEGORY_MAP = {
  sports: '⚽ Olahraga',
  news: '📰 Berita',
  movies: '🎬 Film & Drama',
  animation: '🧒 Kartun & Anak',
  kids: '🧒 Kartun & Anak',
  music: '🎶 Musik',
  documentary: '🧬 Dokumenter',
  religious: '🕌 Religi'
};
const ID_GROUP = '📺 TV Indonesia';

let cache = null;
let loading = null;

function getJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'Accept-Encoding': 'gzip', 'User-Agent': 'anvi-create' }, timeout: 20000 }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects < 3) {
        res.resume();
        return resolve(getJson(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const stream = res.headers['content-encoding'] === 'gzip' ? res.pipe(zlib.createGunzip()) : res;
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Timeout for ' + url)));
    req.on('error', reject);
  });
}

async function build() {
  const [channels, streams] = await Promise.all([
    getJson('https://iptv-org.github.io/api/channels.json'),
    getJson('https://iptv-org.github.io/api/streams.json')
  ]);

  const streamMap = new Map();
  streams.forEach((s) => {
    if (s.channel && s.url && !s.url.includes('.mpd')) {
      if (!streamMap.has(s.channel)) streamMap.set(s.channel, []);
      streamMap.get(s.channel).push(s.url);
    }
  });

  const out = [];
  channels.forEach((c) => {
    const urls = streamMap.get(c.id);
    if (!urls || !urls.length) return;

    let group = null;
    if (c.country === 'ID') group = ID_GROUP;
    else if (c.categories && c.categories.length) group = CATEGORY_MAP[c.categories[0]] || null;
    if (!group) return;

    // The page only uses Indonesian channels and channels with several servers
    if (group !== ID_GROUP && urls.length < 2) return;

    out.push({
      name: c.name,
      tvg_id: c.id,
      group_title: group,
      logo: c.logo || '',
      stream_url: urls[0],
      backup_streams: urls.slice(0, MAX_BACKUPS),
      stream_type: 'hls',
      is_active: true
    });
  });
  return out;
}

async function getCurated() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.list;
  if (!loading) {
    loading = build()
      .then((list) => { cache = { at: Date.now(), list }; return list; })
      .catch((err) => {
        if (cache) return cache.list; // serve stale list rather than nothing
        throw err;
      })
      .finally(() => { loading = null; });
  }
  return loading;
}

module.exports = { getCurated };
