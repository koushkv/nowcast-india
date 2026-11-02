// End-to-end engine run on synthetic radar + synthetic model data.
import assert from 'node:assert/strict';
import { makeScenario, scenarioFetch, openMeteoHandlers } from './synth.mjs';
import { runForecast, briefing } from '../public/js/engine.js';
import { clearTileCache } from '../public/js/radar.js';
import { compass16 } from '../public/js/util.js';

const nowSec = 1793620800; // fixed instant
const fmtFor = (r) => (m) => new Date((nowSec + m * 60) * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: r.timezone || 'UTC' });

async function run(name, scOpts, rainFn) {
  clearTileCache();
  const sc = makeScenario({ nowSec, ...scOpts });
  const fetchImpl = scenarioFetch(sc, openMeteoHandlers({ nowSec, rainFn }));
  const t0 = performance.now();
  const r = await runForecast({ lat: 14.165, lon: 77.811, nowSec, fetchImpl });
  const ms = performance.now() - t0;
  const b = briefing(r.summary, r.nc, fmtFor(r), { dir: compass16 });
  console.log(`\n== ${name}  (${ms.toFixed(0)} ms)`);
  console.log('   errors:', r.errors.map(([k, e]) => `${k}: ${e.message}`));
  console.log('   models:', r.nwp.models.map((m) => `${m.short}:${m.weight.toFixed(2)}`).join(' '), '| ensembles:', r.nwp.ensembles.map((e) => `${e.label}(${e.members.length})`).join(' '));
  console.log('   radar: quality', r.ncQuality.toFixed(2), 'age', r.radar && r.radar.ageMin.toFixed(0), 'tau', r.nc && `${r.nc.tauUsed.toFixed(0)}/${r.nc.tauLargeUsed.toFixed(0)}`, 'nwpSkill', r.nwpSkill.toFixed(2), 'verification', JSON.stringify(r.verification));
  const row = (i) => `${String(i * 5).padStart(3)}m P=${(r.blended.prob[0][i] * 100).toFixed(0).padStart(3)}% radar=${Number.isFinite(r.blended.probRadar[0][i]) ? (r.blended.probRadar[0][i] * 100).toFixed(0).padStart(3) : '  -'} model=${(r.blended.probModel[0][i] * 100).toFixed(0).padStart(3)} w=${r.blended.w[i].toFixed(2)} q50=${r.blended.q50[i].toFixed(2)} q90=${r.blended.q90[i].toFixed(1)}`;
  for (const i of [0, 4, 6, 8, 10, 12, 18, 24, 30, 36, 48, 60]) console.log('   ' + row(i));
  console.log('   summary:', JSON.stringify(r.summary, (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)));
  console.log('   TITLE :', b.title);
  console.log('   DETAIL:', b.detail);
  console.log('   WHERE :', b.approach);
  return { r, b };
}

// 1. Radar shows a cell arriving in ~20-40 min; models think rain comes later (from +2 h)
const A = await run('radar cell inbound, models late', {}, (m, t) => (t > nowSec + 2 * 3600 && t < nowSec + 4 * 3600 ? (m === 'cma_grapes_global' ? 0 : 1.5) : 0));
assert.ok(A.r.nc, 'nowcast present');
assert.equal(A.b.state, 'incoming');
assert.ok(A.r.blended.w[0] > A.r.blended.w[30], 'radar weight decays');
assert.ok(A.r.verification && A.r.verification.length > 0, 'models are scored against radar with a half-hour time zone (India)');
assert.deepEqual(A.r.nwp.ensembles.map((e) => e.label).sort(), ['ECMWF ENS', 'GEFS', 'ICON-EPS', 'MOGREPS-G'], 'all four ensembles parsed, incl. GEFS under its response name');
assert.equal(A.r.nwp.ensembles.reduce((a, e) => a + e.members.length, 0), 140);
assert.ok(A.r.nwp.models.every((m) => !m.series.native15), 'global models use hourly data, not interpolated 15-min data');

// 2. No radar echoes, models dry
const B = await run('all dry', { cells: [], band: false }, () => 0);
assert.equal(B.b.state, 'dry');

// 3. No radar echoes; models agree on rain in ~3 h
const C = await run('models-only rain later', { cells: [], band: false }, (m, t) => (t > nowSec + 3 * 3600 ? 2 : 0));
console.log('   start', C.r.summary.startMin);
assert.ok(C.r.summary.startMin > 120);

// 4. learned calibration is applied, and the run is logged for later checking
{
  clearTileCache();
  const sc = makeScenario({ nowSec });
  const fetchImpl = scenarioFetch(sc, openMeteoHandlers({ nowSec, rainFn: () => 0 }));
  const base = await runForecast({ lat: 14.165, lon: 77.811, nowSec, fetchImpl });
  const drier = await runForecast({ lat: 14.165, lon: 77.811, nowSec, fetchImpl, calib: { buckets: [{ upTo: 300, a: 1, b: -1.5, c: 0 }] }, skill: { ecmwf_ifs: 1.5 } });
  const i = 8; // +40 min, inside the passing cell
  console.log(`\n== calibration pass-through: P(+40 min) ${base.blended.prob[0][i].toFixed(2)} -> ${drier.blended.prob[0][i].toFixed(2)}; log rows ${base.log.rows.length}; radar obs at pin ${base.pinObs.length}`);
  assert.ok(drier.blended.prob[0][i] < base.blended.prob[0][i] - 0.1, 'calibration lowers the chance');
  assert.ok(Math.abs(drier.blended.probRaw[i] - base.blended.probRaw[i]) < 0.05, 'raw (logged) chance is unchanged');
  assert.equal(base.log.rows.length, 14);
  assert.ok(base.pinObs.length >= 7 && base.pinObs.every((o) => o.rate === null || o.rate >= 0));
  assert.ok(drier.nwp.models.find((m) => m.id === 'ecmwf_ifs').skillFactor === 1.5);
}

// 5. AI model (if test/tmp-ai was produced by test/py/test_train.py): runs at the pin and feeds the forecast
{
  const fs = await import('node:fs');
  const pathm = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { loadModel } = await import('../public/js/ai.js');
  const dir = pathm.resolve(pathm.dirname(fileURLToPath(import.meta.url)), 'tmp-ai');
  if (fs.existsSync(pathm.join(dir, 'model.json'))) {
    const fileFetch = async (url) => {
      const p = pathm.join(dir, String(url).split('/').pop().split('?')[0]);
      return fs.existsSync(p) ? new Response(fs.readFileSync(p)) : new Response('', { status: 404 });
    };
    const ai = await loadModel('https://x.invalid/ai', fileFetch);
    // force full trust so the effect is visible regardless of how well the tiny test model trained
    const metrics = { brier: { model: new Array(14).fill(0.01), extrapolation: new Array(14).fill(0.02) } };
    clearTileCache();
    const sc = makeScenario({ nowSec });
    const fetchImpl = scenarioFetch(sc, openMeteoHandlers({ nowSec, rainFn: () => 0 }));
    const t0 = performance.now();
    const withAi = await runForecast({ lat: 14.165, lon: 77.811, nowSec, fetchImpl, ai: { model: ai.model, metrics } });
    const ms = performance.now() - t0;
    clearTileCache();
    const without = await runForecast({ lat: 14.165, lon: 77.811, nowSec, fetchImpl });
    const a = withAi.radar.ai;
    console.log(`\n== AI in the pipeline (${ms.toFixed(0)} ms): trust at 1 h ${a.trust60.toFixed(2)}, window ${a.windowKm} km, pin chance +30 min ${a.pin[2]}`);
    let diff = 0;
    for (let i = 0; i < 37; i++) diff += Math.abs(withAi.blended.prob[0][i] - without.blended.prob[0][i]);
    assert.ok(a && a.used && a.pin.length === 14, 'AI ran at the pin');
    assert.ok(diff > 0.01, 'AI changed the forecast');
    assert.ok(withAi.radar.probField.data.some(Number.isFinite));
    // outside India the model is not used
    clearTileCache();
    const scEu = makeScenario({ nowSec, lat: 48.85, lon: 2.35 });
    const eu = await runForecast({ lat: 48.85, lon: 2.35, nowSec, fetchImpl: scenarioFetch(scEu, openMeteoHandlers({ nowSec, rainFn: () => 0 })), ai: { model: ai.model, metrics } });
    assert.equal(eu.radar.ai, null, 'AI not used outside India');
    assert.equal(eu.radar.aiNote, 'outside');
    console.log('   AI blends in India and stays off outside it');
  } else {
    console.log('\n(AI pipeline check skipped: run test/py/test_train.py first)');
  }
}

console.log('\nfull pipeline tests passed');
