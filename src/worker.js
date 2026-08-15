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

export const ALLOWED_SERP_ENGINES = new Set(['google_shopping', 'amazon', 'google_local']);
export const ALLOWED_GOOGLE_PATHS = [
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

// ── Server-authoritative CAP enforcement (Option B; Ehsan 2026-08-13) ─────────
// This proxy is where the money is spent (Google Places / SerpApi). Backend
// counting is authoritative ONLY if this proxy refuses to spend without a
// successful cap consume. So before a BILLABLE search we forward the caller's own
// JWT to vezvezak-api /search/consume and spend ONLY on a 200. The proxy stays
// thin: it holds no JWT_SECRET and no D1 (that blast radius was deliberately kept
// out — see the SSRF work). It just asks "may I spend?" and obeys the answer.
//
// ROLLOUT: gated behind ENFORCE_CAPS. OFF by default so today's clients (which do
// NOT yet send an Authorization header) keep working unchanged. It is flipped ON
// only once the Part 2 client ships — it consumes per search and forwards its JWT
// (+ a per-search vz_sid so the bundle's sub-calls dedupe to one slot). Until then
// the flag stays off; this is a deliberate cutover, never a silent fail-open.
const API_BASE_DEFAULT = 'https://vezvezak-api.gfmnhs8y8r.workers.dev';

// Every allowlisted Google path MUST fall in exactly ONE gate category below, or
// gate-coverage.test.mjs fails the build. This is the wall: a new allowlisted path
// that nobody gated cannot ship.
//   METERED  → a billable PRIMARY search; consumes a 'local' cap slot.
//   PHOTO    → consumes no slot but is ceiling-checked per search (kind 'photo').
//   AUTH_ONLY→ a billable FOLLOW-UP (details/geocode): not a slot, but real money, so
//              it requires a signed-in caller (no anonymous spend). We auth-gate here
//              rather than invent a consume kind — the backend /search/consume only
//              accepts local|online|photo and would 400 anything else.
const METERED_GOOGLE_PATHS = new Set(['place/textsearch/json', 'place/nearbysearch/json']);
const PHOTO_GOOGLE_PATHS = new Set(['place/photo']);
const AUTH_ONLY_GOOGLE_PATHS = new Set(['place/details/json', 'geocode/json']);
// Exported for the build-failing coverage test (ALLOWED ⊆ METERED ∪ PHOTO ∪ AUTH_ONLY).
export { METERED_GOOGLE_PATHS, PHOTO_GOOGLE_PATHS, AUTH_ONLY_GOOGLE_PATHS };

// Require a signed-in caller WITHOUT consuming a slot — for billable follow-ups
// (details/geocode). Same fail-closed 401 as consumeOrRefuse's own auth check.
function requireAuth(request) {
  if (!request.headers.get('Authorization')) return json(401, { error: 'auth_required', reason: 'sign_in' });
  return null;
}

// Ask the backend to consume one cap slot for this caller. Returns the backend's
// Response when it refused (so we can relay the exact refusal), or null on allow.
// FAILS CLOSED: no Authorization, a non-200, or an unreachable backend all refuse
// — never fall through to a billable upstream call.
async function consumeOrRefuse(request, env, kind, searchId) {
  const auth = request.headers.get('Authorization');
  if (!auth) return json(401, { error: 'auth_required', reason: 'sign_in' });
  const apiBase = env.API_BASE || API_BASE_DEFAULT;
  try {
    const res = await fetch(`${apiBase}/search/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ kind, searchId: searchId || undefined }),
    });
    if (res.status === 200) return null;                 // allowed → spend
    const body = await res.text();                       // relay the refusal verbatim
    return new Response(body, { status: res.status, headers: { 'Content-Type': 'application/json', ...CORS } });
  } catch {
    return json(503, { error: 'cap_check_unavailable' }); // fail closed
  }
}
// FAIL CLOSED on an unexpected value. ONLY the explicit OFF sentinels skip
// enforcement — the deliberate pre-cutover state ("0"). ANYTHING else — an unset var,
// a typo like "2"/"yes", an empty string — ENFORCES (refuses to spend without a
// consume). A money control must fail closed: an accident switches enforcement ON, not
// off. (Was: `=== '1' || true || 'true'`, which fell OPEN on any unknown value.)
const enforcing = (env) => {
  const v = env.ENFORCE_CAPS;
  if (v === '0' || v === false || v === 'false' || v === 'off') return false;
  return true;
};

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

        // Every /serp/search is a billable ONLINE search — consume a cap slot first.
        if (enforcing(env)) {
          const refusal = await consumeOrRefuse(request, env, 'online', searchParams.get('vz_sid'));
          if (refusal) return refusal;               // over cap / not signed in → no upstream call
        }

        const upstream = new URL('https://serpapi.com/search.json');
        for (const [k, v] of searchParams) {
          if (k === 'api_key') continue;           // never accept a key from the client
          if (k === 'vz_sid') continue;            // internal cap-dedupe id — never sent upstream
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

        // Gate EVERY billable path — no anonymous or un-consumed spend. A primary
        // LOCAL search (text/nearby) consumes a 'local' slot; text+nearby share one
        // vz_sid and dedupe to a single slot server-side. Photos consume no slot but
        // are ceiling-checked per search (kind 'photo'). Follow-ups (details/geocode)
        // are billable too but not a slot — they require AUTH so nothing bills
        // anonymously. The final `else` also catches any allowlisted-but-uncategorized
        // path defensively (the build test guarantees there is none) → require auth.
        if (enforcing(env)) {
          if (METERED_GOOGLE_PATHS.has(path)) {
            const refusal = await consumeOrRefuse(request, env, 'local', searchParams.get('vz_sid'));
            if (refusal) return refusal;
          } else if (PHOTO_GOOGLE_PATHS.has(path) || path.startsWith('place/photo')) {
            const refusal = await consumeOrRefuse(request, env, 'photo', searchParams.get('vz_sid'));
            if (refusal) return refusal;
          } else {
            const refusal = requireAuth(request);   // details / geocode — billable follow-up, auth required
            if (refusal) return refusal;
          }
        }

        // We proxy Places ONLY to keep the API key server-side. There is NO shared
        // edge cache (Ehsan 2026-08-13): serving one user's Places content to another
        // is redistribution, which Google's terms forbid — caching is permitted to
        // compensate for latency, never for cost. The client key is stripped and the
        // server key injected here. Coordinates already arrive coarse (~110m, rounded
        // on the device); the server-side round below is kept purely as defence in
        // depth, and params are sorted only for a tidy upstream URL.
        // Cost, MEASURED: one local search = 2 Places calls (Text + Nearby, parallel)
        // + ≤1 Photo ≈ $0.064–0.071 at Google LIST PRICE (never verified vs an invoice).
        const params = new URLSearchParams();
        for (const [k, v] of searchParams) {
          if (k === 'key') continue;               // never accept a key from the client
          if (k === 'vz_sid') continue;            // internal cap-dedupe id — never sent upstream
          params.set(k, k === 'location' ? roundLatLng(v) : v);
        }
        params.set('key', env.GOOGLE_API_KEY);     // injected here (constant → doesn't fragment the key)
        const upstream = new URL(`https://maps.googleapis.com/maps/api/${path}`);
        for (const [k, v] of [...params.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
          upstream.searchParams.set(k, v);
        }

        // Place photos redirect to a signed image URL — follow and stream so the key
        // is never exposed. NO cf cache: Places content is never held in a shared
        // edge cache (that would be redistribution).
        const res = await fetch(upstream.toString(), { redirect: 'follow' });
        const headers = new Headers(CORS);
        headers.set('Content-Type', res.headers.get('Content-Type') || 'application/json');
        // Short PRIVATE client-side cache only — latency compensation, per user, never
        // a shared/public one. (No x-vz-cache header: it existed only to observe the
        // shared edge cache, which is gone.)
        headers.set('Cache-Control', 'private, max-age=60');
        return new Response(res.body, { status: res.status, headers });
      }

      return json(404, { error: 'not_found' });
    } catch (err) {
      return json(502, { error: 'upstream_failed', detail: String(err) });
    }
  },
};
