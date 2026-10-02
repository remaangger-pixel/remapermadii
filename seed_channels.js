const CATEGORY_MAP = {
  'sports': '⚽ Olahraga',
  'news': '📰 Berita',
  'movies': '🎬 Film & Drama',
  'animation': '🧒 Kartun & Anak',
  'kids': '🧒 Kartun & Anak',
  'music': '🎶 Musik',
  'documentary': '🧬 Dokumenter',
  'religious': '🕌 Religi',
  'general': '📺 TV Indonesia'
};

async function buildCuratedIPTVChannels() {
  console.log('Fetching IPTV-org channels & streams...');
  const [channelsRes, streamsRes] = await Promise.all([
    fetch("https://iptv-org.github.io/api/channels.json").then(r => r.json()),
    fetch("https://iptv-org.github.io/api/streams.json").then(r => r.json())
  ]);

  const streamMap = new Map();
  streamsRes.forEach(s => {
    if (s.channel && s.url && !s.url.includes('.mpd')) {
      if (!streamMap.has(s.channel)) streamMap.set(s.channel, []);
      streamMap.get(s.channel).push(s);
    }
  });

  const curated = [];

  channelsRes.forEach(c => {
    const streams = streamMap.get(c.id);
    if (!streams || !streams.length) return;

    const streamUrl = streams[0].url;
    let groupTitle = null;

    if (c.country === 'ID') {
      groupTitle = '📺 TV Indonesia';
    } else if (c.categories && c.categories.length) {
      const cat = c.categories[0];
      if (CATEGORY_MAP[cat] && CATEGORY_MAP[cat] !== '📺 TV Indonesia') {
        groupTitle = CATEGORY_MAP[cat];
      }
    }

    if (groupTitle) {
      curated.push({
        name: c.name,
        group_title: groupTitle,
        logo: c.logo || `https://raw.githubusercontent.com/iptv-org/iptv/master/logos/${c.id}.png`,
        stream_url: streamUrl,
        stream_type: streamUrl.includes('.mpd') ? 'dash' : 'hls',
        is_active: true
      });
    }
  });

  console.log(`Successfully curated ${curated.length} channels from IPTV-org.`);

  const summary = {};
  curated.forEach(c => {
    summary[c.group_title] = (summary[c.group_title] || 0) + 1;
  });
  console.log('Channel summary by group:', summary);

  return curated;
}

buildCuratedIPTVChannels();
