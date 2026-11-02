// Shared helpers: geodesy, Web Mercator tiles, radar physics, statistics, formatting.

export const EARTH_KM = 6371.0088;
export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

// ---------- Web Mercator (slippy-map tiles) ----------
export const lonToTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
export function latToTileY(lat, z) {
  const r = clamp(lat, -85.05112878, 85.05112878) * D2R;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}
export const tileXToLon = (x, z) => (x / 2 ** z) * 360 - 180;
export function tileYToLat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return R2D * Math.atan(Math.sinh(n));
}
/** Ground size (km) of one pixel of a `tileSize` tile at zoom z and latitude. */
export const mercatorPixelKm = (lat, z, tileSize = 256) =>
  (40075.016686 * Math.cos(lat * D2R)) / (2 ** z * tileSize);

// ---------- Geodesy ----------
export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}
export function destinationPoint(lat, lon, bearingDeg, distKm) {
  const d = distKm / EARTH_KM;
  const b = bearingDeg * D2R;
  const p1 = lat * D2R;
  const l1 = lon * D2R;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 =
    l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 * R2D, lon: ((((l2 * R2D + 540) % 360) + 360) % 360) - 180 };
}

/** Meteorological convention: direction the wind/echo comes FROM, degrees clockwise from north. */
export function vectorToFromDir(u, v) {
  // u: eastward, v: northward (any speed unit)
  return (Math.atan2(-u, -v) * R2D + 360) % 360;
}
/** Direction the vector points TO (bearing). */
export const vectorToBearing = (u, v) => (Math.atan2(u, v) * R2D + 360) % 360;

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass16 = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
const COMPASS_WORDS = {
  N: 'north', NNE: 'north-northeast', NE: 'northeast', ENE: 'east-northeast', E: 'east',
  ESE: 'east-southeast', SE: 'southeast', SSE: 'south-southeast', S: 'south',
  SSW: 'south-southwest', SW: 'southwest', WSW: 'west-southwest', W: 'west',
  WNW: 'west-northwest', NW: 'northwest', NNW: 'north-northwest',
};
export const compassWords = (deg) => COMPASS_WORDS[compass16(deg)];

// ---------- Radar physics ----------
/** Marshall–Palmer Z = 200 R^1.6. Returns rain rate (mm/h) from reflectivity (dBZ). */
export function dbzToRate(dbz) {
  if (!(dbz > 5)) return 0;
  return Math.pow(Math.pow(10, dbz / 10) / 200, 1 / 1.6);
}
export function rateToDbz(rate) {
  if (!(rate > 0)) return -Infinity;
  return 10 * Math.log10(200 * Math.pow(rate, 1.6));
}

// Intensity classes used throughout (mm/h). Radar thresholds are their dBZ equivalents.
export const RAIN = {
  light: 0.3, //  ≈ 15 dBZ — first echo that is reliably rain at the ground
  moderate: 2.5, // ≈ 30 dBZ
  heavy: 10, //  ≈ 40 dBZ
  violent: 50, // ≈ 51 dBZ — torrential, often with hail/lightning
};
export const RAIN_DBZ = {
  light: 15,
  moderate: 30,
  heavy: 40,
  violent: 51,
};

export function rateCategory(rate) {
  if (!(rate >= RAIN.light)) return 0;
  if (rate < RAIN.moderate) return 1;
  if (rate < RAIN.heavy) return 2;
  if (rate < RAIN.violent) return 3;
  return 4;
}
export const CATEGORY_LABEL = ['Dry', 'Light rain', 'Moderate rain', 'Heavy rain', 'Torrential rain'];

// ---------- Statistics ----------
/** Weighted quantile of values (weights >= 0). Returns NaN if no weight. */
export function weightedQuantile(values, weights, q) {
  const idx = [];
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    const w = weights ? weights[i] : 1;
    if (w > 0 && Number.isFinite(values[i])) {
      idx.push(i);
      total += w;
    }
  }
  if (!idx.length || total <= 0) return NaN;
  idx.sort((a, b) => values[a] - values[b]);
  // Midpoint rule: each sample sits at the centre of its weight interval; interpolate between them.
  let acc = 0;
  let prevPos = -Infinity;
  let prevVal = values[idx[0]];
  for (let k = 0; k < idx.length; k++) {
    const w = weights ? weights[idx[k]] : 1;
    const pos = (acc + w / 2) / total;
    const val = values[idx[k]];
    if (q <= pos) {
      if (!Number.isFinite(prevPos)) return val;
      const f = (q - prevPos) / (pos - prevPos || 1);
      return prevVal + (val - prevVal) * f;
    }
    acc += w;
    prevPos = pos;
    prevVal = val;
  }
  return values[idx[idx.length - 1]];
}

export function median(arr) {
  const a = arr.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

export function mean(arr) {
  let s = 0;
  let n = 0;
  for (const v of arr) if (Number.isFinite(v)) { s += v; n++; }
  return n ? s / n : NaN;
}

/** Deterministic PRNG (mulberry32) so a forecast is reproducible for the same data. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gaussianPair(rand) {
  let u = 0;
  while (u === 0) u = rand();
  const v = rand();
  const r = Math.sqrt(-2 * Math.log(u));
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)];
}

// ---------- Async helpers ----------
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nextFrame = () => new Promise((r) => setTimeout(r, 0));

/** Run async tasks with limited concurrency, preserving result order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

/** fetch with timeout and retry on 429/5xx/network errors. */
export async function fetchRetry(url, { tries = 3, timeoutMs = 15000, as = 'json', fetchImpl } = {}) {
  const f = fetchImpl || globalThis.fetch;
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await f(url, ctrl ? { signal: ctrl.signal } : undefined);
      if (timer) clearTimeout(timer);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        lastErr.status = res.status;
        if (attempt < tries - 1) await sleep(800 * 2 ** attempt + Math.random() * 300);
        continue;
      }
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
        const err = new Error(`HTTP ${res.status} for ${url} ${detail}`);
        err.status = res.status;
        err.body = detail;
        throw err;
      }
      if (as === 'json') return await res.json();
      if (as === 'arrayBuffer') return await res.arrayBuffer();
      if (as === 'blob') return await res.blob();
      return await res.text();
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (e && e.status && e.status < 500 && e.status !== 429) throw e;
      lastErr = e;
      if (attempt < tries - 1) await sleep(600 * 2 ** attempt);
    }
  }
  throw lastErr;
}
