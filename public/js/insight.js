// Explains the forecast: what the radar sees, whether the rain is growing, which kind of situation
// this is (tracked rain versus storms that have not formed yet), how much the weather models agree,
// and how far to trust each hour. Pure functions over the engine's results; the page words them.

import { RAIN, clamp } from './util.js';
import { pinVariable } from './nwp.js';

/**
 * Is the rain area growing or fading? Compares the rain inside a 20 km circle around (x, y) on the
 * latest radar image with the same circle about 30 minutes earlier, moved back along the measured
 * motion (so a moving storm is compared with itself, not with the empty air it left behind).
 */
export function radarTrend({ rates, times, cov, w, h, kmPerPx, motion, x, y, radiusKm = 20 }) {
  const n = rates.length;
  if (n < 3 || !motion) return null;
  const tL = times[n - 1];
  let k = -1;
  for (let i = n - 2; i >= 0; i--) if (tL - times[i] >= 1500) { k = i; break; }
  if (k < 0) return null;
  const dtMin = (tL - times[k]) / 60;
  const [u, v] = motion.sample(x, y); // R1 pixels per minute
  const r = radiusKm / kmPerPx;
  const measure = (R, cx, cy) => {
    let s = 0, area = 0, mx = 0;
    for (let yy = Math.max(0, Math.floor(cy - r)); yy <= Math.min(h - 1, Math.ceil(cy + r)); yy++) {
      for (let xx = Math.max(0, Math.floor(cx - r)); xx <= Math.min(w - 1, Math.ceil(cx + r)); xx++) {
        if ((xx - cx) ** 2 + (yy - cy) ** 2 > r * r) continue;
        const i = yy * w + xx;
        if (cov && !cov[i]) continue;
        if (R[i] >= RAIN.light) { s += R[i]; area++; if (R[i] > mx) mx = R[i]; }
      }
    }
    return { s, area, mx };
  };
  const now = measure(rates[n - 1], x, y);
  const past = measure(rates[k], x - u * dtMin, y - v * dtMin);
  if (now.area + past.area < 4) return null;
  const ratio = (now.s + 0.5) / (past.s + 0.5);
  const perHour = (Math.log(ratio) * 60) / dtMin;
  return {
    label: perHour > 0.45 ? 'strengthening' : perHour < -0.45 ? 'weakening' : 'steady',
    changePct: Math.round((ratio - 1) * 100),
    minutes: Math.round(dtMin),
    maxRate: now.mx,
    areaKm2: Math.round(now.area * kmPerPx * kmPerPx),
  };
}

/** How many weather models put rain on this spot in the next few hours, and from when. */
export function modelAgreement(nwp, timeline, nowSec, horizonMin = 180) {
  if (!nwp) return null;
  let n = 0, rainy = 0;
  const firsts = [];
  for (const m of nwp.models) {
    const c = m.series && m.series.center;
    if (!c) continue;
    n++;
    for (let i = 0; i < c.length && timeline[i] <= nowSec + horizonMin * 60; i++) {
      if (c[i] >= RAIN.light) { rainy++; firsts.push(timeline[i]); break; }
    }
  }
  firsts.sort((a, b) => a - b);
  return { n, rainy, firstTime: firsts.length ? firsts[Math.floor(firsts.length / 2)] : null, horizonMin };
}

/** Thunderstorm potential from the models: instability (CAPE) and how many forecast thunder. */
export function thunderPotential(nwp, summary) {
  if (!nwp) return null;
  let cape = 0;
  for (let i = 0; i <= 36; i++) {
    const c = pinVariable(nwp, 'cape', i).mean;
    if (Number.isFinite(c) && c > cape) cape = c;
  }
  const share = Number.isFinite(summary.thunderMax) ? summary.thunderMax : 0;
  const level = share >= 0.5 || cape >= 2500 ? 'High'
    : share >= 0.25 || cape >= 1200 ? 'Moderate'
      : share >= 0.1 || cape >= 400 ? 'Low' : 'Very low';
  return { level, cape: Math.round(cape), share };
}

/**
 * What kind of situation is this?
 *  tracking    rain already on radar, moving here (or overhead): the most predictable case
 *  developing  nothing on radar heading here, but storms are forming or likely to: timing uncertain
 *  models      rain expected from the weather models, or no usable radar here
 *  settled     no rain on radar heading here and nothing developing
 */
export function predictionMode({ summary: s, nc, radarConf, sat, thunder, models }) {
  const radarOk = !!nc && radarConf && radarConf.level !== 'None' && (radarConf.parts ? radarConf.parts.coverage >= 0.5 : true);
  if (!radarOk) return { mode: 'models', why: 'no-radar' };
  if (s.rainingNow) return { mode: 'tracking', why: 'overhead' };
  if (s.startMin != null && s.etaFromRadar) return { mode: 'tracking', why: 'approaching' };
  const convective = !!thunder && (thunder.share >= 0.15 || thunder.cape >= 800);
  const verdict = satelliteVerdict({ sat, thunder, models });
  const modelRain = !!models && models.rainy >= Math.max(2, models.n * 0.25);
  if (verdict === 'storm' || (convective && (modelRain || s.maxP >= 0.2))) return { mode: 'developing', why: verdict === 'storm' ? 'satellite' : 'models' };
  if (s.startMin != null || s.maxP >= 0.2) return { mode: 'models', why: 'later' };
  return { mode: 'settled', why: 'dry' };
}

/**
 * What cooling cloud tops on satellite most likely are. Growing storms need unstable air: with stable
 * air (little CAPE, no model thunder or rain) cooling tops are almost always high cloud spreading in,
 * for example a cyclone's cirrus outflow, not a storm forming.
 *   storm       growth within 50 km and the air can support storms
 *   high-cloud  growth within 50 km but stable air
 *   null        no growth (or no satellite)
 */
export function satelliteVerdict({ sat, thunder, models }) {
  const growing = !!sat && sat.ok && (sat.trend === 'rapid' || sat.trend === 'developing') && sat.where && sat.where.distKm <= 50;
  if (!growing) return null;
  const unstable = !!thunder && (thunder.share >= 0.05 || thunder.cape >= 300);
  const modelRain = !!models && models.rainy >= 1;
  return unstable || modelRain ? 'storm' : 'high-cloud';
}

/**
 * Confidence for each hour of the next five. Near-term hours are led by the radar (its quality sets
 * the confidence); later hours by the models (their agreement sets it). Confidence is about the
 * forecast as a whole: "dry, and every model agrees" is a confident forecast too.
 */
export function hourConfidence({ blended, nwp, nwpP, ncQuality }) {
  const out = [];
  for (let hr = 0; hr < 5; hr++) {
    const i0 = hr * 12, i1 = Math.min(blended.w.length, i0 + 12);
    let ws = 0;
    for (let i = i0; i < i1; i++) ws += blended.w[i] || 0;
    const wMean = i1 > i0 ? ws / (i1 - i0) : 0;
    let agree = 0.6;
    if (nwp && nwpP && nwpP.perModel) {
      let yes = 0, tot = 0;
      for (const m of nwp.models) {
        const a = nwpP.perModel[m.id];
        if (!a || !(m.weight > 0)) continue;
        let p = 0;
        for (let i = i0; i < i1; i++) if (a[i] > p) p = a[i];
        tot += m.weight;
        if (p >= 0.5) yes += m.weight;
      }
      if (tot > 0) agree = Math.max(yes, tot - yes) / tot;
    }
    const modelConf = (0.3 + (0.5 * (agree - 0.5)) / 0.5) * (1 - 0.04 * hr);
    const radarConf = 0.55 + 0.45 * clamp(ncQuality || 0, 0, 1);
    const score = wMean * radarConf + (1 - wMean) * modelConf;
    let level = score >= 0.72 ? 'High' : score >= 0.55 ? 'Moderate' : score >= 0.4 ? 'Low–moderate' : 'Low';
    if (wMean < 0.2 && (level === 'Low' || level === 'Low–moderate')) level = 'Model-dependent';
    out.push({ hour: hr, score, level, led: wMean >= 0.6 ? 'radar' : wMean >= 0.25 ? 'radar + models' : 'models', agree, wMean });
  }
  return out;
}

/**
 * Where a radar echo is now: radar positions are from the latest image (often 5-15 minutes old), so
 * move them on by the measured motion for the image's age. Returns { distKm, bearing } from the pin.
 */
export function advectToNow(pt, motion, ageMin) {
  if (!pt || !Number.isFinite(pt.distKm) || !Number.isFinite(pt.bearing)) return null;
  const b = (pt.bearing * Math.PI) / 180;
  let e = pt.distKm * Math.sin(b), n = pt.distKm * Math.cos(b);
  if (motion && Number.isFinite(motion.speedKmh) && Number.isFinite(motion.toDeg) && ageMin > 0) {
    const t = (motion.toDeg * Math.PI) / 180, hrs = ageMin / 60;
    e += motion.speedKmh * Math.sin(t) * hrs;
    n += motion.speedKmh * Math.cos(t) * hrs;
  }
  return { distKm: Math.hypot(e, n), bearing: ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360 };
}
const angleDiff = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

/** Chance of rain at some point up to `untilMin` minutes ahead (lower bound: the highest step). */
export function chanceBy(blended, untilMin) {
  let p = 0;
  for (let i = 0; i < blended.prob[0].length && i * 5 <= untilMin; i++) p = Math.max(p, blended.prob[0][i]);
  return p;
}

/**
 * Data for the "rain journey" view: where the rain is, how it moves, and when it gets here.
 * States: approaching | overhead | developing | nearby | clear | noradar
 */
export function journeyData({ summary: s, nc, mode, trend, motion, blended, sat, models, ai, thunder }) {
  // Which sources back the rain in this forecast: true = supports, false = disagrees, null = nothing
  // to check. Only meaningful when rain is expected; the page hides them otherwise.
  const checks = {
    radar: null, satellite: null, models: null, ai: null,
  };
  const etaWin = s.startMin != null ? [s.startEarly ?? s.startMin, s.startLate ?? s.startMin] : null;
  const developing = mode.mode === 'developing';
  if (models && models.n) {
    if (developing) checks.models = models.rainy >= 1 || (!!thunder && thunder.share >= 0.1);
    else checks.models = models.rainy >= Math.max(1, models.n / 2);
  }
  if (sat && sat.ok) {
    const growing = sat.trend === 'rapid' || sat.trend === 'developing';
    if (developing) checks.satellite = growing ? true : null;
    else checks.satellite = sat.cloudShare >= 0.15 || growing;
  }
  if (ai && ai.used && Array.isArray(ai.pin)) {
    const j = etaWin ? clamp(Math.round(etaWin[0] / 10) - 1, 0, 11) : 5;
    const p = ai.pin[j];
    if (Number.isFinite(p)) checks.ai = s.startMin != null || s.rainingNow ? p >= 0.35 : p < 0.35;
  }
  if (!nc) return { state: 'noradar', checks, mode: mode.mode, chance: s.maxP };
  const speedKmh = motion ? motion.speedKmh : NaN;
  const towardDeg = motion ? motion.toDeg : NaN;
  const nearNow = advectToNow(nc.nearest, motion, nc.ageMin);
  if (s.rainingNow) {
    checks.radar = true;
    return {
      state: 'overhead', checks, mode: mode.mode, trend, category: s.categoryNow,
      endMin: s.endMin, endEarly: s.endEarly, endLate: s.endLate, speedKmh, towardDeg,
    };
  }
  if (s.startMin != null && s.etaFromRadar && nc.approach) {
    checks.radar = true;
    // the rain's edge: the nearest echo if it lies along the approach path, else the path's echo
    const src = nc.nearest && angleDiff(nc.nearest.bearing, nc.approach.bearing) <= 45 ? nc.nearest : nc.approach;
    const pos = advectToNow(src, motion, nc.ageMin) || src;
    return {
      state: 'approaching', checks, mode: mode.mode, trend,
      distKm: Math.max(1, pos.distKm), bearing: pos.bearing, speedKmh, towardDeg,
      eta: s.startMin, etaEarly: etaWin[0], etaLate: etaWin[1],
      category: s.onsetCategory || s.spellCategory || 1,
      chance: chanceBy(blended, (etaWin[1] || s.startMin) + 15),
    };
  }
  if (mode.mode === 'developing') {
    checks.radar = null; // radar cannot see a storm before it forms: nothing to check yet
    return {
      state: 'developing', checks, mode: mode.mode, trend,
      where: sat && sat.ok && sat.where ? sat.where : null, cooling: sat && sat.ok ? sat.coolingK15 : null,
      chance: s.maxP, atMin: s.maxPMin, eta: s.startMin, etaEarly: etaWin && etaWin[0], etaLate: etaWin && etaWin[1],
    };
  }
  checks.radar = true;
  if (nearNow && nearNow.distKm <= 250) {
    return {
      state: 'nearby', checks, mode: mode.mode, trend,
      distKm: nearNow.distKm, bearing: nearNow.bearing, speedKmh, towardDeg, chance: s.maxP,
    };
  }
  return { state: 'clear', checks, mode: mode.mode, chance: s.maxP };
}
