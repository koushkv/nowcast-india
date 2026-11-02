// Seamless blending of the radar nowcast and the weather-model ensemble, plus the summary and
// plain-language briefing.
//
// Weights follow the skill-based blending used in STEPS-type operational systems: each source gets
// weight ρ/(1-ρ²), where ρ is its expected correlation with what actually happens. For the radar
// extrapolation ρ decays as exp(-lead/τ), with τ measured live from the radar loop; for the models ρ
// is a fixed level adjusted by how well the models matched the radar over the past hours.

import { RAIN, clamp, weightedQuantile, CATEGORY_LABEL, rateCategory } from './util.js';

export const THRESHOLDS = [RAIN.light, RAIN.moderate, RAIN.heavy, RAIN.violent];

export const logit = (q) => {
  const c = clamp(q, 0.005, 0.995);
  return Math.log(c / (1 - c));
};
export const sigmoid = (z) => 1 / (1 + Math.exp(-z));
/** Calibration coefficients for a lead time (minutes). calib = { buckets: [{ upTo, a, b, c }] } */
export function calibFor(calib, leadMin) {
  if (!calib || !Array.isArray(calib.buckets)) return null;
  for (const bk of calib.buckets) if (leadMin <= bk.upTo) return bk;
  return calib.buckets[calib.buckets.length - 1] || null;
}

export function makeTimeline(nowSec, hours = 6, stepMin = 5) {
  const t0 = Math.floor(nowSec / 300) * 300;
  const n = Math.round((hours * 60) / stepMin) + 1;
  return Array.from({ length: n }, (_, i) => t0 + i * stepMin * 60);
}

function interpAt(arr, kf) {
  const k0 = Math.floor(kf);
  const k1 = Math.min(arr.length - 1, k0 + 1);
  if (k0 < 0 || k0 >= arr.length) return NaN;
  const a = arr[k0], b = arr[k1];
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  return a + (b - a) * (kf - k0);
}

/**
 * @param {object} p
 *  timeline, nowSec
 *  nc: radar nowcast (or null), ncQuality: 0..1 (freshness / staleness / coverage)
 *  nwpP: output of nwpProbabilities, nwpSkill: ρ for the model blend
 *  thunderNwp(i), extras
 */
export function blend(p) {
  const { timeline, nc, nwpP } = p;
  const n = timeline.length;
  const ncQuality = nc ? clamp(p.ncQuality ?? 1, 0, 1) : 0;
  const rhoN = clamp(p.nwpSkill ?? 0.4, 0.15, 0.75);
  const bN = rhoN / (1 - rhoN * rhoN);
  // Predictability time at the scale of the forecast neighbourhood: cell scale at short leads,
  // rain-area scale once the neighbourhood has grown (geometric interpolation by radius).
  const tauS = nc ? clamp(nc.tauUsed, 15, 480) : 60;
  const tauL = nc ? clamp(nc.tauLargeUsed ?? nc.tauUsed * 1.5, tauS, 600) : 90;
  const tauAt = (radiusKm) => {
    const f = clamp((radiusKm - 6) / 24, 0, 1);
    return 1.1 * Math.exp((1 - f) * Math.log(tauS) + f * Math.log(tauL));
  };
  const tauEff = tauAt(6);
  const out = {
    times: timeline,
    w: new Float32Array(n),
    prob: THRESHOLDS.map(() => new Float32Array(n)),
    probRadar: THRESHOLDS.map(() => new Float32Array(n).fill(NaN)),
    probModel: THRESHOLDS.map(() => new Float32Array(n)),
    mean: new Float32Array(n), q10: new Float32Array(n), q50: new Float32Array(n), q90: new Float32Array(n),
    thunder: new Float32Array(n),
    probRaw: new Float32Array(n), // chance of rain before local calibration (logged for learning)
    tauEff,
    calibrated: false,
  };
  for (let i = 0; i < n; i++) {
    const t = timeline[i];
    let w = 0;
    let pNc = null;
    let kNc = -1;
    if (nc && ncQuality > 0) {
      const lead = (t - nc.tLatest) / 60;
      const kf = lead / 5;
      if (kf >= 0 && kf <= nc.leads.length - 1) {
        const known = clamp(interpAt(nc.known, kf), 0, 1);
        const rho = Math.exp(-lead / tauAt(interpAt(nc.radiusKm, kf)));
        const a = rho / (1 - rho * rho + 1e-3);
        w = (a / (a + bN)) * known * ncQuality;
        pNc = THRESHOLDS.map((_, ti) => interpAt(nc.prob[ti], kf));
        kNc = Math.round(kf);
        if (pNc.some((q) => !Number.isFinite(q))) w = 0;
      }
    }
    out.w[i] = w;
    for (let ti = 0; ti < THRESHOLDS.length; ti++) {
      const pm = nwpP.prob[ti][i];
      out.probModel[ti][i] = pm;
      if (pNc) out.probRadar[ti][i] = pNc[ti];
      const pr = pNc && Number.isFinite(pNc[ti]) ? pNc[ti] : pm;
      out.prob[ti][i] = clamp(w * pr + (1 - w) * (Number.isFinite(pm) ? pm : pr), 0, 1);
    }
    // local calibration learned from this device's verified forecasts (identity until trained)
    out.probRaw[i] = out.prob[0][i];
    const cb = p.calib ? calibFor(p.calib, (t - p.nowSec) / 60) : null;
    if (cb) {
      const raw = out.prob[0][i];
      const prr = out.probRadar[0][i];
      const pmm = out.probModel[0][i];
      const d = Number.isFinite(prr) && w > 0 && Number.isFinite(pmm) ? logit(prr) - logit(pmm) : 0;
      const pc = sigmoid(cb.a * logit(raw) + cb.b + cb.c * d);
      const ratio = raw > 0.005 ? Math.min(2, pc / raw) : 1;
      out.prob[0][i] = pc;
      for (let ti = 1; ti < THRESHOLDS.length; ti++) out.prob[ti][i] = clamp(out.prob[ti][i] * ratio, 0, 1);
      out.calibrated = true;
    }
    // keep exceedance probabilities nested (heavy <= moderate <= light)
    for (let ti = 1; ti < THRESHOLDS.length; ti++) out.prob[ti][i] = Math.min(out.prob[ti][i], out.prob[ti - 1][i]);

    // rain-rate distribution: mixture of radar members and model/ensemble samples
    const vals = [];
    const wts = [];
    if (w > 0 && kNc >= 0) {
      const mr = nc.memberRates;
      let cnt = 0;
      for (const m of mr) if (Number.isFinite(m[kNc])) cnt++;
      for (const m of mr) if (Number.isFinite(m[kNc])) { vals.push(m[kNc]); wts.push(w / cnt); }
    }
    const s = nwpP.samples[i];
    if (s && s.vals.length) {
      const tot = s.wts.reduce((a, b) => a + b, 0);
      for (let k = 0; k < s.vals.length; k++) { vals.push(s.vals[k]); wts.push(((1 - w) * s.wts[k]) / tot); }
    }
    let mu = 0, ws = 0;
    for (let k = 0; k < vals.length; k++) { mu += vals[k] * wts[k]; ws += wts[k]; }
    out.mean[i] = ws ? mu / ws : NaN;
    out.q10[i] = weightedQuantile(vals, wts, 0.1);
    out.q50[i] = weightedQuantile(vals, wts, 0.5);
    out.q90[i] = weightedQuantile(vals, wts, 0.9);

    // thunderstorm risk: model thunder codes + CAPE, and intense radar echoes upstream
    const tsModel = p.thunderNwp ? p.thunderNwp(i) : NaN;
    const radarTs = pNc ? clamp(pNc[2] * 1.2 + pNc[3], 0, 1) : NaN;
    const cape = p.capeAt ? p.capeAt(i) : NaN;
    let tsM = Number.isFinite(tsModel) ? tsModel : 0;
    if (Number.isFinite(cape) && cape > 800) tsM = Math.max(tsM, clamp((cape - 800) / 2000, 0, 0.6) * out.prob[0][i]);
    out.thunder[i] = Number.isFinite(radarTs) ? w * radarTs + (1 - w) * tsM : tsM;
    out.thunder[i] = Math.min(out.thunder[i], out.prob[0][i]);
  }
  return out;
}

// ---------- Summary ----------
const firstIndex = (arr, from, pred) => {
  for (let i = from; i < arr.length; i++) if (pred(arr[i], i)) return i;
  return -1;
};

export function summarize(b, nc, nowSec, horizonMin = 300) {
  const P = b.prob[0];
  const n = b.times.length;
  const iMax = Math.min(n - 1, Math.round(horizonMin / 5));
  const minutesAt = (i) => Math.round((b.times[i] - nowSec) / 60);
  const raining = P[0] >= 0.5 && (b.q50[0] >= RAIN.light || (nc && b.w[0] > 0.5 && nc.now.rate >= RAIN.light));
  const s = {
    rainingNow: raining,
    pNow: P[0],
    rateNow: b.q50[0],
    categoryNow: raining ? Math.max(1, rateCategory(b.q50[0])) : 0,
    radarLedMinutes: 0,
    maxP: 0, maxPMin: 0,
  };
  for (let i = 0; i <= iMax; i++) {
    if (P[i] > s.maxP) { s.maxP = P[i]; s.maxPMin = minutesAt(i); }
    if (b.w[i] >= 0.5) s.radarLedMinutes = minutesAt(i);
  }
  // accumulations (expected value)
  const acc = (mins) => {
    let a = 0;
    for (let i = 0; i < n && minutesAt(i) < mins; i++) a += (Number.isFinite(b.mean[i]) ? b.mean[i] : 0) * (5 / 60);
    return a;
  };
  s.total1h = acc(60);
  s.total3h = acc(180);
  s.total5h = acc(300);
  // peak intensity
  let pk = 0, pkI = 0;
  for (let i = 0; i <= iMax; i++) {
    const v = b.q50[i] * Math.min(1, P[i] / 0.5);
    if (v > pk) { pk = v; pkI = i; }
  }
  s.peakRate = pk;
  s.peakMin = minutesAt(pkI);
  let burst = 0;
  for (let i = 0; i <= iMax; i++) if (P[i] >= 0.3) burst = Math.max(burst, b.q90[i]);
  s.burstRate = burst;
  s.peakCategory = rateCategory(Math.max(pk, P.slice(0, iMax + 1).some((q, i) => b.prob[2][i] >= 0.3) ? RAIN.heavy : 0));
  s.heavyChance = Math.max(...b.prob[2].slice(0, iMax + 1));
  s.thunderMax = Math.max(...b.thunder.slice(0, Math.min(n, 37)));

  // time (minutes from now) at which P first crosses `level` at/after index i, interpolated
  const crossAt = (i, level) => {
    if (i <= 0) return minutesAt(Math.max(0, i));
    const a = P[i - 1], b = P[i];
    const f = b !== a ? clamp((level - a) / (b - a), 0, 1) : 1;
    return Math.round(minutesAt(i - 1) + (minutesAt(i) - minutesAt(i - 1)) * f);
  };
  if (!raining) {
    const i50 = firstIndex(P, 0, (q, i) => i <= iMax && q >= 0.5);
    const i30 = firstIndex(P, 0, (q, i) => i <= iMax && q >= 0.3);
    s.startMin = i50 >= 0 ? Math.max(0, crossAt(i50, 0.5)) : null;
    s.possibleMin = i30 >= 0 ? Math.max(0, crossAt(i30, 0.3)) : null;
    // timing window: radar members when the radar leads at that time, else the probability curve
    if (i50 >= 0) {
      const i70 = firstIndex(P, i50, (q) => q >= 0.7);
      s.startEarly = i30 >= 0 ? Math.max(0, crossAt(i30, 0.3)) : s.startMin;
      s.startLate = i70 >= 0 ? crossAt(i70, 0.7) : Math.min(horizonMin, s.startMin + 30);
      if (nc && b.w[i50] >= 0.5) {
        const arr = nc.arrivals.filter(Number.isFinite).map((a) => Math.max(0, a - nc.ageMin)).sort((x, y) => x - y);
        if (arr.length >= nc.members * 0.4) {
          const q = (f) => arr[Math.min(arr.length - 1, Math.floor(f * (arr.length - 1)))];
          s.startEarly = Math.round(q(0.1));
          s.startMin = Math.round(q(0.5));
          s.startLate = Math.round(q(0.9));
          s.etaFromRadar = true;
        }
      }
    }
  }
  // end of rain (for current rain, or for the next spell)
  const from = raining ? 0 : s.startMin != null ? Math.round(s.startMin / 5) : -1;
  if (from >= 0) {
    const iEnd = firstIndex(P, from, (q, i) => i <= iMax && q < 0.35 && (P[i + 1] ?? 0) < 0.35 && (P[i + 2] ?? 0) < 0.35);
    s.endMin = iEnd >= 0 ? Math.max(0, crossAt(iEnd, 0.35)) : null;
    if (s.endMin != null) {
      const i30 = firstIndex(P, from, (q, i) => q < 0.5);
      const i15 = firstIndex(P, iEnd, (q) => q < 0.2);
      s.endEarly = i30 >= 0 ? Math.min(minutesAt(i30), s.endMin) : s.endMin;
      s.endLate = i15 >= 0 ? minutesAt(i15) : Math.min(horizonMin, s.endMin + 30);
    }
    // intensity during the spell: onset character, overall max, and the heaviest window
    let mx = 0, onset = 0;
    const until = s.endMin != null ? Math.round(s.endMin / 5) : iMax;
    for (let i = from; i <= Math.min(iMax, until); i++) {
      mx = Math.max(mx, b.q50[i]);
      if (i < from + 6) onset = Math.max(onset, b.q50[i]);
    }
    s.spellCategory = Math.max(1, rateCategory(mx));
    s.onsetCategory = Math.max(1, rateCategory(onset));
    const hv = firstIndex(b.prob[2], from, (q, i) => i <= Math.min(iMax, until) && q >= 0.35);
    if (hv >= 0) {
      let he = hv;
      while (he + 1 <= Math.min(iMax, until) && b.prob[2][he + 1] >= 0.35) he++;
      s.heavyStart = minutesAt(hv);
      s.heavyEnd = minutesAt(he) + 5;
    }
  }
  // confidence
  let wAvg = 0, spreadAvg = 0, cnt = 0;
  for (let i = 0; i <= Math.min(iMax, 24); i++) { wAvg += b.w[i]; cnt++; }
  wAvg /= cnt || 1;
  for (let i = 0; i <= iMax; i++) {
    // sharpness: probabilities near 0 or 1 are confident; near 0.5 are not
    spreadAvg += 1 - Math.abs(2 * P[i] - 1);
  }
  spreadAvg /= iMax + 1;
  const score = 0.55 * (1 - spreadAvg) + 0.45 * wAvg;
  s.confidence = score > 0.62 ? 'High' : score > 0.4 ? 'Medium' : 'Low';
  s.confidenceScore = score;
  return s;
}

// ---------- Summary text (plain language) ----------
const INTENSITY_WORD = ['dry', 'light', 'moderate', 'heavy', 'very heavy'];
const cap = (w) => w[0].toUpperCase() + w.slice(1);
function inMinutes(m) {
  if (m <= 1) return 'now';
  if (m < 60) return `in ${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `in ${h} h ${r} min` : `in ${h} h`;
}

/**
 * Build the headline, a one-paragraph detail and (when rain is tracked on radar) where it is now.
 * fmt(minutesFromNow) -> local clock string. helpers: dist(km), dir(deg) -> words, speed(kmh).
 * Returns { state: 'dry'|'chance'|'incoming'|'raining', title, detail, approach }.
 */
export function briefing(s, nc, fmt, helpers = {}) {
  const dist = helpers.dist || ((k) => `${Math.round(k)} km`);
  const dir = helpers.dir || (() => '');
  const speed = helpers.speed || ((v) => `${Math.round(v)} km/h`);
  const res = { state: 'dry', title: '', detail: '', approach: '' };
  if (s.rainingNow) {
    res.state = 'raining';
    res.title = `${cap(INTENSITY_WORD[s.categoryNow] || 'light')} rain now`;
    if (s.endMin != null) {
      res.detail = `Should stop around ${fmt(s.endMin)}`;
      if (s.endLate != null && s.endEarly != null && s.endLate - s.endEarly >= 15) {
        res.detail += ` (between ${fmt(s.endEarly)} and ${fmt(s.endLate)})`;
      }
      res.detail += '.';
    } else {
      res.detail = 'Likely to keep raining for the next few hours.';
    }
    if (s.heavyChance >= 0.3 && s.categoryNow < 3) res.detail += ` Heavier bursts possible (${Math.round(s.heavyChance * 100)}% chance).`;
  } else if (s.startMin != null) {
    res.state = 'incoming';
    const ahead = s.startMin;
    res.title = ahead <= 90 ? `Rain ${inMinutes(ahead)}` : `Rain from about ${fmt(ahead)}`;
    const word = INTENSITY_WORD[s.onsetCategory || s.spellCategory || 1];
    const early = s.startEarly ?? ahead;
    const late = s.startLate ?? ahead;
    let d = late - early >= 10
      ? `${cap(word)} rain most likely starting between ${fmt(early)} and ${fmt(late)}`
      : `${cap(word)} rain most likely starting around ${fmt(ahead)}`;
    if (s.heavyStart != null && (s.onsetCategory || 1) < 3) d += `, heaviest from ${fmt(s.heavyStart)} to ${fmt(s.heavyEnd)}`;
    else if (s.heavyStart != null) d += `, easing after about ${fmt(s.heavyEnd)}`;
    if (s.endMin != null) d += s.endMin - ahead <= 90 ? `. Dry again around ${fmt(s.endMin)}.` : `. On and off until about ${fmt(s.endMin)}.`;
    else d += '. It may stay wet for several hours.';
    res.detail = d;
    const ap = nc && nc.approach;
    if (ap && s.etaFromRadar && nc.motionAtPin.speedKmh > 3) {
      const kmAway = Math.max(1, (nc.motionAtPin.speedKmh * ahead) / 60);
      res.approach = `The rain is about ${dist(kmAway)} to the ${dir(ap.bearing)}, moving toward you at ${speed(nc.motionAtPin.speedKmh)}.`;
    }
  } else if (s.maxP >= 0.2) {
    res.state = 'chance';
    res.title = 'Small chance of a shower';
    res.detail = `Up to ${Math.round(s.maxP * 100)}% chance around ${fmt(s.maxPMin)}. Mostly dry otherwise.`;
  } else {
    res.state = 'dry';
    res.title = 'No rain for the next 5 hours';
    res.detail = s.maxP >= 0.08 ? `Rain chance stays below ${Math.ceil((s.maxP * 100) / 5) * 5}%.` : 'No rain expected.';
    if (nc && nc.nearest && nc.nearest.distKm < 250 && Number.isFinite(nc.nearest.bearing)) {
      res.detail += ` The nearest rain on radar is ${dist(nc.nearest.distKm)} to the ${dir(nc.nearest.bearing)}.`;
    } else if (nc && nc.now.covered) {
      res.detail += ' No rain on radar within 250 km.';
    }
  }
  if (s.thunderMax >= 0.25 && res.state !== 'dry') {
    res.detail += ` Thunderstorms possible (${Math.round(s.thunderMax * 100)}% chance).`;
  }
  return res;
}

export { CATEGORY_LABEL };
