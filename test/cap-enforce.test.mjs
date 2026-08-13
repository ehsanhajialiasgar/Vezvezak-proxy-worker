// Server-authoritative cap enforcement at the proxy (Option B; Ehsan 2026-08-13).
// The proxy is where the money is spent, so a BILLABLE search must not reach
// Google/SerpApi unless vezvezak-api /search/consume returned 200. These drive the
// real worker with a stubbed global fetch and assert NO upstream call slips through
// a refusal. Fail-closed: no auth / non-200 / unreachable backend all refuse.
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

let pass = 0, fail = 0;
const t = async (n, fn) => { try { await fn(); console.log('  ✅', n); pass++; } catch (e) { console.log('  ❌', n, '\n     ', e.message); fail++; } };

const realFetch = globalThis.fetch;
// Stub global fetch: record which hosts were hit; answer consume with a canned
// status; answer upstream (google/serp) with a marker so we can detect a spend.
function install({ consumeStatus = 200, consumeThrows = false } = {}) {
  const hits = { consume: 0, upstream: 0, upstreamUrls: [] };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/search/consume')) {
      hits.consume++;
      if (consumeThrows) throw new Error('backend unreachable');
      const body = consumeStatus === 200 ? '{"ok":true,"allowed":true}' : '{"ok":false,"reason":"cap_reached"}';
      return new Response(body, { status: consumeStatus, headers: { 'Content-Type': 'application/json' } });
    }
    hits.upstream++; hits.upstreamUrls.push(u);           // a real (billable) upstream call
    return new Response('{"results":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return hits;
}
const ENV = { SERP_API_KEY: 'k', GOOGLE_API_KEY: 'k', API_BASE: 'https://api.test' };
const req = (path, { auth = true } = {}) =>
  new Request(`https://vezvezakproxy.test${path}`, { headers: auth ? { Authorization: 'Bearer t' } : {} });

try {
  console.log('\nENFORCE_CAPS on — a refused consume blocks the billable call');
  await t('google textsearch: consume 402 → 402 returned, ZERO upstream spend', async () => {
    const hits = install({ consumeStatus: 402 });
    const res = await worker.fetch(req('/google/maps/api/place/textsearch/json?query=x&location=1.2,3.4'), { ...ENV, ENFORCE_CAPS: '1' });
    assert.equal(res.status, 402);
    assert.equal(hits.consume, 1, 'must have asked the backend');
    assert.equal(hits.upstream, 0, 'must NOT have called Google after a refusal');
  });
  await t('serp: consume 402 → 402 returned, ZERO upstream spend', async () => {
    const hits = install({ consumeStatus: 402 });
    const res = await worker.fetch(req('/serp/search?engine=google_shopping&q=x'), { ...ENV, ENFORCE_CAPS: '1' });
    assert.equal(res.status, 402);
    assert.equal(hits.upstream, 0, 'must NOT have called SerpApi after a refusal');
  });
  await t('no Authorization → 401, ZERO upstream and no backend call', async () => {
    const hits = install({ consumeStatus: 200 });
    const res = await worker.fetch(req('/serp/search?engine=amazon&q=x', { auth: false }), { ...ENV, ENFORCE_CAPS: '1' });
    assert.equal(res.status, 401);
    assert.equal(hits.upstream, 0);
  });
  await t('backend unreachable → fail CLOSED (503), ZERO upstream spend', async () => {
    const hits = install({ consumeThrows: true });
    const res = await worker.fetch(req('/serp/search?engine=google_shopping&q=x'), { ...ENV, ENFORCE_CAPS: '1' });
    assert.equal(res.status, 503);
    assert.equal(hits.upstream, 0);
  });

  console.log('\nENFORCE_CAPS on — allowed + un-metered paths behave correctly');
  await t('consume 200 → the billable search proceeds once', async () => {
    const hits = install({ consumeStatus: 200 });
    const res = await worker.fetch(req('/serp/search?engine=google_shopping&q=x'), { ...ENV, ENFORCE_CAPS: '1' });
    assert.equal(res.status, 200);
    assert.equal(hits.consume, 1);
    assert.equal(hits.upstream, 1, 'exactly one upstream call after an allow');
  });
  await t('place/photo is ceiling-checked (kind photo); allow → passes through', async () => {
    const hits = install({ consumeStatus: 200 });
    const res = await worker.fetch(req('/google/maps/api/place/photo?photo_reference=abc&vz_sid=S1'), { ...ENV, ENFORCE_CAPS: '1' });
    assert.equal(hits.consume, 1, 'photo asks the backend for a ceiling check');
    assert.equal(hits.upstream, 1, 'an allowed photo passes through to the signed image');
    assert.equal(res.status, 200);
  });
  await t('place/photo over the per-search ceiling is refused — ZERO upstream', async () => {
    const hits = install({ consumeStatus: 402 });
    const res = await worker.fetch(req('/google/maps/api/place/photo?photo_reference=abc&vz_sid=S1'), { ...ENV, ENFORCE_CAPS: '1' });
    assert.equal(res.status, 402);
    assert.equal(hits.upstream, 0, 'a refused photo must not reach the signed image');
  });
  await t('place/details is a follow-up — NOT metered, passes straight through', async () => {
    const hits = install({ consumeStatus: 402 });   // even if a consume WOULD refuse
    const res = await worker.fetch(req('/google/maps/api/place/details/json?place_id=x'), { ...ENV, ENFORCE_CAPS: '1' });
    assert.equal(hits.consume, 0, 'details must not consume anything');
    assert.equal(hits.upstream, 1, 'details passes through');
    assert.equal(res.status, 200);
  });
  await t('vz_sid is stripped from the upstream URL (never sent to Google/Serp)', async () => {
    const hits = install({ consumeStatus: 200 });
    await worker.fetch(req('/serp/search?engine=amazon&q=x&vz_sid=SEARCH123'), { ...ENV, ENFORCE_CAPS: '1' });
    assert.ok(hits.upstreamUrls.length === 1 && !hits.upstreamUrls[0].includes('SEARCH123'), 'vz_sid must not reach the upstream');
    assert.ok(!hits.upstreamUrls[0].includes('vz_sid'), 'vz_sid key must be stripped');
  });

  console.log('\nENFORCE_CAPS off (default) — unchanged current behavior, no backend call');
  await t('flag off → no consume, upstream proceeds (backward compatible)', async () => {
    const hits = install({ consumeStatus: 402 });
    const res = await worker.fetch(req('/serp/search?engine=google_shopping&q=x', { auth: false }), { ...ENV, ENFORCE_CAPS: '0' });
    assert.equal(hits.consume, 0, 'flag off must not call the backend');
    assert.equal(hits.upstream, 1);
    assert.equal(res.status, 200);
  });
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
