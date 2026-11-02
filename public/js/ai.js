// In-browser inference for the India radar nowcast model (backend/model.py, "unet-v1").
// Plain JavaScript, no libraries: ~640 million multiply-adds for a 128x128 window (~0.3-1.5 s in a
// worker). The model files are produced nightly by backend/train.py into public/ai/.

import { rateToDbz } from './util.js';

const FRAMES = 6;
const CROP = 128;
// India training grid in zoom-5 world pixels (256-px tiles): x tiles 22..24, y tiles 12..15
const GRID = { x0: 22 * 256, y0: 12 * 256, w: 3 * 256, h: 4 * 256 };

/** Load model.json/model.bin (and metrics.json) from `base`; returns null when there is no model. */
export async function loadModel(base, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  let metrics = null;
  try {
    const r = await f(`${base}/metrics.json`, { cache: 'no-cache' });
    if (r.ok) metrics = await r.json();
  } catch { /* no metrics yet */ }
  if (metrics && metrics.status === 'collecting') return { model: null, metrics }; // nothing trained yet
  try {
    const r = await f(`${base}/model.json`, { cache: 'no-cache' });
    if (!r.ok) return { model: null, metrics };
    const man = await r.json();
    if (man.arch !== 'unet-v1') return { model: null, metrics };
    const b = await f(`${base}/model.bin?v=${encodeURIComponent(man.version || '0')}`);
    if (!b.ok) return { model: null, metrics };
    const flat = new Float32Array(await b.arrayBuffer());
    if (flat.length !== man.floats) return { model: null, metrics };
    const layers = {};
    for (const L of man.layers) {
      layers[L.name] = { ...L, W: flat.subarray(L.w, L.w + L.out * L.in * L.k * L.k), B: flat.subarray(L.b, L.b + L.out) };
    }
    return { model: { man, layers }, metrics: metrics || man.metrics || null };
  } catch {
    return { model: null, metrics };
  }
}

// ---------- tensor ops: t = { c, h, w, d: Float32Array(c*h*w) } ----------
function conv(t, L, relu) {
  const out = L.k === 1 ? conv1x1(t, L) : conv3x3(t, L);
  if (relu) for (let p = 0; p < out.length; p++) if (out[p] < 0) out[p] = 0;
  return { c: L.out, h: t.h, w: t.w, d: out };
}

function conv1x1(t, L) {
  const { c: cin, h, w, d } = t;
  const hw = h * w, W = L.W;
  const out = new Float32Array(L.out * hw);
  for (let o = 0; o < L.out; o++) {
    const ob = o * hw;
    out.fill(L.B[o], ob, ob + hw);
    for (let i = 0; i < cin; i++) {
      const wv = W[o * cin + i], ib = i * hw;
      for (let p = 0; p < hw; p++) out[ob + p] += wv * d[ib + p];
    }
  }
  return out;
}

/**
 * 3x3 convolution with zero padding (PyTorch Conv2d, padding=1). The input is padded once; each
 * output row is built by sliding a 3x3 window along the padded input rows with the weights held in
 * local variables, two output channels at a time so they share the input loads. Sums are kept in
 * double precision. About 4x faster than a plain per-tap loop.
 */
function conv3x3(t, L) {
  const { c: cin, h, w, d } = t;
  const cout = L.out, hw = h * w, pw = w + 2, phw = (h + 2) * pw;
  const P = new Float32Array(cin * phw);
  for (let i = 0; i < cin; i++) {
    for (let y = 0; y < h; y++) P.set(d.subarray(i * hw + y * w, i * hw + y * w + w), i * phw + (y + 1) * pw + 1);
  }
  const W = L.W, B = L.B;
  const out = new Float32Array(cout * hw);
  const A = new Float64Array(w), C = new Float64Array(w);
  for (let o = 0; o < cout; o += 2) {
    const o2 = Math.min(o + 1, cout - 1); // odd channel count: the last pair repeats a channel
    for (let y = 0; y < h; y++) {
      A.fill(B[o]);
      C.fill(B[o2]);
      for (let i = 0; i < cin; i++) {
        const wb = (o * cin + i) * 9, vb = (o2 * cin + i) * 9;
        const w00 = W[wb], w01 = W[wb + 1], w02 = W[wb + 2], w10 = W[wb + 3], w11 = W[wb + 4], w12 = W[wb + 5], w20 = W[wb + 6], w21 = W[wb + 7], w22 = W[wb + 8];
        const v00 = W[vb], v01 = W[vb + 1], v02 = W[vb + 2], v10 = W[vb + 3], v11 = W[vb + 4], v12 = W[vb + 5], v20 = W[vb + 6], v21 = W[vb + 7], v22 = W[vb + 8];
        const rm = i * phw + y * pw, r0 = rm + pw, rp = r0 + pw; // padded rows y-1, y, y+1
        let am = P[rm], a0 = P[r0], ap = P[rp], bm = P[rm + 1], b0 = P[r0 + 1], bp = P[rp + 1];
        for (let x = 0; x < w; x++) {
          const cm = P[rm + x + 2], c0 = P[r0 + x + 2], cp = P[rp + x + 2];
          A[x] += w00 * am + w01 * bm + w02 * cm + w10 * a0 + w11 * b0 + w12 * c0 + w20 * ap + w21 * bp + w22 * cp;
          C[x] += v00 * am + v01 * bm + v02 * cm + v10 * a0 + v11 * b0 + v12 * c0 + v20 * ap + v21 * bp + v22 * cp;
          am = bm; a0 = b0; ap = bp; bm = cm; b0 = c0; bp = cp;
        }
      }
      const ob = o * hw + y * w;
      for (let x = 0; x < w; x++) out[ob + x] = A[x];
      if (o2 !== o) {
        const ob2 = o2 * hw + y * w;
        for (let x = 0; x < w; x++) out[ob2 + x] = C[x];
      }
    }
  }
  return out;
}
function pool(t) {
  const h = t.h >> 1, w = t.w >> 1;
  const out = new Float32Array(t.c * h * w);
  for (let c = 0; c < t.c; c++) {
    const ib = c * t.h * t.w, ob = c * h * w;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = ib + 2 * y * t.w + 2 * x;
        out[ob + y * w + x] = Math.max(t.d[i], t.d[i + 1], t.d[i + t.w], t.d[i + t.w + 1]);
      }
    }
  }
  return { c: t.c, h, w, d: out };
}
function upcat(small, skip) {
  // nearest-neighbour x2 upsampling of `small`, then channel concat with `skip`
  const h = skip.h, w = skip.w;
  const out = new Float32Array((small.c + skip.c) * h * w);
  for (let c = 0; c < small.c; c++) {
    const ib = c * small.h * small.w, ob = c * h * w;
    for (let y = 0; y < h; y++) {
      const irow = ib + (y >> 1) * small.w;
      for (let x = 0; x < w; x++) out[ob + y * w + x] = small.d[irow + (x >> 1)];
    }
  }
  out.set(skip.d, small.c * h * w);
  return { c: small.c + skip.c, h, w, d: out };
}

/** Forward pass. x: tensor with 7 channels, h and w divisible by 8. Returns probabilities (14 ch). */
export function forward(model, x) {
  const L = model.layers;
  const cc = (t, a, b) => conv(conv(t, L[a], true), L[b], true);
  const e1 = cc(x, 'enc1a', 'enc1b');
  const e2 = cc(pool(e1), 'enc2a', 'enc2b');
  const e3 = cc(pool(e2), 'enc3a', 'enc3b');
  const m = cc(pool(e3), 'mida', 'midb');
  const d3 = cc(upcat(m, e3), 'dec3a', 'dec3b');
  const d2 = cc(upcat(d3, e2), 'dec2a', 'dec2b');
  const d1 = cc(upcat(d2, e1), 'dec1a', 'dec1b');
  const y = conv(d1, L.head, false);
  for (let i = 0; i < y.d.length; i++) y.d[i] = 1 / (1 + Math.exp(-y.d[i]));
  return y;
}

/** True when the pin lies on the India grid the model was trained on (block: zoom 6, 512-px tiles). */
export function covers(block, pin) {
  const wx = block.x0 * 128 + Math.round(pin.x / 2), wy = block.y0 * 128 + Math.round(pin.y / 2);
  return wx >= GRID.x0 && wx < GRID.x0 + GRID.w && wy >= GRID.y0 && wy < GRID.y0 + GRID.h;
}

/**
 * Build the model input from the app's radar frames and run it around the pin.
 * rates: R1 rain-rate fields (oldest -> newest, ~2.4 km), times: unix seconds, cov: R1 coverage,
 * block: radar block (zoom 6, 512-px tiles), pin: {x, y} in R1 pixels.
 * Returns { probs (14 x 128 x 128), x0, y0 (crop origin in R2 = R1/2 pixels) } or null.
 */
export function runModel(model, rates, times, cov, block, pin, w1, h1) {
  const n = rates.length;
  if (n < FRAMES) return null;
  for (let k = n - FRAMES + 1; k < n; k++) if (Math.abs(times[k] - times[k - 1] - 600) > 90) return null;
  if (!covers(block, pin)) return null; // outside India
  const w2 = w1 >> 1, h2 = h1 >> 1;
  const px = Math.round(pin.x / 2), py = Math.round(pin.y / 2);
  const x0 = Math.max(0, Math.min(w2 - CROP, px - CROP / 2));
  const y0 = Math.max(0, Math.min(h2 - CROP, py - CROP / 2));
  const hw = CROP * CROP;
  const d = new Float32Array(7 * hw);
  for (let f = 0; f < FRAMES; f++) {
    const R = rates[n - FRAMES + f];
    const base = f * hw;
    for (let y = 0; y < CROP; y++) {
      const r1 = (2 * (y0 + y)) * w1;
      for (let x = 0; x < CROP; x++) {
        const c1 = 2 * (x0 + x);
        const rate = 0.25 * (R[r1 + c1] + R[r1 + c1 + 1] + R[r1 + w1 + c1] + R[r1 + w1 + c1 + 1]);
        if (rate >= 0.05) {
          const v = (Math.round(rateToDbz(rate)) - 10) / 50; // rounded like the stored archive codes
          d[base + y * CROP + x] = v < 0 ? 0 : v > 1 ? 1 : v;
        }
      }
    }
  }
  for (let y = 0; y < CROP; y++) {
    const r1 = (2 * (y0 + y)) * w1;
    for (let x = 0; x < CROP; x++) {
      const c1 = 2 * (x0 + x);
      const c = cov ? cov[r1 + c1] + cov[r1 + c1 + 1] + cov[r1 + w1 + c1] + cov[r1 + w1 + c1 + 1] : 4;
      d[6 * hw + y * CROP + x] = c >= 2 ? 1 : 0;
    }
  }
  const out = forward(model, { c: 7, h: CROP, w: CROP, d });
  return { probs: out.d, size: CROP, x0, y0 };
}

/** Bilinear sample of output channel `ch` at R1 position (x, y). */
export function sampleAt(res, ch, x1, y1) {
  const s = res.size;
  const gx = x1 / 2 - res.x0 - 0.5, gy = y1 / 2 - res.y0 - 0.5;
  if (gx < 0 || gy < 0 || gx > s - 1 || gy > s - 1) return NaN;
  const i = Math.min(s - 2, Math.floor(gx)), j = Math.min(s - 2, Math.floor(gy));
  const fx = gx - i, fy = gy - j;
  const b = ch * s * s;
  const p = res.probs;
  return (p[b + j * s + i] * (1 - fx) + p[b + j * s + i + 1] * fx) * (1 - fy) + (p[b + (j + 1) * s + i] * (1 - fx) + p[b + (j + 1) * s + i + 1] * fx) * fy;
}

/** How much to trust the model at each output, from last night's held-out test (0 .. 0.85). */
export function trustWeights(metrics) {
  const bm = metrics && metrics.brier && metrics.brier.model;
  const be = metrics && metrics.brier && metrics.brier.extrapolation;
  if (!bm || !be) return null;
  return bm.map((v, j) => {
    if (!(be[j] > 0)) return 0;
    const gain = (be[j] - v) / be[j]; // relative improvement over radar extrapolation
    return Math.max(0, Math.min(0.85, 0.5 + 2 * gain));
  });
}
