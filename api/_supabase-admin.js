const https = require('https');

/**
 * Minimal Supabase REST client using the service role key, which bypasses Row Level Security.
 * Used only by server endpoints that have already verified a VIP session token (see _vip-auth.js)
 * — never exposed to the browser. No @supabase/supabase-js dependency, to match this project's
 * existing api/*.js files, which all talk to things over plain https.
 */
const SUPABASE_URL = 'https://xvktodveoxnuelhtzaog.supabase.co';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function restRequest(path) {
  return new Promise((resolve, reject) => {
    if (!SERVICE_ROLE_KEY) {
      reject(Object.assign(new Error('SUPABASE_SERVICE_ROLE_KEY is not configured'), { code: 'NOT_CONFIGURED' }));
      return;
    }
    const req = https.request(
      SUPABASE_URL + path,
      {
        method: 'GET',
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          Accept: 'application/json'
        },
        timeout: 10000
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Supabase ${res.statusCode}: ${body.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error('Supabase returned non-JSON response'));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('Supabase request timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** All rows of `table` where is18 = true. */
async function listVip(table) {
  const rows = await restRequest(`/rest/v1/${encodeURIComponent(table)}?select=*&is18=eq.true&order=created_at.desc`);
  return Array.isArray(rows) ? rows : [];
}

/** One row of `table` by numeric id, regardless of is18 — the VIP token already gates access to this. */
async function getById(table, id, select = '*') {
  if (!/^\d+$/.test(String(id))) return null;
  const rows = await restRequest(`/rest/v1/${encodeURIComponent(table)}?select=${encodeURIComponent(select)}&id=eq.${encodeURIComponent(id)}&limit=1`);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

module.exports = { listVip, getById };
