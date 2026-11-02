// Satellite view of developing storms: Meteosat-9 (Indian Ocean coverage) infrared, 10.8 µm, every
// 15 minutes, through this site's relay (api/sat.js).
//
// A thunderstorm shows up on satellite before it rains: its cloud top climbs and cools fast. This
// compares the last three images (now, -15, -30 min) within 50 km of the location and reports how
// quickly cloud tops are cooling, how cold they are, and where the strongest growth is.

import { decodeImage } from './png.js';

const SIZE = 48; // image pixels per side (~3.5 km each)
const HALF = 0.75; // degrees: the box is 1.5° wide, centred on a 0.25° grid point (shared CDN cache)
const RADIUS_KM = 50;

/**
 * Grey level -> brightness temperature (K). EUMETView draws IR10.8 as an inverted grey scale. The
 * scale was checked against clear sea at night (grey 15 ≈ 297 K) and the usual ~200 K white point:
 * absolute values are good to about ±5 K, changes between images are much more precise.
 */
export const greyToK = (g) => 302 - 0.39 * g;

function snap(lat, lon) {
  const cLat = Math.round(lat * 4) / 4, cLon = Math.round(lon * 4) / 4;
  return [cLat - HALF, cLon - HALF, cLat + HALF, cLon + HALF];
}
const iso = (t) => new Date(t * 1000).toISOString().replace('.000Z', 'Z');

async function image(f, base, t, b) {
  const r = await f(`${base}/api/sat?p=map&t=${iso(t)}&b=${b.join(',')}&s=${SIZE}`);
  if (!r.ok) throw new Error(`satellite image ${r.status}`);
  const img = await decodeImage(await r.arrayBuffer());
  if (img.width !== SIZE || img.height !== SIZE) throw new Error('unexpected satellite image size');
  const k = new Float32Array(SIZE * SIZE);
  for (let i = 0; i < k.length; i++) k[i] = img.data[i * 4 + 3] < 128 ? NaN : greyToK(img.data[i * 4]);
  return k;
}

/** Coldest value in the 3x3 neighbourhood: follows a growing tower even if it drifts a pixel. */
function localMin(a) {
  const out = new Float32Array(a.length).fill(NaN);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let m = Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= SIZE) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= SIZE) continue;
          const v = a[yy * SIZE + xx];
          if (v < m) m = v;
        }
      }
      if (m < Infinity) out[y * SIZE + x] = m;
    }
  }
  return out;
}

/** Pure analysis of three images (now, -15, -30 min) of the box b around (lat, lon). */
export function analyse(k0, k15, k30, b, lat, lon) {
  const [lat0, lon0, lat1, lon1] = b;
  const m0 = localMin(k0), m15 = localMin(k15), m30 = localMin(k30);
  const coslat = Math.cos((lat * Math.PI) / 180);
  let n = 0, cloudy = 0, cold = 0, dev = 0, rapid = 0, warmSum = 0, warmN = 0;
  let coldest = Infinity, overhead = NaN, bestD = Infinity;
  const growing = []; // { c15, d, dx, dy } of pixels where cloud tops are climbing
  for (let y = 0; y < SIZE; y++) {
    const plat = lat1 - ((y + 0.5) * (lat1 - lat0)) / SIZE;
    for (let x = 0; x < SIZE; x++) {
      const plon = lon0 + ((x + 0.5) * (lon1 - lon0)) / SIZE;
      const dx = (plon - lon) * 111.32 * coslat, dy = (plat - lat) * 110.57;
      const d = Math.hypot(dx, dy);
      if (d > RADIUS_KM) continue;
      const i = y * SIZE + x;
      const t = k0[i];
      if (!Number.isFinite(t)) continue;
      n++;
      if (d < bestD) { bestD = d; overhead = t; }
      if (t <= 273) cloudy++;
      if (t <= 233) cold++;
      if (t < coldest) coldest = t;
      const c15 = m0[i] - m15[i]; // K per 15 min, negative = cooling (growing cloud)
      const c30 = (m0[i] - m30[i]) / 2;
      if (m0[i] <= 268 && Number.isFinite(c15)) {
        const isDev = c15 <= -4 && (c30 <= -3 || c15 <= -6);
        if (isDev) {
          dev++;
          if (c15 <= -8 || (c15 <= -6 && m0[i] <= 243)) rapid++;
          growing.push({ c15, d, dx, dy });
        }
      }
      if (m15[i] <= 243 && Number.isFinite(c15)) { warmSum += c15; warmN++; }
    }
  }
  if (!n) return { ok: false, reason: 'no satellite data here' };
  // where: the cooling-weighted centre of the strongest growth (within 2 K/15 min of the strongest)
  let best = null;
  if (growing.length) {
    const top = Math.min(...growing.map((p) => p.c15));
    let sx = 0, sy = 0, sw = 0;
    for (const p of growing) {
      if (p.c15 > top + 2) continue;
      const wgt = -p.c15;
      sx += p.dx * wgt; sy += p.dy * wgt; sw += wgt;
    }
    const cx = sx / sw, cy = sy / sw;
    best = {
      c15: top, d: Math.hypot(cx, cy), bearing: ((Math.atan2(cx, cy) * 180) / Math.PI + 360) % 360,
      nearest: Math.min(...growing.map((p) => p.d)),
    };
  }
  let trend;
  if (rapid >= 2) trend = 'rapid';
  else if (dev >= 3) trend = 'developing';
  else if (!cloudy) trend = 'clear';
  else if (warmN >= 4 && warmSum / warmN >= 4) trend = 'decaying';
  else trend = 'steady';
  return {
    ok: true,
    trend,
    coldestC: Math.round(coldest - 273.15),
    overheadC: Number.isFinite(overhead) ? Math.round(overhead - 273.15) : null,
    coldShare: cold / n,
    cloudShare: cloudy / n,
    coolingK15: best ? Math.round(best.c15 * 10) / 10 : 0,
    where: best ? { distKm: Math.round(best.d), bearing: best.bearing, nearestKm: Math.round(best.nearest) } : null,
    growingKm2: Math.round(dev * ((lat1 - lat0) / SIZE) * 110.57 * ((lon1 - lon0) / SIZE) * 111.32 * coslat),
  };
}

/** Fetch the latest three images around (lat, lon) and analyse them. Never throws. */
export async function fetchSatellite(lat, lon, { base, fetchImpl, nowSec }) {
  const f = fetchImpl || globalThis.fetch;
  try {
    const r = await f(`${base}/api/sat?p=latest`);
    if (!r.ok) throw new Error(`satellite index ${r.status}`);
    const latest = Date.parse((await r.json()).latest) / 1000;
    if (!Number.isFinite(latest)) throw new Error('no satellite time');
    const now = nowSec || Date.now() / 1000;
    const ageMin = Math.round((now - latest) / 60);
    if (ageMin > 120) return { ok: false, reason: 'satellite images are out of date', ageMin };
    const b = snap(lat, lon);
    const [k0, k15, k30] = await Promise.all([latest, latest - 900, latest - 1800].map((t) => image(f, base, t, b)));
    return { ...analyse(k0, k15, k30, b, lat, lon), time: latest, ageMin };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}
