// Scorecard and local-learning tests with synthetic forecasts whose true reliability is known.
// Run: node test/scorecard.test.mjs
import assert from 'node:assert/strict';
import { Scorecard, fitCalibration, applyCalibration, locKey } from '../public/js/scorecard.js';
import { rng } from '../public/js/util.js';

let failures = 0;
const test = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.stack || e}`); }
};
const memStore = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const sig = (z) => 1 / (1 + Math.exp(-z));
const lg = (p) => Math.log(p / (1 - p));
const brier = (ps, f) => ps.reduce((s, p) => s + (f(p) - p.o) ** 2, 0) / ps.length;

console.log('Scorecard tests');

await test('learns a known miscalibration (over-confident, too wet) and beats it on new data', () => {
  const rand = rng(7);
  const make = (n) => Array.from({ length: n }, () => {
    const pb = 0.02 + 0.96 * rand();
    const truth = sig(0.6 * lg(pb) - 0.8); // the real chance is lower and flatter than forecast
    return { pb, pr: null, pm: pb, w: 0, o: rand() < truth ? 1 : 0 };
  });
  const train = make(600);
  const test2 = make(600);
  const cb = fitCalibration(train);
  console.log(`       fitted a=${cb.a.toFixed(2)} b=${cb.b.toFixed(2)} c=${cb.c.toFixed(2)} (truth a=0.60 b=-0.80)`);
  assert.ok(Math.abs(cb.a - 0.6) < 0.2 && Math.abs(cb.b + 0.8) < 0.3);
  const before = brier(test2, (p) => p.pb);
  const after = brier(test2, (p) => applyCalibration(p, cb));
  console.log(`       Brier on unseen data: ${before.toFixed(4)} -> ${after.toFixed(4)}`);
  assert.ok(after < before * 0.95);
});

await test('stays at "no change" when the forecast is already reliable', () => {
  const rand = rng(11);
  const ps = Array.from({ length: 400 }, () => { const pb = rand(); return { pb, pr: null, pm: pb, w: 0, o: rand() < pb ? 1 : 0 }; });
  const cb = fitCalibration(ps);
  console.log(`       fitted a=${cb.a.toFixed(2)} b=${cb.b.toFixed(2)}`);
  assert.ok(Math.abs(cb.a - 1) < 0.2 && Math.abs(cb.b) < 0.25);
});

await test('learns to trust radar more when radar is the better source here', () => {
  const rand = rng(3);
  const ps = Array.from({ length: 800 }, () => {
    const truthP = rand();
    const o = rand() < truthP ? 1 : 0;
    const pr = Math.min(0.98, Math.max(0.02, truthP + (rand() - 0.5) * 0.1)); // radar close to truth
    const pm = Math.min(0.98, Math.max(0.02, rand())); // models uninformative here
    const w = 0.5;
    return { pb: w * pr + (1 - w) * pm, pr, pm, w, o };
  });
  const cb = fitCalibration(ps);
  console.log(`       c=${cb.c.toFixed(2)} (positive = lean towards radar)`);
  assert.ok(cb.c > 0.2);
});

await test('verifies logged forecasts against later radar at the pin', () => {
  const sc = new Scorecard(memStore());
  const lat = 14.165, lon = 77.811, t0 = 1793620800;
  const rows = [0, 2, 4, 6, 8, 10, 12, 15, 18, 24, 30, 36, 48, 60].map((i) => ({ vt: t0 + i * 300, pb: 0.7, pf: 0.7, pr: 0.8, pm: 0.4, w: 0.6, mp: { ecmwf_ifs: 0.5 } }));
  sc.ingest({ lat, lon, nowSec: t0, log: { t: t0, rows }, pinObs: [] });
  // an hour later the radar shows rain at the pin from t0+20 min to t0+40 min
  const frames = [];
  for (let t = t0 - 1800; t <= t0 + 3600; t += 600) frames.push({ t, rate: t >= t0 + 1200 && t <= t0 + 2400 ? 3 : 0 });
  const n = sc.ingest({ lat, lon, nowSec: t0 + 3600, log: null, pinObs: frames });
  const ps = sc.pairs(lat, lon);
  console.log(`       verified ${n} rows; outcomes by lead: ${ps.map((p) => `${p.lead}:${p.o}`).join(' ')}`);
  assert.equal(n, 7); // leads 0..60 min fall inside the radar window
  assert.deepEqual(ps.map((p) => p.o), [0, 0, 1, 1, 1, 0, 0]);
  // a second pass must not double count
  assert.equal(sc.ingest({ lat, lon, nowSec: t0 + 3700, log: null, pinObs: frames }), 0);
});

await test('only checks forecasts made for the same spot', () => {
  const sc = new Scorecard(memStore());
  const t0 = 1793620800;
  sc.ingest({ lat: 14.165, lon: 77.811, nowSec: t0, log: { t: t0, rows: [{ vt: t0 + 600, pb: 0.5, pf: 0.5, pr: null, pm: 0.5, w: 0, mp: {} }] }, pinObs: [] });
  const n = sc.ingest({ lat: 15.5, lon: 78.9, nowSec: t0 + 1200, log: null, pinObs: [{ t: t0 + 600, rate: 5 }] });
  assert.equal(n, 0);
  assert.notEqual(locKey(14.165, 77.811), locKey(15.5, 78.9));
});

await test('model skill: a model that keeps missing gets less weight', () => {
  const sc = new Scorecard(memStore());
  const rand = rng(5);
  const lat = 14.165, lon = 77.811;
  let t = 1793620800;
  for (let r = 0; r < 120; r++) {
    const o = rand() < 0.4 ? 1 : 0;
    const row = { vt: t, pb: 0.5, pf: 0.5, pr: null, pm: 0.5, w: 0, o,
      mp: { good: o ? 0.8 : 0.15, okay: o ? 0.6 : 0.35, okay2: o ? 0.62 : 0.33, bad: o ? 0.2 : 0.75 } };
    sc.data.records.push({ k: locKey(lat, lon), t, lat, lon, rows: [row] });
    t += 900;
  }
  const p = sc.params(lat, lon);
  console.log(`       skill factors: ${JSON.stringify(p.skill)}`);
  assert.ok(p.skill.good > 1 && p.skill.bad < 0.8);
});

await test('track record statistics', () => {
  const sc = new Scorecard(memStore());
  const lat = 14.165, lon = 77.811;
  let t = 1793620800;
  for (let r = 0; r < 40; r++) {
    const rows = [];
    for (const i of [0, 2, 4, 6, 8, 10, 12]) {
      const o = (r + i) % 5 === 0 ? 1 : 0;
      rows.push({ vt: t + i * 300, pb: o ? 0.8 : 0.1, pf: o ? 0.8 : 0.1, pr: null, pm: 0.3, w: 0, mp: {}, o });
    }
    sc.data.records.push({ k: locKey(lat, lon), t, lat, lon, rows });
    t += 3600;
  }
  const st = sc.stats(lat, lon);
  console.log(`       n=${st.n} accuracy=${st.accuracyHour} warningsTrue=${st.warningsTrue} caught=${st.rainCaught} vsModels=${st.betterThanModels && st.betterThanModels.toFixed(2)}`);
  assert.equal(st.accuracyHour, 1);
  assert.ok(st.betterThanModels > 0.5);
});

await test('survives corrupted or full storage', () => {
  const bad = { getItem: () => '{not json', setItem: () => { throw new Error('QuotaExceeded'); }, removeItem: () => {} };
  const sc = new Scorecard(bad);
  assert.equal(sc.data.records.length, 0);
  sc.ingest({ lat: 1, lon: 1, nowSec: 1793620800, log: { t: 1793620800, rows: [] }, pinObs: [] });
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll scorecard tests passed');
process.exitCode = failures ? 1 : 0;
