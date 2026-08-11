/**
 * Vezvezak proxy Worker — the ONLY place API keys exist.
 *
 * WHY THIS EXISTS (security, P0-7):
 * react-native-dotenv inlines @env values into the JS bundle at build time, so
 * any key shipped in the app can be extracted from the .ipa/.apk with `strings`
 * and spent by anyone — on Ehsan's bill. Keys therefore live ONLY here, as
 * Cloudflare secrets, and are injected server-side. The app never sends a key.
 *
 * DEPLOY:
 *   cd ~/Desktop/Vezvezak/proxy-worker
 *   npx wrangler secret put SERP_API_KEY      # paste the SerpApi key
 *   npx wrangler secret put GOOGLE_API_KEY    # paste the Google key
 *   npx wrangler deploy
 *
 * AFTER DEPLOY: rotate BOTH keys in the SerpApi + Google consoles — the old
 * ones were shipped inside builds and must be considered burned.
 *
 * Routes (unchanged for the app):
 *   /serp/search?engine=...&q=...        -> serpapi.com  (+ api_key injected)
 *   /google/maps/api/<path>?...          -> maps.googleapis.com (+ key injected)
 */

const ALLOWED_SERP_ENGINES = new Set(['google_shopping', 'amazon', 'google_local']);
const ALLOWED_GOOGLE_PATHS = [
  'place/nearbysearch/json',
  'place/textsearch/json',
  'place/details/json',
  'place/photo',
  'geocode/json',
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

// Round a "lat,lng" param to ~3 decimals (~110m) so nearby users share a cache
// entry. Leaves anything unparseable untouched.
function roundLatLng(v) {
  const parts = String(v).split(',');
  if (parts.length !== 2) return v;
  const r = (x) => { const n = Number(x); return Number.isFinite(n) ? n.toFixed(3) : x; };
  return `${r(parts[0])},${r(parts[1])}`;
}

export default {
  async fetch(request, env) {
    // Only GET and OPTIONS (CORS preflight) are allowed. Any other method — incl.
    // HEAD — returns 405 BEFORE it can reach Google/SerpApi. So `curl -sI` (which
    // sends HEAD) returns 405: that is CORRECT, not a broken route. Test with
    // `curl -s -D -` (a GET), and read the x-vz-cache header for HIT/MISS.
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'GET') return json(405, { error: 'method_not_allowed' });

    const url = new URL(request.url);
    const { pathname, searchParams } = url;

    try {
      // ---- SerpApi -------------------------------------------------------
      if (pathname === '/serp/search') {
        if (!env.SERP_API_KEY) return json(500, { error: 'serp_key_not_configured' });

        const engine = searchParams.get('engine') || '';
        // Allowlist the engines we actually use, so a stolen endpoint can't be
        // turned into a general-purpose paid-API relay.
        if (!ALLOWED_SERP_ENGINES.has(engine)) return json(400, { error: 'engine_not_allowed' });

        const upstream = new URL('https://serpapi.com/search.json');
        for (const [k, v] of searchParams) {
          if (k === 'api_key') continue;           // never accept a key from the client
          upstream.searchParams.set(k, v);
        }
        upstream.searchParams.set('api_key', env.SERP_API_KEY);   // injected here

        const res = await fetch(upstream.toString(), {
          headers: { Accept: 'application/json' },
          cf: { cacheTtl: 300, cacheEverything: true },  // 5-min cache = fewer paid calls
        });
        const body = await res.text();
        return new Response(body, {
          status: res.status,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', 'x-vz-cache': res.headers.get('cf-cache-status') || 'UNKNOWN', ...CORS },
        });
      }

      // ---- Google Maps / Places -----------------------------------------
      if (pathname.startsWith('/google/maps/api/')) {
        if (!env.GOOGLE_API_KEY) return json(500, { error: 'google_key_not_configured' });

        const path = pathname.replace('/google/maps/api/', '');
        if (!ALLOWED_GOOGLE_PATHS.some(p => path === p || path.startsWith(p))) {
          return json(400, { error: 'path_not_allowed' });
        }

        // Places data (a store's name/location) is identical for every user, so
        // it must be cached server-side — it was NOT before, which made Places
        // ~89% of per-search cost. Round coordinates to ~3dp (~110m) so two users
        // on the same street share ONE cache entry, and sort params so the cache
        // key can't fragment on order.
        const params = new URLSearchParams();
        for (const [k, v] of searchParams) {
          if (k === 'key') continue;               // never accept a key from the client
          params.set(k, k === 'location' ? roundLatLng(v) : v);
        }
        params.set('key', env.GOOGLE_API_KEY);     // injected here (constant → doesn't fragment the key)
        const upstream = new URL(`https://maps.googleapis.com/maps/api/${path}`);
        for (const [k, v] of [...params.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
          upstream.searchParams.set(k, v);
        }

        // TTL by endpoint: search results 24h, photos 7 days. Place photos redirect
        // to a signed image URL — follow and stream so the key is never exposed.
        const ttl = path.startsWith('place/photo') ? 604800 : 86400;
        const res = await fetch(upstream.toString(), {
          redirect: 'follow',
          cf: { cacheTtl: ttl, cacheEverything: true },   // shared edge cache — the whole point of this change
        });
        const headers = new Headers(CORS);
        headers.set('Content-Type', res.headers.get('Content-Type') || 'application/json');
        headers.set('Cache-Control', `public, max-age=${ttl}`);
        headers.set('x-vz-cache', res.headers.get('cf-cache-status') || 'UNKNOWN'); // observe the shared-cache HIT/MISS
        return new Response(res.body, { status: res.status, headers });
      }

      return json(404, { error: 'not_found' });
    } catch (err) {
      return json(502, { error: 'upstream_failed', detail: String(err) });
    }
  },
};
