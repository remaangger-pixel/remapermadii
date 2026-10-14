const url = require('url');
const { isAllowedOrigin } = require('./_safe-url');
const vipAuth = require('./_vip-auth');
const supabaseAdmin = require('./_supabase-admin');

/**
 * Vercel Serverless Function: VIP (18+) gate and data access.
 *
 *   GET /api/vip?action=login&pin=XXXX            -> { ok, exp, token } | 401
 *   GET /api/vip?action=list&exp=...&token=...     -> { ok, items: [...] }
 *   GET /api/vip?action=get&id=123&exp=...&token=... -> { ok, item: {...} }
 *
 * The PIN hash and the token-signing secret live only in _vip-auth.js (server-side), so a
 * token can no longer be forged from the browser the way the old client-side scheme could be.
 * "list"/"get" additionally require the "Public read Movies" RLS policy to be restricted to
 * is18 = false (see enable_rls.sql) — this endpoint uses the Supabase service role key to read
 * is18 = true rows specifically because the anon key can no longer see them.
 */
module.exports = async (req, res) => {
  const origin = req.headers.origin;
  if (!isAllowedOrigin(origin, req.headers.host)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'Origin not allowed' }));
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const send = (status, body) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store'); // VIP data is never cached/shared
    res.end(JSON.stringify(body));
  };

  const query = url.parse(req.url, true).query;
  const action = String(query.action || '');

  try {
    if (action === 'login') {
      const pin = String(query.pin || '');
      if (!vipAuth.checkPin(pin)) return send(401, { ok: false, error: 'PIN salah' });
      return send(200, { ok: true, ...vipAuth.issueSession() });
    }

    if (action === 'list' || action === 'get') {
      if (!vipAuth.verifySession(query.exp, query.token)) {
        return send(401, { ok: false, error: 'Sesi VIP tidak valid atau kedaluwarsa' });
      }
      if (action === 'list') {
        const items = await supabaseAdmin.listVip('Movies');
        return send(200, { ok: true, items });
      }
      // "get" also serves Episodes (joined with their Series) for a VIP series, even though
      // adult.html doesn't browse those yet — keeps a direct episode link working if one is
      // ever marked is18 = true, instead of silently breaking once RLS blocks the anon read.
      const table = query.table === 'Episodes' ? 'Episodes' : 'Movies';
      const select = table === 'Episodes' ? '*, Series(id,title,thumb,imdb_id)' : '*';
      const item = await supabaseAdmin.getById(table, query.id, select);
      if (!item) return send(404, { ok: false, error: 'Tidak ditemukan' });
      return send(200, { ok: true, item });
    }

    return send(400, { ok: false, error: 'Aksi tidak dikenal' });
  } catch (err) {
    console.log('[VIP] ERROR:', err.message);
    const status = err.code === 'NOT_CONFIGURED' ? 500 : 502;
    return send(status, { ok: false, error: 'Gagal memproses permintaan VIP' });
  }
};
