// Google Places Phase 2, commit 1 (Ehsan 2026-08-13): the shared edge cache of
// Places content was redistribution and is removed. These build-failing tests stop
// it — or an unproven cost claim — from coming back. The SerpApi 5-min cache is a
// SEPARATE, out-of-scope path and keeps its own cf cache; that is why the checks are
// scoped to the Places handler / to an exact count.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const w = readFileSync('src/worker.js', 'utf8');
let pass = 0, fail = 0;
const t = (n, fn) => { try { fn(); console.log('  ✅', n); pass++; } catch (e) { console.log('  ❌', n, '\n     ', e.message); fail++; } };

console.log('\nPlaces has NO shared edge cache (redistribution)');
t('cacheEverything appears exactly once — the out-of-scope SerpApi block only', () => {
  const n = (w.match(/cacheEverything/g) || []).length;
  assert.equal(n, 1, `cacheEverything appears ${n}×; expected 1 (SerpApi only) — a Places edge cache is back`);
});
t('the Places handler sets no cf edge cache and no long shared max-age', () => {
  const places = w.slice(w.indexOf("startsWith('/google/maps/api/')"));   // the HANDLER; SerpApi block is above it
  assert.doesNotMatch(places, /cacheEverything/, 'Places handler must have no cf.cacheEverything');
  assert.doesNotMatch(places, /cacheTtl/, 'Places handler must set no cf.cacheTtl');
  assert.doesNotMatch(places, /public,\s*max-age=\d{2,}/, 'Places responses must not invite a shared/public cache');
});

console.log('\nno unproven percentage cost claim in a Places comment');
t('no "~NN% of per-search cost" — state the measured $ figure instead', () => {
  assert.doesNotMatch(w, /\d{1,3}\s*%[^\n]*per-search cost|per-search cost[^\n]*\d{1,3}\s*%/, 'replace the % with the measured $0.064–0.071 (list price)');
});

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
