// Explanations and new indicators: IMD radar geometry, satellite storm detection, prediction mode,
// per-hour confidence and the rain journey, on synthetic situations with known answers.
import assert from 'node:assert/strict';
import { makeScenario, scenarioFetch, openMeteoHandlers, satHandlers } from './synth.mjs';
import { runForecast } from '../public/js/engine.js';
import { clearTileCache } from '../public/js/radar.js';
import { nearestRadars, radarConfidence, beamHeightKm } from '../public/js/stations.js';
import { analyse, greyToK } from '../public/js/satellite.js';
import { destinationPoint } from '../public/js/util.js';

const LAT = 14.165, LON = 77.811; // Puttaparthi
const nowSec = 1793620800;
const BASE = 'https://site.test';

// ---- 1. IMD radar network and radar confidence ----
const near = nearestRadars(LAT, LON, 3);
console.log('nearest IMD radars:', near.map((r) => `${r.name} ${r.distKm.toFixed(0)} km, beam ${r.beamKm.toFixed(1)} km`).join(' | '));
assert.equal(near[0].name, 'Sriharikota');
assert.ok(Math.abs(near[0].distKm - 265) < 10, 'Sriharikota is ~265 km from Puttaparthi');
assert.ok(near[0].beamKm > 5.5 && near[0].beamKm < 7.5, 'its lowest beam passes ~6 km above Puttaparthi');
assert.ok(near[0].bearing > 85 && near[0].bearing < 115, 'Sriharikota lies to the east-southeast');
assert.ok(Math.abs(beamHeightKm(100) - 1.46) < 0.05, 'beam height at 100 km (0.5°, 4/3 Earth) ≈ 1.5 km');
const far = radarConfidence({ available: true, coverageNear: 1, ageMin: 6, stale: false, beamKm: near[0].beamKm });
assert.equal(far.level, 'Low');
assert.equal(far.limit, 'beam');
const chennai = radarConfidence({ available: true, coverageNear: 1, ageMin: 6, stale: false, beamKm: nearestRadars(13.0, 80.25, 1)[0].beamKm });
assert.equal(chennai.level, 'High');
assert.equal(radarConfidence({ available: true, coverageNear: 1, ageMin: 50, stale: false, beamKm: 1 }).level, 'Low');
assert.equal(radarConfidence({ available: false }).level, 'None');
console.log('  ok  radar confidence: Puttaparthi low (beam), Chennai high, old images low');

// ---- 2. satellite analysis on its own ----
const S = 48;
const b = [LAT - 0.75, LON - 0.75, LAT + 0.75, LON + 0.75];
const fieldK = (fn) => {
  const a = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const lat = b[2] - ((y + 0.5) * 1.5) / S, lon = b[1] + ((x + 0.5) * 1.5) / S;
      a[y * S + x] = greyToK(Math.round((302 - fn(lat, lon)) / 0.39));
    }
  }
  return a;
};
const tower = destinationPoint(LAT, LON, 270, 20); // 20 km west
const towerK = (minAgo) => (lat, lon) => {
  const d = Math.hypot((lat - tower.lat) * 110.6, (lon - tower.lon) * 107.9);
  return d < 9 ? 250 - (30 - minAgo) * 0.9 : 296; // cloud top cooling ~13.5 K per 15 min
};
const g = analyse(fieldK(towerK(0)), fieldK(towerK(15)), fieldK(towerK(30)), b, LAT, LON);
console.log('satellite, growing tower:', JSON.stringify(g));
assert.equal(g.trend, 'rapid');
assert.ok(Math.abs(g.where.distKm - 20) <= 6 && Math.abs(g.where.bearing - 270) < 25, 'located 20 km west');
assert.ok(g.coolingK15 <= -8);
const clear = analyse(fieldK(() => 296), fieldK(() => 296), fieldK(() => 296), b, LAT, LON);
assert.equal(clear.trend, 'clear');
const anvil = (minAgo) => () => 215 + (30 - minAgo) * 0.6; // big cold anvil warming ~9 K / 15 min
assert.equal(analyse(fieldK(anvil(0)), fieldK(anvil(15)), fieldK(anvil(30)), b, LAT, LON).trend, 'decaying');
console.log('  ok  satellite: growing tower 20 km W = rapid; clear sky = clear; warming anvil = decaying');
// a cold high-cloud sheet drifting west at ~32 km/h (8 km per 15 min) is not a growing storm
const sheet = (minAgo) => (lat, lon) => (lon > LON - 0.2 + ((30 - minAgo) / 15) * -0.075 ? 225 : 296);
const drift = analyse(fieldK(sheet(0)), fieldK(sheet(15)), fieldK(sheet(30)), b, LAT, LON);
console.log('satellite, drifting cirrus sheet:', drift.trend, drift.coolingK15);
assert.ok(drift.trend !== 'rapid' && drift.trend !== 'developing', 'drifting cold cloud is not counted as growth');
console.log('  ok  satellite: a drifting high-cloud sheet is not mistaken for a growing storm');

// ---- 3. whole forecasts ----
async function forecast(scOpts, rainFn, tempK, cape = 1200) {
  clearTileCache();
  const sc = makeScenario({ nowSec, ...scOpts });
  const extra = { ...openMeteoHandlers({ nowSec, rainFn, cape }) };
  if (tempK) Object.assign(extra, satHandlers({ base: BASE, nowSec, tempK }));
  const r = await runForecast({ lat: LAT, lon: LON, nowSec, fetchImpl: scenarioFetch(sc, extra), satBase: BASE });
  return r;
}

// A. rain on radar moving in (the default synthetic storm reaches the pin in ~40 min from the WSW)
const A = await forecast({}, (m, t) => (t > nowSec + 1800 && t < nowSec + 3 * 3600 ? 1.5 : 0), () => 290);
const ia = A.insight;
console.log('A mode:', ia.mode, '| journey:', JSON.stringify(ia.journey, (k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)));
console.log('A trend:', JSON.stringify(ia.trend), '| hours:', ia.hours.map((h) => `${h.level}(${h.score.toFixed(2)})`).join(' '));
assert.equal(ia.mode.mode, 'tracking');
assert.equal(ia.journey.state, 'approaching');
assert.ok(ia.journey.distKm > 5 && ia.journey.distKm < 60, 'approaching rain is tens of km away');
assert.ok(ia.journey.bearing > 200 && ia.journey.bearing < 290, 'and lies to the west-southwest (storms move toward 70°)');
assert.ok(ia.journey.etaEarly <= ia.journey.eta && ia.journey.eta <= ia.journey.etaLate, 'arrival window brackets the arrival');
assert.equal(ia.journey.checks.radar, true);
assert.equal(ia.journey.checks.models, true, 'models also bring rain');
assert.ok(ia.trend && ['steady', 'strengthening', 'weakening'].includes(ia.trend.label));
assert.equal(ia.hours.length, 5);
assert.ok(ia.hours[0].score >= ia.hours[4].score, 'confidence falls with lead time');
assert.equal(ia.hours[0].led, 'radar');
assert.equal(ia.radars[0].name, 'Sriharikota');
// one consistent story: the distance now matches speed x arrival time, and the radar panel agrees
const travel = (ia.journey.speedKmh * ia.journey.eta) / 60;
console.log(`A consistency: rain ${ia.journey.distKm.toFixed(1)} km now, nearest ${ia.nearestNow.distKm.toFixed(1)} km, speed x eta = ${travel.toFixed(1)} km`);
assert.ok(Math.abs(ia.journey.distKm - travel) <= Math.max(3, 0.35 * travel), 'distance now ≈ speed × arrival time');
assert.ok(Math.abs(ia.journey.distKm - ia.nearestNow.distKm) < 0.5, 'journey and radar panel give the same distance');
assert.equal(ia.sat.ok, true);
console.log('  ok  rain approaching: radar tracking, journey from the WSW with an arrival window, confidence falling with time');

// B. nothing on radar, models expect showers, satellite sees a tower growing 15 km away
const tw = destinationPoint(LAT, LON, 200, 15);
const growK = (lat, lon, minAgo) => {
  const d = Math.hypot((lat - tw.lat) * 110.6, (lon - tw.lon) * 107.9);
  return d < 10 ? 258 - (30 - minAgo) * 0.8 : 297;
};
const B = await forecast({ cells: [], band: false }, (m, t) => (t > nowSec + 2 * 3600 && t < nowSec + 4 * 3600 && m !== 'gfs_seamless' ? 2 : 0), growK);
const ib = B.insight;
let p30 = 0;
for (let i = 3; i <= 9; i++) p30 = Math.max(p30, B.blended.prob[0][i]);
console.log('B mode:', ib.mode, '| sat:', JSON.stringify(ib.sat), '| boost:', JSON.stringify(ib.boost), '| P(15-45 min) max', p30.toFixed(2));
assert.equal(ib.sat.trend, 'rapid');
assert.equal(ib.mode.mode, 'developing');
assert.equal(ib.journey.state, 'developing');
assert.equal(ib.journey.checks.satellite, true);
assert.equal(ib.journey.checks.radar, null, 'radar has nothing to track yet: neutral, not a disagreement');
assert.equal(ib.satVerdict, 'storm');
assert.ok(ib.boost && p30 >= 0.3, 'satellite growth near a dry radar raises the near-term chance');
console.log('  ok  storms developing: satellite growth + unstable models -> "convective development", warning raised');

// B2. the same satellite growth, but stable air and dry models (e.g. a cyclone's cirrus at night):
// reported as high cloud, no storm mode, no raised chance, and no source checks on a dry forecast
const B2 = await forecast({ cells: [], band: false }, () => 0, growK, 50);
const ib2 = B2.insight;
console.log('B2 mode:', ib2.mode, '| verdict:', ib2.satVerdict, '| boost:', ib2.boost, '| journey:', ib2.journey.state);
assert.equal(ib2.sat.trend, 'rapid');
assert.equal(ib2.satVerdict, 'high-cloud');
assert.equal(ib2.mode.mode, 'settled');
assert.equal(ib2.boost, null);
assert.ok(['clear', 'nearby'].includes(ib2.journey.state));
console.log('  ok  cooling tops in stable, dry air: "high cloud", settled, no warning');

// C. settled: no rain anywhere, models dry, clear satellite
const C = await forecast({ cells: [], band: false }, () => 0, () => 296);
const ic = C.insight;
console.log('C mode:', ic.mode, '| journey:', ic.journey.state, '| hours:', ic.hours.map((h) => h.level).join(' '));
assert.equal(ic.mode.mode, 'settled');
assert.equal(ic.journey.state, 'clear');
assert.equal(ic.boost, null);
assert.equal(ic.models.rainy, 0, 'models agree it stays dry');
assert.ok(ic.hours.every((h) => h.level === 'High' || h.level === 'Moderate'), 'a dry forecast all models agree on is confident');
console.log('  ok  settled weather: "settled", no warning, confident dry hours');

// D. satellite service down: the forecast still works, without satellite
const D = await forecast({}, () => 0, null);
assert.equal(D.insight.sat.ok, false);
assert.equal(D.insight.mode.mode, 'tracking');
console.log('  ok  satellite unavailable: forecast unaffected');
console.log('\nAll insight tests passed');
