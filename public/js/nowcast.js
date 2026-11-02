// Probabilistic radar nowcast at the pin.
//
// 1. Semi-Lagrangian backward extrapolation of the latest radar field along the motion field.
// 2. Lagrangian decorrelation time τ measured from the last hour of radar: how fast the storms
//    here are actually changing. It sets how quickly the forecast must widen and when the blend
//    hands over from radar to the weather models.
// 3. "Local Lagrangian" probabilities (Germann & Zawadzki 2004): the chance of rain at the pin at
//    lead t is the fraction of rainy pixels in a neighbourhood around the upstream origin point,
//    with the neighbourhood growing with lead time. A 50-member motion ensemble adds the
//    uncertainty of the storm track itself.

import { sampleField } from './motion.js';
import { clamp, dbzToRate, rateToDbz, rng, gaussianPair, weightedQuantile, RAIN } from './util.js';

const THRESH = [RAIN.light, RAIN.moderate, RAIN.heavy, RAIN.violent]; // mm/h

function bilinear(F, w, h, x, y) {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return NaN;
  const i = Math.min(w - 2, Math.floor(x));
  const j = Math.min(h - 2, Math.floor(y));
  const ax = x - i;
  const ay = y - j;
  const k = j * w + i;
  return (F[k] * (1 - ax) + F[k + 1] * ax) * (1 - ay) + (F[k + w] * (1 - ax) + F[k + w + 1] * ax) * ay;
}

/** Backtrack one step with the midpoint rule. vel(x,y) -> [u,v] px/min. */
function backStep(vel, x, y, dt, du = 0, dv = 0) {
  const [u1, v1] = vel(x, y);
  const xm = x - 0.5 * dt * (u1 + du);
  const ym = y - 0.5 * dt * (v1 + dv);
  const [u2, v2] = vel(xm, ym);
  return [x - dt * (u2 + du), y - dt * (v2 + dv)];
}

class SAT {
  constructor(w, h, valueFn, Arr = Int32Array) {
    this.W = w + 1;
    this.s = new Arr(this.W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += valueFn(y * w + x);
        this.s[(y + 1) * this.W + x + 1] = this.s[y * this.W + x + 1] + row;
      }
    }
    this.w = w;
    this.h = h;
  }
  /** inclusive box [x0..x1] x [y0..y1], clipped to the grid */
  box(x0, y0, x1, y1) {
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    x1 = Math.min(this.w - 1, x1); y1 = Math.min(this.h - 1, y1);
    if (x1 < x0 || y1 < y0) return 0;
    const W = this.W, s = this.s;
    return s[(y1 + 1) * W + x1 + 1] - s[y0 * W + x1 + 1] - s[(y1 + 1) * W + x0] + s[y0 * W + x0];
  }
}

function boxBlur(src, w, h, r) {
  const sat = new SAT(w, h, (i) => src[i], Float64Array);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = (Math.min(w - 1, x + r) - Math.max(0, x - r) + 1) * (Math.min(h - 1, y + r) - Math.max(0, y - r) + 1);
      out[y * w + x] = sat.box(x - r, y - r, x + r, y + r) / n;
    }
  }
  return out;
}

/** Displacement field for a whole grid, computed on a coarse trajectory lattice. */
function trajectoryLattice(vel, w, h, step, dtMin, nSteps) {
  const lw = Math.floor((w - 1) / step) + 2;
  const lh = Math.floor((h - 1) / step) + 2;
  const xs = new Float32Array(lw * lh);
  const ys = new Float32Array(lw * lh);
  for (let j = 0; j < lh; j++) for (let i = 0; i < lw; i++) { xs[j * lw + i] = i * step; ys[j * lw + i] = j * step; }
  const snapshots = [];
  for (let s = 1; s <= nSteps; s++) {
    for (let k = 0; k < xs.length; k++) {
      const p = backStep(vel, xs[k], ys[k], dtMin);
      xs[k] = p[0]; ys[k] = p[1];
    }
    snapshots.push({ xs: xs.slice(), ys: ys.slice() });
  }
  return { lw, lh, step, snapshots };
}

function advectWithLattice(F, cov, w, h, lat, snapIndex) {
  const { lw, step } = lat;
  const { xs, ys } = lat.snapshots[snapIndex];
  const out = new Float32Array(w * h);
  const known = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = y / step;
    const j = Math.floor(fy);
    const ay = fy - j;
    for (let x = 0; x < w; x++) {
      const fx = x / step;
      const i = Math.floor(fx);
      const ax = fx - i;
      const k = j * lw + i;
      const ox = (xs[k] * (1 - ax) + xs[k + 1] * ax) * (1 - ay) + (xs[k + lw] * (1 - ax) + xs[k + lw + 1] * ax) * ay;
      const oy = (ys[k] * (1 - ax) + ys[k + 1] * ax) * (1 - ay) + (ys[k + lw] * (1 - ax) + ys[k + lw + 1] * ax) * ay;
      const v = bilinear(F, w, h, ox, oy);
      if (Number.isNaN(v)) continue;
      const ci = Math.round(oy) * w + Math.round(ox);
      if (cov && !cov[ci]) continue;
      out[y * w + x] = v;
      known[y * w + x] = 1;
    }
  }
  return { rate: out, known };
}

/** Pearson correlation of two fields over covered pixels within radius of (cx,cy). */
function correlation(a, b, cov, w, h, cx, cy, rad) {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, wet = 0;
  const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(w - 1, Math.ceil(cx + rad));
  const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(h - 1, Math.ceil(cy + rad));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      if (cov && !cov[i]) continue;
      const va = a[i], vb = b[i];
      if (!(va > 0.02 || vb > 0.02)) continue; // ignore shared dry areas (inflate correlation)
      if (va > 0.2 && vb > 0.2) wet++;
      n++; sa += va; sb += vb; saa += va * va; sbb += vb * vb; sab += va * vb;
    }
  }
  if (n < 150) return { r: NaN, n };
  const cv = sab / n - (sa / n) * (sb / n);
  const va = saa / n - (sa / n) ** 2;
  const vb = sbb / n - (sb / n) ** 2;
  if (va <= 1e-9 || vb <= 1e-9) return { r: NaN, n };
  return { r: cv / Math.sqrt(va * vb), n, wet };
}

const logT = (F) => {
  const o = new Float32Array(F.length);
  for (let i = 0; i < F.length; i++) o[i] = F[i] > 0.05 ? Math.log10(1 + F[i] * 4) : 0;
  return o;
};

/**
 * Run the nowcast.
 * @param {object} p
 *  rates: Float32Array[] R1 rain rate (mm/h), oldest->newest
 *  times: unix seconds per frame
 *  cov: Uint8Array R1 coverage (1 = radar sees this pixel) or null
 *  w, h: R1 size; kmPerPx: R1 pixel size at pin; pin: {x, y} in R1 px
 *  motion: result of estimateMotion
 *  nowSec: current unix time
 *  maxLeadMin: forecast horizon after "now"
 */
export function runNowcast(p) {
  const { rates, times, cov, w, h, kmPerPx, pin, motion } = p;
  const nowSec = p.nowSec || Date.now() / 1000;
  const maxLeadMin = p.maxLeadMin || 180;
  const members = p.members || 50;
  const latest = rates[rates.length - 1];
  const tLatest = times[times.length - 1];
  const ageMin = Math.max(0, (nowSec - tLatest) / 60);
  const vel = (x, y) => sampleField(motion.field, x, y);

  // ---- Lagrangian decorrelation time, measured at two scales within ~300 km of the pin ----
  // Small scale (~12 km boxes) = individual cells; large scale (~40 km boxes) = rain areas. Cells in
  // tropical convection may last 20 min while the shower area persists for an hour or more, so the
  // blend uses the scale that matches the widening forecast neighbourhood at each lead time.
  const smoothS = (F) => logT(boxBlur(F, w, h, 2));
  const smoothL = (F) => logT(boxBlur(F, w, h, 8));
  const targetS = smoothS(latest);
  const targetL = smoothL(latest);
  const radPx = 300 / kmPerPx;
  const dtMin = 5;
  const corr = [];
  const corrL = [];
  const maxBackMin = Math.round((tLatest - times[0]) / 60);
  const nStepsBack = Math.ceil(Math.max(maxBackMin, 120) / dtMin);
  // Forward advection of an old frame == sampling it along backward trajectories from "now".
  const lattice = trajectoryLattice(vel, w, h, 4, dtMin, Math.max(nStepsBack, Math.ceil((maxLeadMin + ageMin) / dtMin)));
  for (let k = 0; k < rates.length - 1; k++) {
    const lag = (tLatest - times[k]) / 60;
    if (lag < 9 || lag > 65) continue;
    const s = Math.round(lag / dtMin) - 1;
    if (s < 0 || s >= lattice.snapshots.length) continue;
    const adv = advectWithLattice(rates[k], cov, w, h, lattice, s);
    const c = correlation(smoothS(adv.rate), targetS, cov, w, h, pin.x, pin.y, radPx);
    if (Number.isFinite(c.r)) corr.push({ lag, r: c.r, n: c.n });
    const cl = correlation(smoothL(adv.rate), targetL, cov, w, h, pin.x, pin.y, radPx);
    if (Number.isFinite(cl.r)) corrL.push({ lag, r: cl.r, n: cl.n });
  }
  const fitTau = (cs) => {
    if (cs.length >= 2) {
      // least squares through the origin of ln(r) = -lag / tau
      let num = 0, den = 0;
      for (const c of cs) {
        const r = clamp(c.r, 0.05, 0.995);
        num += c.lag * c.lag;
        den += -c.lag * Math.log(r);
      }
      return den > 0 ? num / den : 600;
    }
    if (cs.length === 1) return -cs[0].lag / Math.log(clamp(cs[0].r, 0.05, 0.995));
    return NaN;
  };
  const tau = fitTau(corr);
  const tauLarge = fitTau(corrL);
  const tauUsed = Number.isFinite(tau) ? clamp(tau, 15, 480) : 60;
  const tauLargeUsed = Number.isFinite(tauLarge) ? clamp(Math.max(tauLarge, tauUsed), 15, 600) : tauUsed * 1.5;

  // ---- Summed-area tables of the latest field for neighbourhood statistics ----
  const covSAT = new SAT(w, h, (i) => (cov ? cov[i] : 1));
  const thrSAT = THRESH.map((t) => new SAT(w, h, (i) => (latest[i] >= t && (!cov || cov[i]) ? 1 : 0)));
  const rateSAT = new SAT(w, h, (i) => latest[i], Float64Array);
  const smallBlur = boxBlur(latest, w, h, 1); // 3x3 (~7 km) point estimate, removes pixel noise

  // Neighbourhood radius grows with lead time; faster-evolving storms (short tau) grow it faster.
  const growth = clamp(0.25 * Math.sqrt(60 / tauUsed), 0.12, 0.5); // km per minute
  const radiusKm = (lead) => 2.5 + growth * lead;

  // Motion uncertainty for the ensemble (R1 px/min)
  const gm = motion.stats.globalMean || { u: 0, v: 0 };
  const speed = Math.hypot(gm.u, gm.v);
  const base = 3 / 60 / kmPerPx; // 3 km/h floor
  const sigmaV = Math.sqrt((0.15 * speed) ** 2 + base ** 2 + (0.5 * (motion.stats.temporalSpread || 0)) ** 2);
  const rand = rng(Math.round(pin.x * 1000 + pin.y * 7 + tLatest));

  const nLead = Math.floor((maxLeadMin + ageMin) / dtMin) + 1; // leads from the latest frame
  const leads = Array.from({ length: nLead }, (_, k) => k * dtMin);
  const memberPts = [];
  for (let m = 0; m < members; m++) {
    let du = 0, dv = 0;
    if (m > 0) {
      const [g1, g2] = gaussianPair(rand);
      du = g1 * sigmaV; dv = g2 * sigmaV;
    }
    const pts = [[pin.x, pin.y]];
    let x = pin.x, y = pin.y;
    for (let k = 1; k < nLead; k++) {
      [x, y] = backStep(vel, x, y, dtMin, du, dv);
      pts.push([x, y]);
    }
    memberPts.push(pts);
  }

  const out = {
    leads, ageMin, tLatest,
    prob: THRESH.map(() => new Float32Array(nLead)),
    known: new Float32Array(nLead),
    q10: new Float32Array(nLead), q50: new Float32Array(nLead), q90: new Float32Array(nLead),
    meanRate: new Float32Array(nLead),
    radiusKm: new Float32Array(nLead),
  };
  const memberRates = memberPts.map(() => new Float32Array(nLead));
  for (let k = 0; k < nLead; k++) {
    const lead = leads[k];
    const rk = radiusKm(lead);
    out.radiusKm[k] = rk;
    const hw = Math.max(1, Math.round(rk / kmPerPx));
    const area = (2 * hw + 1) ** 2;
    let covSum = 0;
    const thrSum = [0, 0, 0, 0];
    let rateSum = 0;
    let knownSum = 0;
    const vals = [];
    for (let m = 0; m < members; m++) {
      const [x, y] = memberPts[m][k];
      const xi = Math.round(x), yi = Math.round(y);
      const c = covSAT.box(xi - hw, yi - hw, xi + hw, yi + hw);
      knownSum += c / area;
      covSum += c;
      for (let t = 0; t < 4; t++) thrSum[t] += thrSAT[t].box(xi - hw, yi - hw, xi + hw, yi + hw);
      rateSum += rateSAT.box(xi - hw, yi - hw, xi + hw, yi + hw);
      const pv = bilinear(smallBlur, w, h, x, y);
      const inCov = !cov || (xi >= 0 && yi >= 0 && xi < w && yi < h && cov[yi * w + xi]);
      memberRates[m][k] = Number.isFinite(pv) && inCov ? pv : NaN;
      if (Number.isFinite(pv) && inCov) vals.push(pv);
    }
    out.known[k] = knownSum / members;
    for (let t = 0; t < 4; t++) out.prob[t][k] = covSum > 0 ? thrSum[t] / covSum : NaN;
    out.meanRate[k] = covSum > 0 ? rateSum / covSum : NaN;
    out.q10[k] = vals.length ? weightedQuantile(vals, null, 0.1) : NaN;
    out.q50[k] = vals.length ? weightedQuantile(vals, null, 0.5) : NaN;
    out.q90[k] = vals.length ? weightedQuantile(vals, null, 0.9) : NaN;
  }

  // ---- Member arrival / end times (minutes after the latest frame), interpolated between steps ----
  const arrivals = [];
  const ends = [];
  const kNow = Math.min(nLead - 1, Math.round(ageMin / dtMin));
  const thr = RAIN.light;
  const cross = (a, b, k) => {
    // linear interpolation of the threshold crossing between step k-1 (value a) and k (value b)
    if (!(Number.isFinite(a) && Number.isFinite(b)) || a === b) return leads[k];
    return leads[k - 1] + dtMin * clamp((thr - a) / (b - a), 0, 1);
  };
  for (let m = 0; m < members; m++) {
    const r = memberRates[m];
    let arr = NaN;
    for (let k = kNow; k < nLead; k++) {
      if (r[k] >= thr) { arr = k > kNow ? cross(r[k - 1], r[k], k) : leads[k]; break; }
      if (Number.isNaN(r[k])) break; // left radar coverage: unknown
    }
    arrivals.push(arr);
    if (Number.isFinite(arr)) {
      let end = NaN;
      const k0 = Math.ceil(arr / dtMin);
      for (let k = Math.max(k0, 1); k < nLead - 1; k++) {
        if (!(r[k] >= thr) && !(r[k + 1] >= thr)) { end = cross(r[k - 1], r[k], k); break; }
      }
      ends.push(end);
    }
  }

  // ---- Upstream echo along the central trajectory ----
  const central = memberPts[0];
  let approach = null;
  const near = new SAT(w, h, (i) => (latest[i] >= RAIN.light && (!cov || cov[i]) ? 1 : 0));
  const hw5 = Math.max(1, Math.round(4 / kmPerPx));
  for (let k = kNow; k < nLead; k++) {
    const [x, y] = central[k];
    const xi = Math.round(x), yi = Math.round(y);
    if (near.box(xi - hw5, yi - hw5, xi + hw5, yi + hw5) > 0) {
      approach = { lead: leads[k], x, y };
      break;
    }
  }
  // nearest echo in any direction (context when nothing is upstream)
  let nearest = null;
  {
    const maxR = Math.min(Math.round(250 / kmPerPx), Math.max(w, h));
    let best = Infinity;
    const px = Math.round(pin.x), py = Math.round(pin.y);
    for (let y = Math.max(0, py - maxR); y < Math.min(h, py + maxR); y += 1) {
      for (let x = Math.max(0, px - maxR); x < Math.min(w, px + maxR); x += 1) {
        const i = y * w + x;
        if (latest[i] >= RAIN.light && (!cov || cov[i])) {
          const d = (x - pin.x) ** 2 + (y - pin.y) ** 2;
          if (d < best) { best = d; nearest = { x, y, rate: latest[i] }; }
        }
      }
    }
    if (nearest) nearest.distKm = Math.sqrt(best) * kmPerPx;
  }
  // max intensity in the upstream cell (within 15 km of the approach point)
  if (approach) {
    const r = Math.round(15 / kmPerPx);
    let mx = 0;
    for (let y = Math.round(approach.y) - r; y <= Math.round(approach.y) + r; y++) {
      for (let x = Math.round(approach.x) - r; x <= Math.round(approach.x) + r; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        mx = Math.max(mx, latest[y * w + x]);
      }
    }
    approach.maxRate = mx;
    approach.distKm = Math.hypot(approach.x - pin.x, approach.y - pin.y) * kmPerPx;
  }

  // ---- Current state at the pin (as of the latest frame) ----
  const nowRate = bilinear(smallBlur, w, h, pin.x, pin.y);
  const pinCovered = !cov || cov[Math.round(pin.y) * w + Math.round(pin.x)] === 1;
  const covFracNear = covSAT.box(
    Math.round(pin.x - 50 / kmPerPx), Math.round(pin.y - 50 / kmPerPx),
    Math.round(pin.x + 50 / kmPerPx), Math.round(pin.y + 50 / kmPerPx),
  ) / (2 * Math.round(50 / kmPerPx) + 1) ** 2;

  // ---- Chance of rain in the next hour for every point of the map (lattice, ~10 km) ----
  // Same local-Lagrangian method as at the pin: at each lead, the share of rainy radar pixels in a
  // growing neighbourhood around the upstream origin; the hourly chance is the highest of those.
  function chanceNextHour() {
    const { lw, lh, step, snapshots } = lattice;
    const out = new Float32Array(lw * lh).fill(NaN);
    const k0 = Math.max(0, Math.round(ageMin / dtMin) - 1);
    const k1 = Math.min(snapshots.length - 1, Math.round((ageMin + 60) / dtMin) - 1);
    for (let n = 0; n < lw * lh; n++) {
      let best = 0;
      let known = 0;
      for (let k = k0; k <= k1; k++) {
        const lead = (k + 1) * dtMin;
        const hw = Math.max(1, Math.round(radiusKm(lead) / kmPerPx));
        const xi = Math.round(snapshots[k].xs[n]);
        const yi = Math.round(snapshots[k].ys[n]);
        const c = covSAT.box(xi - hw, yi - hw, xi + hw, yi + hw);
        if (c < 0.3 * (2 * hw + 1) ** 2) continue;
        known++;
        const p = thrSAT[0].box(xi - hw, yi - hw, xi + hw, yi + hw) / c;
        if (p > best) best = p;
      }
      // the point itself right now (lead 0) also counts
      const x0 = Math.min(w - 1, (n % lw) * step), y0 = Math.min(h - 1, Math.floor(n / lw) * step);
      const c0 = covSAT.box(x0 - 1, y0 - 1, x0 + 1, y0 + 1);
      if (c0 > 0) { known++; best = Math.max(best, thrSAT[0].box(x0 - 1, y0 - 1, x0 + 1, y0 + 1) / c0); }
      if (known) out[n] = best;
    }
    return { data: out, nx: lw, ny: lh, step };
  }

  // ---- Motion at the pin ----
  const [pu, pv] = vel(pin.x, pin.y);
  const eastKmh = pu * kmPerPx * 60;
  const northKmh = -pv * kmPerPx * 60;

  return {
    ...out,
    tau, tauUsed, tauLarge, tauLargeUsed, corr, corrL, growth,
    arrivals, ends,
    approach, nearest,
    memberRates,
    now: { rate: nowRate, dbz: rateToDbz(nowRate), covered: pinCovered, covFracNear },
    motionAtPin: { eastKmh, northKmh, speedKmh: Math.hypot(eastKmh, northKmh) },
    sigmaVKmh: sigmaV * kmPerPx * 60,
    lattice,
    probField: chanceNextHour(),
    members,
  };
}

/**
 * Forecast radar frames for the map (every `everyMin` minutes, up to `maxMin` after the latest frame).
 * Reuses the trajectory lattice computed by runNowcast.
 */
export function forecastFrames(nc, latest, cov, w, h, { everyMin = 10, maxMin = 120 } = {}) {
  const frames = [];
  const dt = 5;
  for (let t = everyMin; t <= maxMin; t += everyMin) {
    const s = Math.round(t / dt) - 1;
    if (s >= nc.lattice.snapshots.length) break;
    const adv = advectWithLattice(latest, cov, w, h, nc.lattice, s);
    frames.push({ leadMin: t, time: nc.tLatest + t * 60, rate: adv.rate, known: adv.known });
  }
  return frames;
}

export { dbzToRate };
