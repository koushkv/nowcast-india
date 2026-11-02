// Engine tests on synthetic storms with known motion and arrival times.
// Run: node test/engine.test.mjs
import assert from 'node:assert/strict';
import { makeScenario, scenarioFetch, encodePNG } from './synth.mjs';
import { decodePNG } from '../public/js/png.js';
import {
  rgbaToDbz, dbzToRGBA, loadRadar, downsample, clutterMask, latLonToGrid, clearTileCache,
} from '../public/js/radar.js';
import { estimateMotion, steeringPrior } from '../public/js/motion.js';
import { runNowcast, forecastFrames } from '../public/js/nowcast.js';
import { vectorToBearing, mercatorPixelKm, median } from '../public/js/util.js';

let failures = 0;
const test = async (name, fn) => {
  const t0 = performance.now();
  try {
    await fn();
    console.log(`  ok  ${name} (${(performance.now() - t0).toFixed(0)} ms)`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}\n       ${e.stack || e}`);
  }
};

async function pipeline(sc, { prior = null } = {}) {
  clearTileCache();
  const fetchImpl = scenarioFetch(sc);
  const t0 = performance.now();
  const radar = await loadRadar(14.165, 77.811, { count: 7, fetchImpl });
  const tLoad = performance.now() - t0;
  const { block } = radar;
  const clutter = clutterMask(radar.frames);
  const R1 = radar.frames.map((f) => downsample(f.codes, block.W, block.H, 2, radar.coverage, clutter));
  const w = R1[0].w, h = R1[0].h;
  const kmPerPx = block.kmPerPx * 2;
  const t1 = performance.now();
  const motion = estimateMotion(R1.map((r) => r.rate), radar.frames.map((f) => f.time), w, h, { kmPerPx, prior });
  const tMotion = performance.now() - t1;
  const pin = latLonToGrid(block, 14.165, 77.811, 2);
  const t2 = performance.now();
  const nc = runNowcast({
    rates: R1.map((r) => r.rate), times: radar.frames.map((f) => f.time), cov: R1[R1.length - 1].cov,
    w, h, kmPerPx, pin, motion, nowSec: sc.nowSec, maxLeadMin: 180,
  });
  const tNow = performance.now() - t2;
  const t3 = performance.now();
  const ff = forecastFrames(nc, R1[R1.length - 1].rate, R1[R1.length - 1].cov, w, h);
  const tFrames = performance.now() - t3;
  return { radar, R1, motion, nc, ff, pin, kmPerPx, timing: { tLoad, tMotion, tNow, tFrames } };
}

console.log('Engine tests');

await test('palette round-trip for every dBZ level', () => {
  for (let d = -10; d <= 64; d++) {
    const [r, g, b, a] = dbzToRGBA(d);
    assert.equal(rgbaToDbz(r, g, b, a), d, `dBZ ${d}`);
  }
  assert.ok(Number.isNaN(rgbaToDbz(0, 0, 0, 0)));
});

await test('PNG decoder is exact (RGBA, filters)', async () => {
  const w = 37, h = 11;
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = (i * 37 + (i >> 3)) & 255;
  const png = encodePNG(w, h, rgba);
  const img = await decodePNG(png);
  assert.equal(img.width, w);
  assert.equal(img.height, h);
  for (let i = 0; i < rgba.length; i++) assert.equal(img.data[i], rgba[i]);
});

const sc = makeScenario({ speedKmh: 36, toDeg: 70, ageMin: 6 });
let P;
await test('pipeline runs on synthetic radar', async () => {
  P = await pipeline(sc);
  assert.equal(P.radar.frames.length, 7);
  assert.ok(P.radar.coverage, 'coverage loaded');
  console.log('       timing ms:', Object.fromEntries(Object.entries(P.timing).map(([k, v]) => [k, Math.round(v)])));
});

await test('motion: speed within 15 %, direction within 10° of truth', () => {
  const gm = P.motion.stats.globalMean;
  assert.ok(gm, 'has global motion');
  const east = gm.u * P.kmPerPx * 60;
  const north = -gm.v * P.kmPerPx * 60;
  const speed = Math.hypot(east, north);
  const dir = vectorToBearing(east, north);
  console.log(`       estimated ${speed.toFixed(1)} km/h toward ${dir.toFixed(0)}°; truth 36 km/h toward 70°; vectors=${P.motion.stats.vectors}`);
  assert.ok(Math.abs(speed - 36) / 36 < 0.15, 'speed');
  assert.ok(Math.abs(((dir - 70 + 540) % 360) - 180) < 10, 'direction');
  const m = P.nc.motionAtPin;
  console.log(`       at pin: ${m.speedKmh.toFixed(1)} km/h`);
});

await test('steady storms -> long decorrelation time', () => {
  console.log(`       tau=${P.nc.tau.toFixed(0)} min, corr=${P.nc.corr.map((c) => `${c.lag.toFixed(0)}:${c.r.toFixed(2)}`).join(' ')}`);
  assert.ok(P.nc.tauUsed > 120);
});

await test('arrival time of the first cell matches the analytic truth', () => {
  const arr = P.nc.arrivals.filter(Number.isFinite).map((a) => a - P.nc.ageMin);
  const med = median(arr);
  // Cell centre reaches the pin 40 min after "now"; its 0.3 mm/h (15 dBZ) edge lies
  // sqrt((48-15)/12) * 9 km = 14.9 km ahead of the centre, i.e. 24.9 min earlier at 36 km/h.
  const truth = 40 - ((Math.sqrt((48 - 15) / 12) * 9) / 36) * 60;
  console.log(`       members arriving: ${arr.length}/${P.nc.members}, median ETA ${med.toFixed(1)} min after now (truth ${truth.toFixed(1)})`);
  assert.ok(Math.abs(med - truth) <= 5, 'median ETA within 5 min of truth');
});

await test('probability peaks when the cell is overhead', () => {
  const { leads, prob, ageMin } = P.nc;
  let kmax = 0;
  for (let k = 0; k < leads.length; k++) if (prob[0][k] > prob[0][kmax]) kmax = k;
  const peakAfterNow = leads[kmax] - ageMin;
  console.log(`       P(rain) max ${(prob[0][kmax] * 100).toFixed(0)} % at +${peakAfterNow.toFixed(0)} min; P at now ${(prob[0][Math.round(ageMin / 5)] * 100).toFixed(0)} %`);
  assert.ok(prob[0][kmax] > 0.5);
  assert.ok(peakAfterNow > 25 && peakAfterNow < 60);
});

await test('forecast frames: rain mass is conserved under pure advection', () => {
  const latest = P.R1[P.R1.length - 1].rate;
  const sum0 = latest.reduce((a, b) => a + b, 0);
  const f60 = P.ff.find((f) => f.leadMin === 60);
  const sum60 = f60.rate.reduce((a, b) => a + b, 0);
  console.log(`       total rain latest=${sum0.toFixed(0)}, +60 min=${sum60.toFixed(0)}`);
  assert.ok(Math.abs(sum60 - sum0) / sum0 < 0.25);
});

await test('convective growth/decay shortens the decorrelation time', async () => {
  const lat = 14.165, lon = 77.811;
  const cells = [];
  // many short-lived cells: each grows or decays quickly
  for (let k = 0; k < 40; k++) {
    const a = (k * 137.5) % 360;
    const d = 20 + ((k * 53) % 200);
    const at = { lat: lat + (d / 111) * Math.cos((a * Math.PI) / 180), lon: lon + (d / 111) * Math.sin((a * Math.PI) / 180) };
    cells.push({ at, peakDbz: 46, radiusKm: 6, growth: k % 2 ? 60 : -60 }); // ±60 dBZ per hour
  }
  const sc2 = makeScenario({ cells, band: false, speedKmh: 30, toDeg: 45 });
  const P2 = await pipeline(sc2);
  console.log(`       tau=${P2.nc.tau.toFixed(0)} min (steady case ${P.nc.tau.toFixed(0)}), growth=${P2.nc.growth.toFixed(2)} km/min, corr=${P2.nc.corr.map((c) => `${c.lag.toFixed(0)}:${c.r.toFixed(2)}/${c.n}`).join(' ')}`);
  assert.ok(P2.nc.tauUsed < P.nc.tauUsed);
});

await test('steering prior is used when there are no echoes', async () => {
  const sc3 = makeScenario({ cells: [], band: false });
  const kmPerPx = mercatorPixelKm(14.165, 6, 512) * 2;
  const prior = steeringPrior(30, 270, kmPerPx); // wind from west -> moving east
  const P3 = await pipeline(sc3, { prior });
  const m = P3.nc.motionAtPin;
  console.log(`       motion at pin ${m.speedKmh.toFixed(1)} km/h east=${m.eastKmh.toFixed(1)}`);
  assert.ok(Math.abs(m.eastKmh - 30) < 1 && Math.abs(m.northKmh) < 1);
  assert.equal(P3.nc.prob[0].reduce((a, b) => a + b, 0), 0);
});

await test('coverage hole makes the forecast "unknown" rather than dry', async () => {
  const sc4 = makeScenario({ coverageHoleKm: 60 });
  const P4 = await pipeline(sc4);
  // hole is upstream (west of the pin); storms move toward ENE, so +60 min trajectories enter it
  const k60 = Math.round((60 + P4.nc.ageMin) / 5);
  console.log(`       known fraction at +60 min: ${(P4.nc.known[k60] * 100).toFixed(0)} % (full coverage: ${(P.nc.known[k60] * 100).toFixed(0)} %)`);
  assert.ok(P4.nc.known[k60] < 0.8 * P.nc.known[k60]);
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll engine tests passed');
process.exitCode = failures ? 1 : 0;
