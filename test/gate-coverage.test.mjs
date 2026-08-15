// THE WALL — gate coverage (Ehsan 2026-08-15). Build-failing. Two invariants that
// make an un-gated billable call impossible to ship at the proxy (the chokepoint
// where the money actually leaves):
//   (2) EVERY allowlisted Google path is in exactly one gate category. A new
//       allowlisted path that nobody metered/auth-gated breaks the build.
//   (4) NO upstream (billable) fetch is reachable outside the enforcing gate — proven
//       behaviourally (anonymous request when enforcing → ZERO upstream, every path)
//       and structurally (the enforcing gate precedes each upstream fetch in source).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, {
  ALLOWED_GOOGLE_PATHS, ALLOWED_SERP_ENGINES,
  METERED_GOOGLE_PATHS, PHOTO_GOOGLE_PATHS, AUTH_ONLY_GOOGLE_PATHS,
} from '../src/worker.js';

let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); console.log('  ✅', n); pass++; } catch (e) { console.log('  ❌', n, '\n     ', e.message); fail++; } };

const realFetch = globalThis.fetch;
function install() {
  const hits = { consume: 0, upstream: 0 };
  globalThis.fetch = async (url) => {
    if (String(url).includes('/search/consume')) { hits.consume++; return new Response('{"ok":true}', { status: 200 }); }
    hits.upstream++; return new Response('{}', { status: 200 });   // a real (billable) upstream call
  };
  return hits;
}
const ENV = { SERP_API_KEY: 'k', GOOGLE_API_KEY: 'k', API_BASE: 'https://api.test' };
const anon = (path) => new Request(`https://vezvezakproxy.test${path}`);   // NO Authorization

try {
  // ── (2) allowlist ⊆ (metered ∪ photo ∪ auth-only) ──────────────────────────
  console.log('\n(2) every allowlisted Google path declares a gate category');
  const gated = new Set([...METERED_GOOGLE_PATHS, ...PHOTO_GOOGLE_PATHS, ...AUTH_ONLY_GOOGLE_PATHS]);
  for (const p of ALLOWED_GOOGLE_PATHS) {
    await t(`"${p}" is gated (metered | photo | auth-only)`, async () => {
      assert.ok(gated.has(p), `allowlisted path "${p}" is in NO gate category — declare it in METERED_/PHOTO_/AUTH_ONLY_GOOGLE_PATHS before shipping`);
    });
  }
  await t('no gate category names a path that is not allowlisted (no dead gate rows)', async () => {
    for (const p of gated) assert.ok(ALLOWED_GOOGLE_PATHS.includes(p), `gated path "${p}" is not in ALLOWED_GOOGLE_PATHS`);
  });

  // ── (4) no billable upstream is reachable outside the enforcing gate ─────────
  console.log('\n(4) when enforcing, an ANONYMOUS request reaches ZERO upstream — every path');
  for (const path of ALLOWED_GOOGLE_PATHS) {
    await t(`anonymous /google/maps/api/${path} → 0 upstream`, async () => {
      const hits = install();
      await worker.fetch(anon(`/google/maps/api/${path}?x=1&photo_reference=r&query=q&address=a`), { ...ENV, ENFORCE_CAPS: '1' });
      assert.equal(hits.upstream, 0, `anonymous ${path} reached the billable upstream`);
    });
  }
  for (const engine of ALLOWED_SERP_ENGINES) {
    await t(`anonymous /serp/search?engine=${engine} → 0 upstream`, async () => {
      const hits = install();
      await worker.fetch(anon(`/serp/search?engine=${engine}&q=x`), { ...ENV, ENFORCE_CAPS: '1' });
      assert.equal(hits.upstream, 0, `anonymous serp ${engine} reached the billable upstream`);
    });
  }

  // ── (4, structural) the enforcing gate precedes every upstream fetch in source ──
  console.log('\n(4) structural: exactly two upstream fetches, each behind an enforcing() gate');
  const w = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  await t('there are exactly two billable upstream fetches (serpapi + maps)', async () => {
    const serp = (w.match(/serpapi\.com/g) || []).length;
    const maps = (w.match(/maps\.googleapis\.com/g) || []).length;
    // one upstream fetch each (plus the URL appears in a comment for serp — tolerate ≥1),
    // and exactly one `fetch(upstream` per handler.
    const upstreamFetches = (w.match(/fetch\(upstream/g) || []).length;
    assert.equal(upstreamFetches, 2, `expected exactly 2 fetch(upstream ...) calls, found ${upstreamFetches}`);
    assert.ok(serp >= 1 && maps >= 1, 'both upstream hosts must be present');
  });
  await t('each handler runs enforcing(env) BEFORE its fetch(upstream ...)', async () => {
    const serpHandler = w.slice(w.indexOf("pathname === '/serp/search'"), w.indexOf("startsWith('/google/maps/api/')"));
    const mapsHandler = w.slice(w.indexOf("startsWith('/google/maps/api/')"));
    for (const [name, h] of [['serp', serpHandler], ['maps', mapsHandler]]) {
      const gateAt = h.indexOf('enforcing(env)');
      const fetchAt = h.indexOf('fetch(upstream');
      assert.ok(gateAt > -1, `${name} handler must call enforcing(env)`);
      assert.ok(fetchAt > -1 && gateAt < fetchAt, `${name}: enforcing(env) must run before fetch(upstream)`);
    }
  });
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
