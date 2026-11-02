// Storm-motion estimation from consecutive radar frames.
// Multi-scale block matching with zero-normalised cross-correlation (the TREC/COTREC family used by
// operational nowcasting systems), robust aggregation over several frame pairs, vector-median
// outlier rejection, and kernel interpolation onto a smooth field. Where there are no echoes, the
// field relaxes to the model steering wind (700 hPa), so newly appearing cells still move sensibly.
//
// Units: positions in R1 grid pixels (x east, y south), velocities in R1 pixels per minute.

import { rateToDbz, clamp, median } from './util.js';

/** Rain rate (mm/h) field -> matching intensity in [0,1] (log-like, robust to growth/decay). */
function toIntensity(rate) {
  const out = new Float32Array(rate.length);
  for (let i = 0; i < rate.length; i++) {
    const r = rate[i];
    if (r > 0.05) out[i] = clamp((rateToDbz(r) - 10) / 45, 0, 1);
  }
  return out;
}

function halve(src, w, h) {
  const w2 = w >> 1;
  const h2 = h >> 1;
  const out = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    const r0 = 2 * y * w;
    const r1 = r0 + w;
    for (let x = 0; x < w2; x++) {
      const i = 2 * x;
      out[y * w2 + x] = 0.25 * (src[r0 + i] + src[r0 + i + 1] + src[r1 + i] + src[r1 + i + 1]);
    }
  }
  return out;
}

function integral(img, w, h) {
  const W = w + 1;
  const s = new Float64Array(W * (h + 1));
  const s2 = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    let row2 = 0;
    for (let x = 0; x < w; x++) {
      const v = img[y * w + x];
      row += v;
      row2 += v * v;
      s[(y + 1) * W + x + 1] = s[y * W + x + 1] + row;
      s2[(y + 1) * W + x + 1] = s2[y * W + x + 1] + row2;
    }
  }
  return { s, s2, W };
}
function boxSum(I, W, x0, y0, x1, y1) {
  // sum over [x0,x1) x [y0,y1)
  return I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
}

/**
 * Best NCC match of the template (A around cx,cy, half-size B) in image Bimg within a search window.
 * Returns {dx, dy, c, edge} with sub-pixel refinement.
 */
function matchBlock(A, Bimg, w, h, intB, cx, cy, B, sx, sy, M) {
  const n = 4 * B * B;
  let sum = 0;
  let sum2 = 0;
  let nz = 0;
  for (let y = cy - B; y < cy + B; y++) {
    for (let x = cx - B; x < cx + B; x++) {
      const v = A[y * w + x];
      sum += v;
      sum2 += v * v;
      if (v > 0) nz++;
    }
  }
  const muT = sum / n;
  const varT = sum2 / n - muT * muT;
  if (nz < 0.08 * n || varT < 0.0009) return null; // not enough structure to track
  const sdT = Math.sqrt(varT);
  const size = 2 * M + 1;
  const surf = new Float32Array(size * size).fill(-1);
  let best = -2;
  let bx = 0;
  let by = 0;
  for (let dy = -M; dy <= M; dy++) {
    const oy = cy + sy + dy;
    if (oy - B < 0 || oy + B > h) continue;
    for (let dx = -M; dx <= M; dx++) {
      const ox = cx + sx + dx;
      if (ox - B < 0 || ox + B > w) continue;
      const sW = boxSum(intB.s, intB.W, ox - B, oy - B, ox + B, oy + B);
      const s2W = boxSum(intB.s2, intB.W, ox - B, oy - B, ox + B, oy + B);
      const muW = sW / n;
      const varW = s2W / n - muW * muW;
      if (varW < 0.0004) continue;
      let cross = 0;
      for (let y = -B; y < B; y++) {
        const ra = (cy + y) * w + cx;
        const rb = (oy + y) * w + ox;
        for (let x = -B; x < B; x++) cross += A[ra + x] * Bimg[rb + x];
      }
      const c = (cross / n - muT * muW) / (sdT * Math.sqrt(varW));
      surf[(dy + M) * size + (dx + M)] = c;
      if (c > best) { best = c; bx = dx; by = dy; }
    }
  }
  if (best < -1) return null;
  // sub-pixel parabolic refinement
  const at = (dx, dy) => {
    const ix = dx + M;
    const iy = dy + M;
    if (ix < 0 || iy < 0 || ix >= size || iy >= size) return NaN;
    return surf[iy * size + ix];
  };
  let fx = 0;
  let fy = 0;
  const cl = at(bx - 1, by), cr = at(bx + 1, by), cu = at(bx, by - 1), cd = at(bx, by + 1);
  if (Number.isFinite(cl) && Number.isFinite(cr) && cl > -1 && cr > -1) {
    const den = cl - 2 * best + cr;
    if (den < 0) fx = clamp((cl - cr) / (2 * den), -0.5, 0.5);
  }
  if (Number.isFinite(cu) && Number.isFinite(cd) && cu > -1 && cd > -1) {
    const den = cu - 2 * best + cd;
    if (den < 0) fy = clamp((cu - cd) / (2 * den), -0.5, 0.5);
  }
  const edge = Math.abs(bx) === M || Math.abs(by) === M;
  // Curvature of the correlation peak tells how well each direction is constrained. A long rain band
  // gives a ridge: sharp across the band, flat along it (the "aperture problem"). We keep that shape as
  // an information matrix so the along-band component is filled in by other echoes or the wind prior.
  let info = [1, 0, 1];
  const cul = at(bx - 1, by - 1), cur = at(bx + 1, by - 1), cdl = at(bx - 1, by + 1), cdr = at(bx + 1, by + 1);
  if ([cl, cr, cu, cd, cul, cur, cdl, cdr].every((q) => Number.isFinite(q) && q > -1)) {
    const a = -(cl - 2 * best + cr);
    const c = -(cu - 2 * best + cd);
    const b = -(cdr - cur - cdl + cul) / 4;
    info = shapeMatrix(a, b, c) || info;
  }
  return { dx: sx + bx + fx, dy: sy + by + fy, c: best, edge, info };
}

/** Normalise a symmetric 2x2 curvature matrix to mean eigenvalue 1, flooring the weak axis. */
function shapeMatrix(a, b, c) {
  const m = (a + c) / 2;
  const r = Math.sqrt(((a - c) / 2) ** 2 + b * b);
  let l1 = m + r;
  let l2 = m - r;
  if (!(l1 > 1e-5)) return null;
  l2 = Math.max(l2, 0.06 * l1);
  const th = 0.5 * Math.atan2(2 * b, a - c);
  const cs = Math.cos(th), sn = Math.sin(th);
  const k = 2 / (l1 + l2);
  l1 *= k; l2 *= k;
  return [l1 * cs * cs + l2 * sn * sn, (l1 - l2) * cs * sn, l1 * sn * sn + l2 * cs * cs];
}

/** Solve (A) v = b for symmetric 2x2 A = [a00, a01, a11]. */
function solve2(A, bx, by) {
  const det = A[0] * A[2] - A[1] * A[1];
  if (Math.abs(det) < 1e-12) return [bx / (A[0] || 1), by / (A[2] || 1)];
  return [(A[2] * bx - A[1] * by) / det, (A[0] * by - A[1] * bx) / det];
}

/**
 * Estimate the motion field.
 * @param {Float32Array[]} rates  R1 rain-rate fields, oldest -> newest
 * @param {number[]} times        unix seconds per field
 * @param {number} w,h            R1 dimensions (must be divisible by 4)
 * @param {object} opts           { prior: {u,v} R1 px/min or null, kmPerPx (R1), vmaxKmh }
 */
export function estimateMotion(rates, times, w, h, opts = {}) {
  const kmPerPx = opts.kmPerPx || 2.4;
  const vmax = opts.vmaxKmh || 130; // km/h, fast squall lines
  const S1 = 16; // node spacing in R1 px (~38 km)
  const nx = Math.floor(w / S1) + 1;
  const ny = Math.floor(h / S1) + 1;
  const prior = opts.prior || null;

  const n = rates.length;
  const I2 = [];
  const I3 = [];
  for (let k = 0; k < n; k++) {
    const i1 = toIntensity(rates[k]);
    const i2 = halve(i1, w, h);
    I2.push(i2);
    I3.push(halve(i2, w >> 1, h >> 1));
  }
  const w2 = w >> 1, h2 = h >> 1, w3 = w >> 2, h3 = h >> 2;
  const int2 = I2.map((im) => integral(im, w2, h2));
  const int3 = I3.map((im) => integral(im, w3, h3));

  // frame pairs separated by ~20 and ~30 minutes (more displacement -> better precision)
  const pairs = [];
  for (let b = n - 1; b >= 1; b--) {
    for (let a = b - 1; a >= 0; a--) {
      const dt = (times[b] - times[a]) / 60;
      if (dt >= 15 && dt <= 35) pairs.push({ a, b, dt, wgt: Math.pow(0.85, n - 1 - b) });
    }
  }
  if (!pairs.length) {
    for (let b = n - 1; b >= 1; b--) {
      const dt = (times[b] - times[b - 1]) / 60;
      if (dt > 3) pairs.push({ a: b - 1, b, dt, wgt: Math.pow(0.85, n - 1 - b) });
    }
  }

  const B3 = 5;
  const B2 = 10;
  const samples = Array.from({ length: nx * ny }, () => []);
  const pairMeans = [];
  for (const p of pairs) {
    const M3 = clamp(Math.ceil((vmax / 60) * p.dt / (kmPerPx * 4)), 2, 10);
    let su = 0, sv = 0, sw = 0;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const cx3 = i * (S1 >> 2);
        const cy3 = j * (S1 >> 2);
        if (cx3 - B3 - M3 < 0 || cy3 - B3 - M3 < 0 || cx3 + B3 + M3 > w3 || cy3 + B3 + M3 > h3) continue;
        const coarse = matchBlock(I3[p.a], I3[p.b], w3, h3, int3[p.b], cx3, cy3, B3, 0, 0, M3);
        if (!coarse || coarse.c < 0.35 || coarse.edge) continue;
        const cx2 = cx3 * 2;
        const cy2 = cy3 * 2;
        const sx = Math.round(coarse.dx * 2);
        const sy = Math.round(coarse.dy * 2);
        if (cx2 - B2 < 0 || cy2 - B2 < 0 || cx2 + B2 > w2 || cy2 + B2 > h2) continue;
        const fine = matchBlock(I2[p.a], I2[p.b], w2, h2, int2[p.b], cx2, cy2, B2, sx, sy, 2);
        if (!fine || fine.c < 0.45) continue;
        const u = (fine.dx * 2) / p.dt; // R1 px / min
        const v = (fine.dy * 2) / p.dt;
        const wt = p.wgt * fine.c;
        samples[j * nx + i].push({ u, v, w: wt, info: fine.info });
        su += u * wt; sv += v * wt; sw += wt;
      }
    }
    if (sw > 0) pairMeans.push({ u: su / sw, v: sv / sw, w: sw });
  }

  // aggregate per node: reject samples far from the median, then information-weighted mean
  const U = new Float32Array(nx * ny);
  const V = new Float32Array(nx * ny);
  const Wt = new Float32Array(nx * ny);
  const Ainfo = new Float32Array(nx * ny * 3);
  for (let k = 0; k < nx * ny; k++) {
    const s = samples[k];
    if (!s.length) continue;
    const mu = median(s.map((q) => q.u));
    const mv = median(s.map((q) => q.v));
    const tol = Math.max(0.1, 0.5 * Math.hypot(mu, mv));
    const A = [0, 0, 0];
    let bx = 0, by = 0, wsum = 0;
    for (const q of s) {
      if (Math.hypot(q.u - mu, q.v - mv) > tol) continue;
      const I = q.info;
      A[0] += q.w * I[0]; A[1] += q.w * I[1]; A[2] += q.w * I[2];
      bx += q.w * (I[0] * q.u + I[1] * q.v);
      by += q.w * (I[1] * q.u + I[2] * q.v);
      wsum += q.w;
    }
    if (wsum <= 0) continue;
    const [uu, vv] = solve2(A, bx, by);
    U[k] = uu; V[k] = vv; Wt[k] = wsum;
    Ainfo[3 * k] = A[0]; Ainfo[3 * k + 1] = A[1]; Ainfo[3 * k + 2] = A[2];
  }

  // vector-median outlier rejection against neighbours within 2 nodes
  const valid = new Uint8Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) valid[k] = Wt[k] > 0 ? 1 : 0;
  const keep = new Uint8Array(valid);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!valid[k]) continue;
      const nu = [], nv = [];
      for (let dj = -2; dj <= 2; dj++) {
        for (let di = -2; di <= 2; di++) {
          if (!di && !dj) continue;
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
          const kk = jj * nx + ii;
          if (valid[kk]) { nu.push(U[kk]); nv.push(V[kk]); }
        }
      }
      if (nu.length < 3) {
        if (Wt[k] < 0.8) keep[k] = 0; // isolated weak vector: unreliable
        continue;
      }
      const mu = median(nu), mv = median(nv);
      const dev = Math.hypot(U[k] - mu, V[k] - mv);
      const ref = Math.hypot(mu, mv);
      if (dev > Math.max(0.12, 0.45 * ref)) keep[k] = 0;
    }
  }

  // global statistics (used for ensemble perturbations and reporting)
  const GA = [0, 0, 0];
  let gbx = 0, gby = 0, gw = 0, nValid = 0;
  for (let k = 0; k < nx * ny; k++) {
    if (!keep[k]) continue;
    const a0 = Ainfo[3 * k], a1 = Ainfo[3 * k + 1], a2 = Ainfo[3 * k + 2];
    GA[0] += a0; GA[1] += a1; GA[2] += a2;
    gbx += a0 * U[k] + a1 * V[k];
    gby += a1 * U[k] + a2 * V[k];
    gw += Wt[k];
    nValid++;
  }
  let globalMean = null;
  if (gw > 0) {
    const [gu, gv] = solve2(GA, gbx, gby);
    globalMean = { u: gu, v: gv };
  }
  let spread = 0;
  if (globalMean && nValid > 1) {
    let s = 0;
    for (let k = 0; k < nx * ny; k++) {
      if (!keep[k]) continue;
      s += Wt[k] * ((U[k] - globalMean.u) ** 2 + (V[k] - globalMean.v) ** 2);
    }
    spread = Math.sqrt(s / gw);
  }
  let temporalSpread = 0;
  if (pairMeans.length > 1) {
    const mu = pairMeans.reduce((a, p) => a + p.u, 0) / pairMeans.length;
    const mv = pairMeans.reduce((a, p) => a + p.v, 0) / pairMeans.length;
    temporalSpread = Math.sqrt(pairMeans.reduce((a, p) => a + (p.u - mu) ** 2 + (p.v - mv) ** 2, 0) / pairMeans.length);
  }

  // kernel interpolation onto every node (information-weighted), relaxed towards the prior where
  // data are sparse or only constrain one direction
  const sigma = 1.8; // nodes (~70 km)
  const R = 5;
  const priorVec = prior || globalMean || { u: 0, v: 0 };
  const priorW = prior ? 0.35 : globalMean ? 0.15 : 1;
  const Fu = new Float32Array(nx * ny);
  const Fv = new Float32Array(nx * ny);
  const conf = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const A = [priorW, 0, priorW];
      let bx = priorW * priorVec.u, by = priorW * priorVec.v;
      for (let dj = -R; dj <= R; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= ny) continue;
        for (let di = -R; di <= R; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= nx) continue;
          const kk = jj * nx + ii;
          if (!keep[kk]) continue;
          const g = (Math.exp(-(di * di + dj * dj) / (2 * sigma * sigma)) * Math.min(1.5, Wt[kk])) / Wt[kk];
          const a0 = Ainfo[3 * kk] * g, a1 = Ainfo[3 * kk + 1] * g, a2 = Ainfo[3 * kk + 2] * g;
          A[0] += a0; A[1] += a1; A[2] += a2;
          bx += a0 * U[kk] + a1 * V[kk];
          by += a1 * U[kk] + a2 * V[kk];
        }
      }
      const [uu, vv] = solve2(A, bx, by);
      Fu[j * nx + i] = uu;
      Fv[j * nx + i] = vv;
      conf[j * nx + i] = 1 - (2 * priorW) / (A[0] + A[2]);
    }
  }

  const field = { nx, ny, S1, u: Fu, v: Fv, conf };
  return {
    field,
    sample: (x, y) => sampleField(field, x, y),
    stats: {
      vectors: nValid,
      pairs: pairs.length,
      globalMean,
      spread,
      temporalSpread,
      usedPrior: !!prior,
    },
    raw: { U, V, keep, Wt },
  };
}

/** Bilinear sample of the node field at R1 position (x, y). Returns [u, v]. */
export function sampleField(field, x, y) {
  const { nx, ny, S1, u, v } = field;
  let fx = x / S1;
  let fy = y / S1;
  fx = fx < 0 ? 0 : fx > nx - 1 ? nx - 1 : fx;
  fy = fy < 0 ? 0 : fy > ny - 1 ? ny - 1 : fy;
  const i = Math.min(nx - 2, Math.floor(fx));
  const j = Math.min(ny - 2, Math.floor(fy));
  const ax = fx - i;
  const ay = fy - j;
  const k = j * nx + i;
  const u00 = u[k], u10 = u[k + 1], u01 = u[k + nx], u11 = u[k + nx + 1];
  const v00 = v[k], v10 = v[k + 1], v01 = v[k + nx], v11 = v[k + nx + 1];
  return [
    (u00 * (1 - ax) + u10 * ax) * (1 - ay) + (u01 * (1 - ax) + u11 * ax) * ay,
    (v00 * (1 - ax) + v10 * ax) * (1 - ay) + (v01 * (1 - ax) + v11 * ax) * ay,
  ];
}

/** Convert a wind (km/h, meteorological FROM direction) into R1 px/min of echo motion. */
export function steeringPrior(speedKmh, fromDeg, kmPerPx) {
  if (!Number.isFinite(speedKmh) || !Number.isFinite(fromDeg)) return null;
  const to = ((fromDeg + 180) * Math.PI) / 180;
  const east = speedKmh * Math.sin(to);
  const north = speedKmh * Math.cos(to);
  return { u: east / 60 / kmPerPx, v: -north / 60 / kmPerPx };
}
