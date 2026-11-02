// Orchestrates one forecast: radar + models in parallel, live verification, blending, briefing.
// Pure logic (no DOM): runs in the browser and in Node tests with an injected fetch.

import {
  loadRadar, clutterMask, downsample, latLonToGrid, gridToLatLon, framesIdentical,
} from './radar.js';
import { estimateMotion, steeringPrior } from './motion.js';
import { runNowcast, forecastFrames } from './nowcast.js';
import {
  modelsFor, fetchDeterministic, fetchRing, fetchEnsemble, processNWP, nwpProbabilities,
  verifyModels, steeringWind, thunderFraction, pinVariable,
} from './nwp.js';
import { blend, summarize, briefing, makeTimeline, THRESHOLDS } from './blend.js';
import { clamp, haversineKm, vectorToBearing, RAIN } from './util.js';
import { covers as aiCovers, runModel, sampleAt, trustWeights } from './ai.js';
import { nearestRadars, radarConfidence } from './stations.js';
import { fetchSatellite } from './satellite.js';
import { radarTrend, modelAgreement, thunderPotential, predictionMode, hourConfidence, journeyData, advectToNow } from './insight.js';

const R1F = 2; // R1 = native radar grid downsampled by 2 (~2.4 km)
// timeline steps (5 min each) logged for later verification: 0–60 min densely, then sparser to 5 h
const LOG_STEPS = [0, 2, 4, 6, 8, 10, 12, 15, 18, 24, 30, 36, 48, 60];

function bearingFromPin(block, pinLat, pinLon, x, y) {
  const p = gridToLatLon(block, x, y, R1F);
  const dLon = ((p.lon - pinLon) * Math.PI) / 180;
  const la1 = (pinLat * Math.PI) / 180, la2 = (p.lat * Math.PI) / 180;
  const yv = Math.sin(dLon) * Math.cos(la2);
  const xv = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return { bearing: ((Math.atan2(yv, xv) * 180) / Math.PI + 360) % 360, lat: p.lat, lon: p.lon, distKm: haversineKm(pinLat, pinLon, p.lat, p.lon) };
}

/** Radar-observed rain fraction within `radiusKm` of the pin, per past clock hour. */
function radarHourlyObs(R1, times, block, pin, kmPerPx, hourEnds, radiusKm = 30) {
  const out = [];
  if (!R1.length) return out;
  const w = R1[0].w, h = R1[0].h;
  const r = radiusKm / kmPerPx;
  const tMin = times[0], tMax = times[times.length - 1];
  // Hour windows must match the model's accumulation periods, which follow local clock hours
  // (e.g. :30 UTC in India). Fall back to UTC hours if the model times are not available.
  const ends = hourEnds && hourEnds.length
    ? hourEnds.filter((T) => T > tMin + 1800 && T <= tMax + 600)
    : (() => { const a = []; for (let T = Math.ceil(tMin / 3600) * 3600; T <= tMax + 600; T += 3600) a.push(T); return a; })();
  for (const T of ends) {
    const idx = times.map((t, k) => (t > T - 3600 && t <= T + 300 ? k : -1)).filter((k) => k >= 0);
    if (idx.length < 4) continue;
    let wet = 0, cov = 0, tot = 0;
    for (let y = Math.floor(pin.y - r); y <= Math.ceil(pin.y + r); y++) {
      for (let x = Math.floor(pin.x - r); x <= Math.ceil(pin.x + r); x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if ((x - pin.x) ** 2 + (y - pin.y) ** 2 > r * r) continue;
        tot++;
        const i = y * w + x;
        if (!R1[idx[idx.length - 1]].cov[i]) continue;
        cov++;
        let s = 0;
        for (const k of idx) s += R1[k].rate[i];
        if (s / idx.length >= 0.2) wet++;
      }
    }
    if (cov >= 0.5 * tot && cov > 20) out.push({ tEnd: T, frac: wet / cov, frames: idx.length });
  }
  return out;
}

/**
 * Blend the AI model's chance of rain into the radar nowcast, lead by lead, weighted by how much the
 * model beat radar extrapolation in its last held-out test (trust 0 .. 0.85). Also updates the
 * next-hour heatmap inside the model's window.
 */
function blendAI(nc, res, trust, pin, kmPerPx) {
  const leads = 12;
  const pinP = [];
  for (let j = 0; j < leads + 2; j++) pinP.push(sampleAt(res, j, pin.x, pin.y));
  const t = (j) => (trust && Number.isFinite(trust[j]) ? trust[j] : 0);
  for (let k = 0; k < nc.leads.length; k++) {
    const lead = nc.leads[k];
    if (lead > 150) break;
    let pa, a;
    if (lead < 10) { pa = pinP[0]; a = t(0) * (lead / 10); }
    else if (lead <= 120) {
      const jf = lead / 10 - 1, j0 = Math.floor(jf), j1 = Math.min(leads - 1, j0 + 1), f = jf - j0;
      pa = (1 - f) * pinP[j0] + f * pinP[j1];
      a = (1 - f) * t(j0) + f * t(j1);
    } else { pa = pinP[leads - 1]; a = t(leads - 1) * (1 - (lead - 120) / 30); }
    if (!Number.isFinite(pa) || !Number.isFinite(nc.prob[0][k])) continue;
    nc.prob[0][k] = (1 - a) * nc.prob[0][k] + a * pa;
    for (let ti = 1; ti < 4; ti++) nc.prob[ti][k] = Math.min(nc.prob[ti][k], nc.prob[0][k]);
  }
  // heatmap: chance of rain at any time in the next hour (output 12)
  const pf = nc.probField;
  const aH = t(leads);
  if (pf && aH > 0) {
    for (let j = 0; j < pf.ny; j++) {
      for (let i = 0; i < pf.nx; i++) {
        const v = sampleAt(res, leads, i * pf.step, j * pf.step);
        const n = j * pf.nx + i;
        if (Number.isFinite(v)) pf.data[n] = Number.isFinite(pf.data[n]) ? (1 - aH) * pf.data[n] + aH * v : v;
      }
    }
  }
  return {
    used: !!trust,
    pin: pinP.map((v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null)),
    trust30: t(2), trust60: t(5), trustHour: aH,
    windowKm: Math.round(res.size * 2 * kmPerPx),
  };
}

/**
 * Run a complete forecast.
 * @param {object} o { lat, lon, nowSec?, fetchImpl?, onStage?(name, info) }
 */
export async function runForecast(o) {
  const { lat, lon } = o;
  const fetchImpl = o.fetchImpl;
  const nowSec = o.nowSec || Math.floor(Date.now() / 1000);
  const stage = o.onStage || (() => {});
  const errors = [];
  const models = modelsFor(lat, lon);

  // --- start everything in parallel ---
  stage('models', { state: 'loading' });
  const detP = fetchDeterministic(lat, lon, models, fetchImpl);
  const ringP = detP.then((d) => fetchRing(lat, lon, d.ids, fetchImpl)).catch((e) => { errors.push(['ring', e]); return null; });
  const ensP = fetchEnsemble(lat, lon, fetchImpl).catch((e) => { errors.push(['ensemble', e]); return null; });
  // satellite (storm clouds forming), through this site's relay; never delays the forecast much
  const satP = o.satBase
    ? Promise.race([
      fetchSatellite(lat, lon, { base: o.satBase, fetchImpl, nowSec }),
      new Promise((r) => setTimeout(() => r({ ok: false, reason: 'satellite timed out' }), 9000)),
    ])
    : Promise.resolve(null);
  const radars = nearestRadars(lat, lon, 3);
  stage('radar', { state: 'loading', progress: 0 });
  const radarP = loadRadar(lat, lon, {
    count: 10, fetchImpl, onProgress: (f) => stage('radar', { state: 'loading', progress: f }),
  }).catch((e) => { errors.push(['radar', e]); return null; });

  let det = null;
  try { det = await detP; } catch (e) { errors.push(['models', e]); }
  if (!det) {
    const radarOnly = await radarP;
    if (!radarOnly) throw new Error('Could not reach the weather data services. Check your connection and try again.');
  }
  const timeline = makeTimeline(nowSec, 6);

  // --- radar processing ---
  const radar = await radarP;
  let nc = null, motion = null, R1 = null, frames = null, ncQuality = 0, radarInfo = null, aiInfo = null, aiNote = null, trend = null;
  if (radar && radar.frames.length >= 3) {
    stage('radar', { state: 'processing' });
    const { block } = radar;
    const recent = radar.frames.slice(-7);
    const clutter = clutterMask(recent);
    R1 = radar.frames.map((f) => downsample(f.codes, block.W, block.H, R1F, radar.coverage, clutter));
    const w = R1[0].w, h = R1[0].h;
    const kmPerPx = block.kmPerPx * R1F;
    const pin = latLonToGrid(block, lat, lon, R1F);
    const pinNative = latLonToGrid(block, lat, lon, 1);
    // staleness: identical frames with echoes near the pin mean the source radar stopped updating
    const n = radar.frames.length;
    const st = framesIdentical(radar.frames[n - 1].codes, radar.frames[n - 2].codes, block.W, pinNative.x, pinNative.y, 250 / block.kmPerPx);
    const st2 = n > 2 ? framesIdentical(radar.frames[n - 2].codes, radar.frames[n - 3].codes, block.W, pinNative.x, pinNative.y, 250 / block.kmPerPx) : { identical: false };
    const stale = st.identical && st2.identical;

    let prior = null;
    let steer = null;
    let nwpEarly = null;
    if (det) {
      try {
        nwpEarly = processNWP({ det, ring: null, ens: null, models, timeline, nowSec });
        steer = steeringWind(nwpEarly);
        if (steer) prior = steeringPrior(steer.speedKmh * 0.9, steer.fromDeg, kmPerPx);
      } catch (e) { errors.push(['steer', e]); }
    }
    const recR1 = R1.slice(-7);
    const recTimes = radar.frames.slice(-7).map((f) => f.time);
    motion = estimateMotion(recR1.map((r) => r.rate), recTimes, w, h, { kmPerPx, prior });
    nc = runNowcast({
      rates: recR1.map((r) => r.rate), times: recTimes, cov: recR1[recR1.length - 1].cov,
      w, h, kmPerPx, pin, motion, nowSec, maxLeadMin: 180,
    });
    if (nc.approach) Object.assign(nc.approach, bearingFromPin(block, lat, lon, nc.approach.x, nc.approach.y));
    if (nc.nearest) Object.assign(nc.nearest, bearingFromPin(block, lat, lon, nc.nearest.x, nc.nearest.y));
    frames = forecastFrames(nc, recR1[recR1.length - 1].rate, recR1[recR1.length - 1].cov, w, h, { everyMin: 10, maxMin: 120 });

    // ---- AI nowcast trained on Indian radar (when a model is published and the pin is in India) ----
    if (o.ai && o.ai.model) {
      try {
        if (!aiCovers(block, pin)) aiNote = 'outside';
        else {
          const res = runModel(o.ai.model, recR1.map((r) => r.rate), recTimes, recR1[recR1.length - 1].cov, block, pin, w, h);
          if (res) {
            aiInfo = blendAI(nc, res, trustWeights(o.ai.metrics || o.ai.model.man.metrics), pin, kmPerPx);
            aiInfo.version = o.ai.model.man.version;
          } else aiNote = 'frames'; // the last hour of radar isn't complete at 10-minute steps
        }
      } catch (e) { errors.push(['ai', e]); }
    }

    const age = nc.ageMin;
    const qAge = age <= 15 ? 1 : age <= 45 ? 1 - (0.7 * (age - 15)) / 30 : age <= 75 ? 0.3 * (1 - (age - 45) / 30) : 0;
    const qCov = clamp(nc.now.covFracNear / 0.7, 0, 1);
    // far from the nearest radar the beam passes kilometres up and misses shallow rain
    const beam = radars.length ? radars[0].beamKm : 3;
    const qBeam = clamp(1 - 0.06 * Math.max(0, beam - 3), 0.7, 1);
    ncQuality = qAge * qCov * qBeam * (stale ? 0.3 : 1);
    // is the rain that matters here growing or fading?
    const tgt = nc.approach || (nc.nearest && nc.nearest.distKm <= 150 ? nc.nearest : null);
    if (tgt) {
      try {
        trend = radarTrend({
          rates: R1.map((r) => r.rate), times: radar.frames.map((f) => f.time), cov: R1[R1.length - 1].cov,
          w, h, kmPerPx, motion, x: tgt.x, y: tgt.y,
        });
      } catch (e) { errors.push(['trend', e]); }
    }
    radarInfo = {
      block, kmPerPx, pin, w, h, stale, steer,
      pinObs: stale ? [] : radar.frames.map((f, k) => {
        const px = Math.round(pin.x), py = Math.round(pin.y);
        let sum = 0, cnt = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const x = px + dx, y = py + dy;
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const i = y * w + x;
            if (!R1[k].cov[i]) continue;
            sum += R1[k].rate[i];
            cnt++;
          }
        }
        return { t: f.time, rate: cnt >= 6 ? sum / cnt : null };
      }),
      ageMin: age, quality: ncQuality, coverageNear: nc.now.covFracNear,
      frames: radar.frames.map((f, k) => ({ time: f.time, rate: R1[k].rate })),
      cov: R1[R1.length - 1].cov,
      forecast: frames,
      probField: nc.probField,
      ai: aiInfo,
      aiNote,
      motion: {
        vectors: motion.stats.vectors, usedPrior: motion.stats.usedPrior,
        speedKmh: nc.motionAtPin.speedKmh,
        toDeg: vectorToBearing(nc.motionAtPin.eastKmh, nc.motionAtPin.northKmh),
        field: motion.field,
      },
      diagnostics: radar.diagnostics,
      obs: radarHourlyObs(R1, radar.frames.map((f) => f.time), block, pin, kmPerPx, det && det.json.hourly ? det.json.hourly.time : null),
    };
  } else if (radar) {
    errors.push(['radar', new Error('Too few radar frames')]);
  }
  stage('radar', { state: nc ? 'done' : 'unavailable' });

  // --- models ---
  const [ring, ens] = await Promise.all([ringP, ensP]);
  let nwp = null, nwpP = null, verification = null, nwpSkill = 0.35;
  if (det) {
    nwp = processNWP({ det, ring, ens, models, timeline, nowSec });
    // long-run skill at this location, learned by the scorecard (1 = neutral)
    if (o.skill) {
      for (const m of nwp.models) {
        const f = o.skill[m.id];
        if (Number.isFinite(f) && f > 0) { m.prior *= f; m.weight = m.prior; m.skillFactor = f; }
      }
    }
    if (radarInfo && ncQuality > 0.5 && radarInfo.obs.length) {
      verification = verifyModels(nwp, radarInfo.obs);
    }
    const hires = nwp.models.some((m) => m.hires && m.weight > 0.3);
    nwpSkill = hires ? 0.5 : 0.38;
    if (verification && verification.length) {
      const tot = nwp.models.reduce((a, m) => a + (m.verify ? m.prior : 0), 0) || 1;
      const e = nwp.models.reduce((a, m) => a + (m.verify ? m.prior * m.verify.error : 0), 0) / tot;
      if (nwp.models.some((m) => m.verify && m.verify.informative)) nwpSkill += clamp(0.1 * (1 - 5 * e), -0.12, 0.08);
    }
    nwpP = nwpProbabilities(nwp, timeline, THRESHOLDS);
  }
  stage('models', { state: det ? 'done' : 'unavailable' });

  if (!nwpP) {
    // radar only: synthesise a flat "unknown" model layer at climatological 10%
    const n = timeline.length;
    nwpP = {
      prob: THRESHOLDS.map((_, k) => new Float32Array(n).fill([0.1, 0.04, 0.01, 0.002][k])),
      samples: timeline.map(() => ({ vals: [], wts: [] })),
    };
    nwpSkill = 0.15;
  }

  // Radar cannot see storms that have not formed yet. With no echoes nearby but the models expecting
  // rain soon (pop-up convection), hand over to the models faster.
  if (nc && (!nc.nearest || nc.nearest.distKm > 150) && nwp) {
    let maxModelP = 0;
    for (let i = 0; i <= 24 && i < timeline.length; i++) maxModelP = Math.max(maxModelP, nwpP.prob[0][i]);
    if (maxModelP > 0.3) {
      nc.tauUsed = Math.min(nc.tauUsed, 30);
      nc.tauLargeUsed = Math.min(nc.tauLargeUsed, 40);
    }
  }

  const blended = blend({
    timeline, nowSec, nc, ncQuality, nwpP, nwpSkill, calib: o.calib || null,
    thunderNwp: nwp ? (i) => thunderFraction(nwp, i) : null,
    capeAt: nwp ? (i) => pinVariable(nwp, 'cape', i).mean : null,
  });
  // Radar cannot see a storm before it rains. When satellite shows cloud tops climbing fast nearby,
  // the models support storms, and the radar shows nothing close, raise the near-term chance a little
  // (logged and checked against the radar like every forecast, so the calibration can correct it).
  const sat = await satP;
  const capeNow = nwp ? Math.max(...[0, 6, 12, 18, 24].map((i) => pinVariable(nwp, 'cape', i).mean).filter(Number.isFinite), 0) : 0;
  const thunderNear = nwp ? Math.max(...[0, 6, 12, 18, 24].map((i) => thunderFraction(nwp, i))) : 0;
  const radarClear = nc && (!nc.nearest || nc.nearest.distKm > 25) && !nc.approach;
  if (sat && sat.ok && radarClear && sat.where && sat.where.distKm <= 40 && (sat.trend === 'rapid' || sat.trend === 'developing') &&
      (capeNow >= 800 || thunderNear >= 0.15)) {
    const floor = sat.trend === 'rapid' ? 0.35 : 0.22;
    for (let i = 0; i < blended.prob[0].length; i++) {
      const m = i * 5;
      const f = m < 15 ? (m / 15) : m <= 60 ? 1 : m <= 90 ? 1 - ((m - 60) / 30) * 0.5 : 0;
      if (f > 0) blended.prob[0][i] = Math.max(blended.prob[0][i], floor * f);
    }
    blended.satBoost = { floor, trend: sat.trend };
  }
  const summary = summarize(blended, nc, nowSec);
  const num = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
  const log = {
    t: nowSec, lat, lon,
    rows: LOG_STEPS.filter((i) => i < timeline.length).map((i) => ({
      vt: timeline[i],
      pb: num(blended.probRaw[i]),
      pf: num(blended.prob[0][i]),
      pr: num(blended.probRadar[0][i]),
      pm: num(blended.probModel[0][i]),
      w: num(blended.w[i]),
      mp: nwpP.perModel ? Object.fromEntries(Object.entries(nwpP.perModel).map(([id, a]) => [id, num(a[i])])) : {},
    })),
  };
  // ---- explanations: radar picture, situation, model agreement, per-hour confidence, rain journey ----
  const radarConf = radarConfidence({
    available: !!radarInfo, coverageNear: radarInfo ? radarInfo.coverageNear : 0,
    ageMin: radarInfo ? radarInfo.ageMin : Infinity, stale: radarInfo ? radarInfo.stale : false,
    beamKm: radars.length ? radars[0].beamKm : NaN,
  });
  const agreement = modelAgreement(nwp, timeline, nowSec);
  const thunder = thunderPotential(nwp, summary);
  const mode = predictionMode({ summary, nc, radarConf, sat, thunder, models: agreement });
  const insight = {
    radars, radarConf, trend, sat, models: agreement, thunder, mode,
    hours: hourConfidence({ blended, nwp, nwpP: det ? nwpP : null, ncQuality }),
    journey: journeyData({
      summary, nc, mode, trend, blended, sat, models: agreement, ai: aiInfo,
      motion: radarInfo ? radarInfo.motion : null,
    }),
    boost: blended.satBoost || null,
    nearestNow: nc && nc.nearest ? { ...advectToNow(nc.nearest, radarInfo && radarInfo.motion, nc.ageMin), rate: nc.nearest.rate } : null,
  };
  return {
    insight,
    log, pinObs: radarInfo ? radarInfo.pinObs : [],
    lat, lon, nowSec, timeline, blended, summary, nc, ncQuality, radar: radarInfo,
    nwp, nwpP, nwpSkill, verification, models, errors,
    timezone: nwp ? nwp.timezone : null, utcOffset: nwp ? nwp.utcOffset : 0,
    tzAbbr: nwp ? nwp.tzAbbr : '', elevation: nwp ? nwp.elevation : null,
  };
}

export { briefing, RAIN };
