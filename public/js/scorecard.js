// Scorecard and local learning.
//
// Every forecast is logged (chance of rain at 14 lead times, plus its radar and model components and
// each model's own chance). Later runs check those forecasts against what the radar actually saw at
// the pin. From the checked pairs we learn, per location and lead time:
//   - a recalibration of the chance of rain (regularised logistic regression, a standard "model output
//     statistics" step), including how much to trust radar versus models;
//   - each weather model's long-run skill here, which scales its weight.
// Every learned adjustment starts at "no change" and only moves as evidence accumulates; a time-based
// hold-out check discards any calibration that does not beat the uncalibrated forecast.

const KEY = 'nowcast.track.v1';
const RAIN_OBS = 0.3; // mm/h at the pin counts as rain (same threshold as the forecast)
const BUCKETS = [30, 60, 120, 180, 300]; // lead-time buckets, minutes (upper bounds)
const MAX_RECORDS = 2500;
const MAX_AGE_DAYS = 60;
const PRIOR = 25; // regularisation: equivalent to ~25 checks agreeing with "no change"

export const locKey = (lat, lon) => `${(Math.round(lat * 20) / 20).toFixed(2)},${(Math.round(lon * 20) / 20).toFixed(2)}`;

const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const logit = (q) => {
  const c = clampN(q, 0.005, 0.995);
  return Math.log(c / (1 - c));
};
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
function defaultStorage() {
  try {
    const s = globalThis.localStorage;
    const probe = '__nowcast_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return memoryStorage();
  }
}

/** Solve a 3x3 linear system (Gaussian elimination with partial pivoting). */
function solve3(A, b) {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) return null;
    for (let r = c + 1; r < 3; r++) {
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = [0, 0, 0];
  for (let r = 2; r >= 0; r--) {
    let s = M[r][3];
    for (let k = r + 1; k < 3; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

const features = (p) => [logit(p.pb), 1, p.pr != null && p.w > 0 && p.pm != null ? logit(p.pr) - logit(p.pm) : 0];

/**
 * Regularised logistic regression z = a*logit(pb) + b + c*(logit(pr) - logit(pm)),
 * shrunk towards the identity (a=1, b=0, c=0). Returns {a, b, c}.
 */
export function fitCalibration(pairs, prior = PRIOR) {
  const beta0 = [1, 0, 0];
  let beta = [...beta0];
  const X = pairs.map(features);
  for (let it = 0; it < 12; it++) {
    const g = [0, 0, 0];
    const H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let k = 0; k < X.length; k++) {
      const x = X[k];
      const q = sigmoid(beta[0] * x[0] + beta[1] * x[1] + beta[2] * x[2]);
      const r = q - pairs[k].o;
      const wgt = q * (1 - q);
      for (let i = 0; i < 3; i++) {
        g[i] += r * x[i];
        for (let j = 0; j < 3; j++) H[i][j] += wgt * x[i] * x[j];
      }
    }
    for (let i = 0; i < 3; i++) {
      g[i] += prior * (beta[i] - beta0[i]);
      H[i][i] += prior;
    }
    const step = solve3(H, g);
    if (!step) break;
    beta = beta.map((v, i) => v - step[i]);
    if (Math.hypot(...step) < 1e-6) break;
  }
  return { a: clampN(beta[0], 0.3, 2), b: clampN(beta[1], -2.5, 2.5), c: clampN(beta[2], -1.5, 1.5) };
}

export const applyCalibration = (p, cb) => sigmoid(cb.a * logit(p.pb) + cb.b + cb.c * features(p)[2]);
const brier = (pairs, f) => pairs.reduce((s, p) => s + (f(p) - p.o) ** 2, 0) / Math.max(1, pairs.length);

export class Scorecard {
  constructor(storage) {
    this.storage = storage || defaultStorage();
    this.data = this.load();
  }

  load() {
    try {
      const j = JSON.parse(this.storage.getItem(KEY) || 'null');
      if (j && j.v === 1 && Array.isArray(j.records)) return j;
    } catch { /* corrupted: start fresh */ }
    return { v: 1, records: [] };
  }

  save() {
    try {
      this.storage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      // storage full: keep the newer half
      this.data.records = this.data.records.slice(Math.floor(this.data.records.length / 2));
      try { this.storage.setItem(KEY, JSON.stringify(this.data)); } catch { /* give up quietly */ }
    }
  }

  clear(lat, lon) {
    if (lat == null) this.data.records = [];
    else {
      const k = locKey(lat, lon);
      this.data.records = this.data.records.filter((r) => r.k !== k);
    }
    this.save();
  }

  /** Check earlier forecasts against this run's radar observations, then log this run. */
  ingest(result) {
    const key = locKey(result.lat, result.lon);
    const obs = (result.pinObs || []).filter((o) => o && o.rate != null);
    let verified = 0;
    if (obs.length) {
      const tMin = obs[0].t - 300;
      const tMax = obs[obs.length - 1].t + 300;
      for (const rec of this.data.records) {
        if (rec.k !== key || Math.abs(rec.lat - result.lat) > 0.03 || Math.abs(rec.lon - result.lon) > 0.03) continue;
        for (const row of rec.rows) {
          if (row.o != null || row.vt < tMin || row.vt > tMax || row.vt > result.nowSec) continue;
          let best = null;
          let bd = Infinity;
          for (const ob of obs) {
            const d = Math.abs(ob.t - row.vt);
            if (d < bd) { bd = d; best = ob; }
          }
          if (best && bd <= 300) {
            row.o = best.rate >= RAIN_OBS ? 1 : 0;
            verified++;
          }
        }
      }
    }
    const last = this.data.records.filter((r) => r.k === key).pop();
    if (result.log && result.log.rows && (!last || result.log.t - last.t >= 600)) {
      this.data.records.push({
        k: key, t: result.log.t, lat: +result.lat.toFixed(3), lon: +result.lon.toFixed(3),
        rows: result.log.rows.map((r) => ({ ...r, o: null })),
      });
    }
    const minT = (result.nowSec || Date.now() / 1000) - MAX_AGE_DAYS * 86400;
    this.data.records = this.data.records.filter((r) => r.t >= minT).slice(-MAX_RECORDS);
    this.save();
    return verified;
  }

  /** Checked (forecast, outcome) pairs for a location, oldest first. */
  pairs(lat, lon) {
    const key = locKey(lat, lon);
    const out = [];
    for (const rec of this.data.records) {
      if (rec.k !== key) continue;
      for (const row of rec.rows) {
        if (row.o == null || row.pb == null) continue;
        out.push({ t: rec.t, lead: (row.vt - rec.t) / 60, pb: row.pb, pf: row.pf ?? row.pb, pr: row.pr, pm: row.pm, w: row.w ?? 0, mp: row.mp || {}, o: row.o });
      }
    }
    return out;
  }

  /** Learned parameters for the engine: { calib, skill, n }. */
  params(lat, lon) {
    const all = this.pairs(lat, lon);
    const buckets = [];
    let lo = -Infinity;
    for (const upTo of BUCKETS) {
      const ps = all.filter((p) => p.lead > lo && p.lead <= upTo);
      lo = upTo;
      let cb = { upTo, a: 1, b: 0, c: 0, n: ps.length };
      if (ps.length >= 15) {
        const full = fitCalibration(ps);
        cb = { upTo, ...full, n: ps.length };
        if (ps.length >= 40) {
          // time-based hold-out: fit on the older 75 %, test on the newest 25 %
          const cut = Math.floor(ps.length * 0.75);
          const train = ps.slice(0, cut);
          const test = ps.slice(cut);
          const fit = fitCalibration(train);
          const before = brier(test, (p) => p.pb);
          const after = brier(test, (p) => applyCalibration(p, fit));
          cb.holdout = { before, after };
          if (!(after < before)) cb = { upTo, a: 1, b: 0, c: 0, n: ps.length, rejected: true, holdout: { before, after } };
        }
      }
      buckets.push(cb);
    }
    // model skill: Brier score of each model's own chance of rain, relative to the median model
    const scores = [];
    const ids = new Set();
    for (const p of all) for (const id of Object.keys(p.mp)) ids.add(id);
    for (const id of ids) {
      const ps = all.filter((p) => p.mp[id] != null);
      if (ps.length < 30) continue;
      scores.push({ id, bs: brier(ps, (p) => p.mp[id]), n: ps.length });
    }
    const skill = {};
    if (scores.length >= 3) {
      const sorted = scores.map((s) => s.bs).sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      for (const s of scores) {
        const raw = Math.exp(-(s.bs - med) / 0.04);
        skill[s.id] = +clampN(1 + (raw - 1) * (s.n / (s.n + 60)), 0.4, 1.6).toFixed(3);
      }
    }
    const used = buckets.some((b) => b.a !== 1 || b.b !== 0 || b.c !== 0);
    return { calib: used ? { buckets } : null, buckets, skill, n: all.length, scores };
  }

  /** Plain-language track record for a location. */
  stats(lat, lon) {
    const all = this.pairs(lat, lon);
    const hour = all.filter((p) => p.lead >= 0 && p.lead <= 60);
    const right = (ps) => ps.filter((p) => (p.pf >= 0.5 ? 1 : 0) === p.o).length / Math.max(1, ps.length);
    const rainy = hour.filter((p) => p.o === 1);
    const warned = hour.filter((p) => p.pf >= 0.5);
    const ahead = rainy.filter((p) => p.lead >= 10);
    const byLead = [];
    let lo = -Infinity;
    for (const upTo of BUCKETS) {
      const ps = all.filter((p) => p.lead > lo && p.lead <= upTo);
      byLead.push({ upTo, from: lo === -Infinity ? 0 : lo, n: ps.length, right: ps.length ? right(ps) : null });
      lo = upTo;
    }
    const withModels = all.filter((p) => p.pm != null);
    const bsApp = brier(withModels, (p) => p.pf);
    const bsModels = brier(withModels, (p) => p.pm);
    const days = all.length ? new Set(all.map((p) => Math.floor(p.t / 86400))).size : 0;
    return {
      n: all.length,
      nHour: hour.length,
      days,
      rainShare: all.length ? all.filter((p) => p.o === 1).length / all.length : 0,
      accuracyHour: hour.length ? right(hour) : null,
      warningsTrue: warned.length >= 5 ? warned.filter((p) => p.o === 1).length / warned.length : null,
      rainCaught: ahead.length >= 5 ? ahead.filter((p) => p.pf >= 0.5).length / ahead.length : null,
      betterThanModels: withModels.length >= 30 && bsModels > 0 ? 1 - bsApp / bsModels : null,
      byLead,
    };
  }
}
