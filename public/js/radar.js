// Radar data: RainViewer global composite (past 2 h, 10-minute frames).
// We fetch raw (unsmoothed) tiles, decode every pixel back to reflectivity (dBZ) using RainViewer's
// published "Universal Blue" colour table, and assemble a regional grid around the pin.

import { decodeImage } from './png.js';
import {
  lonToTileX, latToTileY, tileXToLon, tileYToLat, mercatorPixelKm, dbzToRate, mapLimit, fetchRetry,
} from './util.js';

export const RV_INDEX_URL = 'https://api.rainviewer.com/public/weather-maps.json';
export const RV_ZOOM = 6; // free tier max is 7; z6 @ 512 px == z7 @ 256 px resolution (~1.2 km)
export const RV_TILE = 512;
export const RV_COLOR = 2; // Universal Blue (only scheme left on the free tier)

// RainViewer Universal Blue, rain column (https://www.rainviewer.com/api/color-schemes.html).
// [dBZ, RGBA hex]. Entries below -10 dBZ are fully transparent.
const UNIVERSAL_BLUE = [
  [-10, '63615914'], [-9, '66635a19'], [-8, '69665c1e'], [-7, '6c685d24'], [-6, '6f6b5f29'],
  [-5, '726e612e'], [-4, '75706234'], [-3, '78736439'], [-2, '7c75653e'], [-1, '7f786744'],
  [0, '827b6949'], [1, '857d6a4e'], [2, '88806c54'], [3, '8b826d59'], [4, '8e856f5e'],
  [5, '92887164'], [6, '9e93756e'], [7, 'aa9e7978'], [8, 'b6a97e82'], [9, 'c2b4828c'],
  [10, 'cec08796'], [11, 'd2c48ba0'], [12, 'd6c88faa'], [13, 'dacc93b4'], [14, 'ded097be'],
  [15, '88ddeeff'], [16, '6cd1ebff'], [17, '51c5e8ff'], [18, '36bae5ff'], [19, '1baee2ff'],
  [20, '00a3e0ff'], [21, '009ad5ff'], [22, '0091caff'], [23, '0088bfff'], [24, '007fb4ff'],
  [25, '0077aaff'], [26, '0070a3ff'], [27, '00699cff'], [28, '006295ff'], [29, '005b8eff'],
  [30, '005588ff'], [31, '005180ff'], [32, '004e78ff'], [33, '004a70ff'], [34, '004768ff'],
  [35, 'ffee00ff'], [36, 'ffe000ff'], [37, 'ffd200ff'], [38, 'ffc500ff'], [39, 'ffb700ff'],
  [40, 'ffaa00ff'], [41, 'ff9f00ff'], [42, 'ff9500ff'], [43, 'ff8b00ff'], [44, 'ff8100ff'],
  [45, 'ff4400ff'], [46, 'f23600ff'], [47, 'e62800ff'], [48, 'd91b00ff'], [49, 'cd0d00ff'],
  [50, 'c10000ff'], [51, 'a80000ff'], [52, '8f0000ff'], [53, '760000ff'], [54, '5d0000ff'],
  [55, 'ffaaffff'], [56, 'ff9fffff'], [57, 'ff95ffff'], [58, 'ff8bffff'], [59, 'ff81ffff'],
  [60, 'ff77ffff'], [61, 'ff6cffff'], [62, 'ff62ffff'], [63, 'ff58ffff'], [64, 'ff4effff'],
  [66, 'ffffffff'], // 65–74 dBZ share white
  [70, '00ff00ff'], // ≥75 dBZ share green; treated as capped extreme echo
];
export const PALETTE_TABLE = UNIVERSAL_BLUE;

// Grid codes: 0 = no echo, otherwise dBZ + CODE_OFFSET (so -10..70 dBZ -> 30..110).
export const CODE_OFFSET = 40;

const alphaLUT = new Int16Array(256).fill(-999);
const opaqueMap = new Map();
const opaqueList = [];
(function buildLUT() {
  const semi = [];
  for (const [dbz, hex] of UNIVERSAL_BLUE) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = parseInt(hex.slice(6, 8), 16);
    if (a === 255) {
      opaqueMap.set((r << 16) | (g << 8) | b, dbz);
      opaqueList.push([r, g, b, dbz]);
    } else {
      semi.push([a, dbz]);
    }
  }
  // nearest semi-transparent alpha for every alpha value
  for (let a = 1; a < 255; a++) {
    let best = semi[0];
    for (const s of semi) if (Math.abs(s[0] - a) < Math.abs(best[0] - a)) best = s;
    alphaLUT[a] = best[1];
  }
})();

const nearestCache = new Map();
function nearestOpaque(r, g, b) {
  const key = (r << 16) | (g << 8) | b;
  const hit = nearestCache.get(key);
  if (hit !== undefined) return hit;
  let best = null;
  let bestD = Infinity;
  for (const [pr, pg, pb, dbz] of opaqueList) {
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (d < bestD) { bestD = d; best = dbz; }
  }
  const val = bestD <= 40 * 40 ? best : -999; // colour not in the table: unknown
  nearestCache.set(key, val);
  return val;
}

/** RGBA pixel -> dBZ (NaN = no echo). Exported for tests. */
export function rgbaToDbz(r, g, b, a) {
  if (a === 0) return NaN;
  if (a < 255) {
    const d = alphaLUT[a];
    return d === -999 ? NaN : d;
  }
  const exact = opaqueMap.get((r << 16) | (g << 8) | b);
  if (exact !== undefined) return exact;
  const n = nearestOpaque(r, g, b);
  return n === -999 ? NaN : n;
}

/** Encode dBZ to the Universal Blue RGBA (used by tests and the synthetic demo). */
export function dbzToRGBA(dbz) {
  if (!(dbz >= -10)) return [0, 0, 0, 0];
  let best = UNIVERSAL_BLUE[0];
  for (const e of UNIVERSAL_BLUE) if (e[0] <= Math.round(dbz)) best = e;
  const hex = best[1];
  return [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

// ---------- Relay (same idea as for the models: RainViewer limits each IP to 100 requests a minute,
// which shared mobile/campus IPs can exhaust; this site's /api/rv relays and caches at the CDN) ----------
let RELAY_BASE = null;
export function setRadarRelay(origin) { RELAY_BASE = origin || null; }
const relayUntil = new Map(); // host -> time until which requests go straight to the relay
function relayFor(url) {
  const u = new URL(url);
  const path = u.hostname === 'api.rainviewer.com' ? 'index' : u.pathname.replace(/^\//, '');
  return `${RELAY_BASE}/api/rv?p=${encodeURIComponent(path)}`;
}
async function getWithRelay(url, opts) {
  const host = new URL(url).hostname;
  if (RELAY_BASE && (relayUntil.get(host) || 0) > Date.now()) return fetchRetry(relayFor(url), { ...opts, tries: 2 });
  try {
    return await fetchRetry(url, RELAY_BASE ? { ...opts, tries: 1 } : opts);
  } catch (e) {
    const retryable = !e || !e.status || e.status === 429 || e.status >= 500;
    if (!RELAY_BASE || !retryable) throw e;
    relayUntil.set(host, Date.now() + 10 * 60 * 1000); // stop hammering a host that refused us
    return fetchRetry(relayFor(url), { ...opts, tries: 2 });
  }
}

// ---------- Index ----------
export async function fetchRadarIndex(fetchImpl) {
  const j = await getWithRelay(RV_INDEX_URL, { fetchImpl, timeoutMs: 12000 });
  const frames = (j.radar && j.radar.past) || [];
  return {
    host: j.host || 'https://tilecache.rainviewer.com',
    generated: j.generated,
    frames: frames.map((f) => ({ time: f.time, path: f.path })).sort((a, b) => a.time - b.time),
  };
}

// ---------- Geometry of the regional block ----------
/** 2x2 block of z6 512-px tiles positioned so the pin is in the central half of the block. */
export function chooseBlock(lat, lon, z = RV_ZOOM, size = RV_TILE, n = 2) {
  const fx = lonToTileX(lon, z);
  const fy = latToTileY(lat, z);
  const maxT = 2 ** z;
  // Left/top tile chosen so the pin sits between 0.5 and 1.5 tiles from the block edge,
  // i.e. at least ~300 km (equator) / ~200 km (50° lat) of upstream radar in every direction.
  const xs = Math.floor(fx - 0.5);
  let ys = Math.floor(fy - 0.5);
  ys = Math.max(0, Math.min(maxT - n, ys));
  const W = n * size;
  const H = n * size;
  const block = { z, size, n, x0: xs, y0: ys, W, H };
  block.pinX = (fx - xs) * size;
  block.pinY = (fy - ys) * size;
  block.north = tileYToLat(ys, z);
  block.south = tileYToLat(ys + n, z);
  block.west = tileXToLon(xs, z);
  block.east = tileXToLon(xs + n, z);
  block.kmPerPx = mercatorPixelKm(lat, z, size);
  block.key = `${z}/${xs}/${ys}/${n}`;
  return block;
}

/** Grid pixel (at resolution factor f: 1 = native, 2 = half) -> lat/lon. */
export function gridToLatLon(block, px, py, f = 1) {
  const gx = block.x0 + (px * f) / block.size;
  const gy = block.y0 + (py * f) / block.size;
  let lon = tileXToLon(gx, block.z);
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lat: tileYToLat(gy, block.z), lon };
}
export function latLonToGrid(block, lat, lon, f = 1) {
  let fx = lonToTileX(lon, block.z);
  const maxT = 2 ** block.z;
  // keep continuity across the antimeridian
  if (fx - block.x0 < -maxT / 2) fx += maxT;
  if (fx - block.x0 > maxT / 2) fx -= maxT;
  return {
    x: ((fx - block.x0) * block.size) / f,
    y: ((latToTileY(lat, block.z) - block.y0) * block.size) / f,
  };
}

function tileUrls(block, base, suffix) {
  const urls = [];
  const maxT = 2 ** block.z;
  for (let j = 0; j < block.n; j++) {
    for (let i = 0; i < block.n; i++) {
      const x = (((block.x0 + i) % maxT) + maxT) % maxT;
      const y = block.y0 + j;
      urls.push({ i, j, url: `${base}/${block.size}/${block.z}/${x}/${y}/${suffix}` });
    }
  }
  return urls;
}

// Cache of decoded tiles as compact per-pixel codes (256 KB per 512-px tile, not 1 MB of RGBA).
const tileCache = new Map(); // url -> Promise<Uint8Array>
function cached(url, convert, fetchImpl) {
  if (tileCache.has(url)) {
    const p = tileCache.get(url);
    tileCache.delete(url); // LRU: move to the end
    tileCache.set(url, p);
    return p;
  }
  const p = getWithRelay(url, { as: 'arrayBuffer', fetchImpl, tries: 3, timeoutMs: 20000 })
    .then(decodeImage)
    .then(convert);
  p.catch(() => tileCache.delete(url));
  tileCache.set(url, p);
  while (tileCache.size > 64) tileCache.delete(tileCache.keys().next().value);
  return p;
}

function radarCodes(img, size) {
  if (img.width !== size || img.height !== size) throw new Error('Unexpected tile size');
  const d = img.data;
  const codes = new Uint8Array(size * size);
  let unknown = 0;
  for (let i = 0, o = 0; i < codes.length; i++, o += 4) {
    if (d[o + 3] === 0) continue;
    const dbz = rgbaToDbz(d[o], d[o + 1], d[o + 2], d[o + 3]);
    if (Number.isNaN(dbz)) { unknown++; continue; }
    codes[i] = Math.max(1, Math.min(255, Math.round(dbz) + CODE_OFFSET));
  }
  codes.unknown = unknown;
  return codes;
}
function coverageCodes(img, size) {
  if (img.width !== size || img.height !== size) throw new Error('Unexpected tile size');
  const d = img.data;
  const cov = new Uint8Array(size * size);
  for (let i = 0, o = 0; i < cov.length; i++, o += 4) {
    const dark = d[o] + d[o + 1] + d[o + 2] < 120;
    cov[i] = d[o + 3] > 127 && dark ? 0 : 1;
  }
  return cov;
}

function assemble(block, urls, tiles) {
  const { W, size } = block;
  const grid = new Uint8Array(W * block.H);
  urls.forEach((u, k) => {
    const t = tiles[k];
    for (let y = 0; y < size; y++) grid.set(t.subarray(y * size, (y + 1) * size), (u.j * size + y) * W + u.i * size);
  });
  return grid;
}

/** Fetch one radar frame for the block -> Uint8Array of codes (W*H). */
export async function fetchFrameGrid(host, frame, block, fetchImpl) {
  const urls = tileUrls(block, host + frame.path, `${RV_COLOR}/0_0.png`);
  const tiles = await mapLimit(urls, 4, (u) => cached(u.url, (img) => radarCodes(img, block.size), fetchImpl));
  return { grid: assemble(block, urls, tiles), unknown: tiles.reduce((a, t) => a + (t.unknown || 0), 0) };
}

/** Coverage mask (1 = inside radar coverage). Black opaque pixels mean "no radar here". */
export async function fetchCoverageGrid(host, block, fetchImpl) {
  const urls = tileUrls(block, `${host}/v2/coverage/0`, '0/0_0.png');
  const tiles = await mapLimit(urls, 4, (u) => cached(u.url, (img) => coverageCodes(img, block.size), fetchImpl));
  return assemble(block, urls, tiles);
}

/**
 * Load the last `count` frames for the block. Frames whose tiles fail are skipped.
 * Returns { frames: [{time, codes}], coverage, block, diagnostics }
 */
export async function loadRadar(lat, lon, { count = 7, fetchImpl, onProgress } = {}) {
  const index = await fetchRadarIndex(fetchImpl);
  if (!index.frames.length) throw new Error('Radar index has no frames');
  const block = chooseBlock(lat, lon);
  const chosen = index.frames.slice(-count);
  let done = 0;
  const total = chosen.length + 1;
  const covP = fetchCoverageGrid(index.host, block, fetchImpl)
    .catch(() => null)
    .finally(() => onProgress && onProgress(++done / total));
  const results = await mapLimit(chosen, 2, async (f) => {
    try {
      const r = await fetchFrameGrid(index.host, f, block, fetchImpl);
      return { time: f.time, codes: r.grid, unknown: r.unknown };
    } catch (e) {
      return { time: f.time, error: String(e && e.message ? e.message : e) };
    } finally {
      if (onProgress) onProgress(++done / total);
    }
  });
  const coverage = await covP;
  const frames = results.filter((r) => r.codes);
  const failed = results.filter((r) => !r.codes);
  return {
    index,
    block,
    frames,
    coverage,
    diagnostics: {
      requested: chosen.length,
      loaded: frames.length,
      failed: failed.map((f) => f.error),
      unknownPixels: frames.reduce((s, f) => s + f.unknown, 0),
      coverageKnown: !!coverage,
    },
  };
}

// ---------- Field preparation ----------
export const codeToDbz = (c) => (c ? c - CODE_OFFSET : NaN);

/**
 * Remove likely non-weather echoes: pixels that echo in every frame with almost no change
 * (ground clutter, sea clutter, interference spokes are typically static).
 */
export function clutterMask(frames) {
  const n = frames.length;
  const N = frames[0].codes.length;
  const mask = new Uint8Array(N);
  if (n < 5) return mask;
  for (let i = 0; i < N; i++) {
    let lo = 255, hi = 0, present = 0;
    for (let k = 0; k < n; k++) {
      const c = frames[k].codes[i];
      if (c) { present++; if (c < lo) lo = c; if (c > hi) hi = c; }
    }
    if (present === n && hi - lo <= 2) mask[i] = 1;
  }
  return mask;
}

/**
 * Downsample native codes (W x H) by `f` into rain rate (mm/h) and dBZ-like intensity.
 * Coverage is downsampled too (cell covered if ≥ half its pixels are covered).
 */
export function downsample(codes, W, H, f, coverage, clutter) {
  const w = W / f;
  const h = H / f;
  const rate = new Float32Array(w * h);
  const cov = new Uint8Array(w * h);
  const inv = 1 / (f * f);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      let c = 0;
      for (let dy = 0; dy < f; dy++) {
        const row = (y * f + dy) * W + x * f;
        for (let dx = 0; dx < f; dx++) {
          const i = row + dx;
          if (!coverage || coverage[i]) c++;
          const code = codes[i];
          if (code && !(clutter && clutter[i])) s += dbzToRate(code - CODE_OFFSET);
        }
      }
      rate[y * w + x] = s * inv;
      cov[y * w + x] = c * inv >= 0.5 ? 1 : 0;
    }
  }
  return { rate, cov, w, h };
}

/** Are two frames identical (stale data) in a window around (cx, cy)? */
export function framesIdentical(a, b, W, cx, cy, half) {
  let diff = 0;
  let echoes = 0;
  const x0 = Math.max(0, Math.floor(cx - half));
  const x1 = Math.min(W - 1, Math.floor(cx + half));
  const y0 = Math.max(0, Math.floor(cy - half));
  const y1 = Math.min(a.length / W - 1, Math.floor(cy + half));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * W + x;
      if (a[i] || b[i]) echoes++;
      if (a[i] !== b[i]) diff++;
    }
  }
  return { identical: echoes > 50 && diff === 0, echoes, diff };
}

export function clearTileCache() { tileCache.clear(); }
