// Weather-model ensemble from Open-Meteo: up to ~12 deterministic models (each automatically using
// its highest-resolution regional version where one exists), sampled at the pin and at 8 points on a
// 25 km ring (neighbourhood ensemble), plus four global ensemble systems (~140 members).

import { fetchRetry, destinationPoint, clamp, weightedQuantile } from './util.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const ENSEMBLE_URL = 'https://ensemble-api.open-meteo.com/v1/ensemble';

const inBox = (lat, lon, [la0, la1, lo0, lo1]) => lat >= la0 && lat <= la1 && lon >= lo0 && lon <= lo1;
const BOX = {
  conus: [24, 50, -125, -66],
  europe: [30, 70, -23, 45],
  centralEurope: [43, 58, -4, 20],
  uk: [49, 61, -11, 2],
  france: [38, 55, -8, 16],
  canada: [42, 70, -141, -52],
  japan: [24, 46, 122, 148],
  korea: [33, 43, 123, 131],
};

/** Deterministic models. `hires(lat,lon)` tells whether a convection-permitting version is used there. */
export const MODELS = [
  { id: 'ecmwf_ifs', label: 'ECMWF IFS 9 km', short: 'ECMWF', prior: 1.0, hires: () => false },
  { id: 'ukmo_seamless', label: 'UK Met Office', short: 'UKMO', prior: 0.85, hires: (a, o) => inBox(a, o, BOX.uk) },
  { id: 'icon_seamless', label: 'DWD ICON', short: 'ICON', prior: 0.8, hires: (a, o) => inBox(a, o, BOX.centralEurope) },
  { id: 'gfs_seamless', label: 'NOAA GFS / HRRR', short: 'GFS', prior: 0.7, hires: (a, o) => inBox(a, o, BOX.conus) },
  { id: 'meteofrance_seamless', label: 'Météo-France', short: 'MF', prior: 0.6, hires: (a, o) => inBox(a, o, BOX.france) },
  { id: 'gem_seamless', label: 'Canada GEM', short: 'GEM', prior: 0.6, hires: (a, o) => inBox(a, o, BOX.canada) },
  { id: 'jma_seamless', label: 'JMA', short: 'JMA', prior: 0.55, hires: (a, o) => inBox(a, o, BOX.japan) },
  { id: 'cma_grapes_global', label: 'CMA GRAPES', short: 'CMA', prior: 0.4, hires: () => false },
];
export const REGIONAL = [
  { id: 'ncep_nbm_conus', label: 'NOAA National Blend', short: 'NBM', prior: 0.95, box: [25, 49.5, -124, -67] },
  { id: 'knmi_seamless', label: 'KNMI HARMONIE', short: 'KNMI', prior: 0.85, box: [49.5, 55.5, 2, 8] },
  { id: 'dmi_seamless', label: 'DMI HARMONIE', short: 'DMI', prior: 0.85, box: [54, 66, 3, 17] },
  { id: 'metno_seamless', label: 'MET Norway', short: 'METNO', prior: 0.85, box: [55, 71, 4, 31] },
  { id: 'meteoswiss_icon_seamless', label: 'MeteoSwiss ICON', short: 'MCH', prior: 0.9, box: [44, 49, 4, 13] },
  { id: 'geosphere_seamless', label: 'GeoSphere AROME', short: 'GSA', prior: 0.85, box: [45, 50, 9, 18] },
  { id: 'italia_meteo_arpae_icon_2i', label: 'ItaliaMeteo ICON-2I', short: 'IT', prior: 0.85, box: [37, 47, 7, 18] },
  { id: 'chmi_aladin_seamless', label: 'CHMI ALADIN', short: 'CHMI', prior: 0.8, box: [47, 52, 12, 19] },
];
export const ENSEMBLES = [
  { id: 'icon_seamless', label: 'ICON-EPS', weight: 1.0 },
  { id: 'ecmwf_ifs025', label: 'ECMWF ENS', weight: 1.0 },
  { id: 'ukmo_global_ensemble_20km', label: 'MOGREPS-G', weight: 0.9 },
  { id: 'gfs_seamless', label: 'GEFS', weight: 0.7 },
];
const CORE_FALLBACK = ['ecmwf_ifs', 'icon_seamless', 'gfs_seamless', 'gem_seamless'];
const RING_MODELS = ['ecmwf_ifs', 'icon_seamless', 'gfs_seamless', 'ukmo_seamless'];

export function modelsFor(lat, lon) {
  const list = MODELS.map((m) => {
    const hires = m.hires(lat, lon);
    return { ...m, hires, prior: hires ? Math.max(m.prior, 0.9) : m.prior };
  });
  for (const r of REGIONAL) if (inBox(lat, lon, r.box)) list.push({ ...r, hires: true });
  return list;
}

const HOURLY_VARS = [
  'precipitation', 'snowfall', 'temperature_2m', 'apparent_temperature', 'relative_humidity_2m',
  'cloud_cover', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'weather_code', 'cape',
  'wind_speed_700hPa', 'wind_direction_700hPa',
];

function qs(params) {
  return Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&').replace(/%2C/g, ',');
}

/** Find the series for (variable, model) in an Open-Meteo section, tolerant to key ordering. */
export function seriesFor(section, varName, model, nModels) {
  if (!section) return null;
  if (nModels === 1 && Array.isArray(section[varName])) return section[varName];
  const exact = section[`${varName}_${model}`];
  if (Array.isArray(exact)) return exact;
  return null;
}
/**
 * Group ensemble member series by the model suffix in the key, e.g.
 * precipitation_member07_icon_seamless_eps -> "icon_seamless_eps". Open-Meteo renames some models in
 * the response (gfs_seamless -> ncep_gefs_seamless), so we group by what is there, not what we asked.
 */
export function groupEnsembleMembers(section, varName) {
  const groups = new Map();
  for (const [k, v] of Object.entries(section || {})) {
    if (k === 'time' || !Array.isArray(v) || !k.startsWith(varName)) continue;
    let rest = k.slice(varName.length);
    if (rest && rest[0] !== '_') continue;
    rest = rest.replace(/^_member\d+/, '').replace(/_member\d+$/, '').replace(/^_/, '');
    if (/probability/.test(rest)) continue;
    const key = rest || 'default';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  return groups;
}
function ensembleMeta(key, fallbackId) {
  const k = key === 'default' ? fallbackId || '' : key;
  if (/icon/.test(k)) return { id: k, label: 'ICON-EPS', weight: 1.0 };
  if (/ecmwf|ifs/.test(k)) return { id: k, label: 'ECMWF ENS', weight: 1.0 };
  if (/ukmo|mogreps/.test(k)) return { id: k, label: 'MOGREPS-G', weight: 0.9 };
  if (/gefs|gfs|ncep/.test(k)) return { id: k, label: 'GEFS', weight: 0.7 };
  if (/gem|cmc/.test(k)) return { id: k, label: 'GEPS', weight: 0.7 };
  return { id: k, label: k, weight: 0.6 };
}

// ---------- requests ----------
// The free Open-Meteo API limits each IP address (10,000 weighted calls a day). Indian mobile and
// campus networks share one public IP among thousands of people, so the limit can be used up by
// others. Requests therefore go direct first and, on a limit or network error, through this site's
// own caching relay (/api/om), whose answers are cached at the CDN and shared between users.
let RELAY_BASE = null;
export function setRelayBase(origin) { RELAY_BASE = origin || null; }

function relayUrl(url) {
  const u = new URL(url);
  const kind = u.hostname.startsWith('ensemble-api') ? 'ensemble' : u.hostname.startsWith('geocoding-api') ? 'geocode' : 'forecast';
  return `${RELAY_BASE}/api/om?u=${kind}&${u.searchParams.toString()}`;
}

const relayUntil = new Map(); // host -> time until which requests go straight to the relay
function limitError(e, e2) {
  const err = new Error(e && e.status === 429
    ? 'The free weather-model service has reached its usage limit for this network'
    : `Weather-model service unreachable (${(e && e.message) || e})`);
  err.status = (e && e.status) || (e2 && e2.status);
  return err;
}
async function getJSON(url, fetchImpl) {
  const host = new URL(url).hostname;
  if (RELAY_BASE && (relayUntil.get(host) || 0) > Date.now()) {
    try {
      return await fetchRetry(relayUrl(url), { fetchImpl, tries: 2, timeoutMs: 30000 });
    } catch (e2) {
      if (e2 && e2.status === 400) throw e2;
      throw limitError({ status: 429, message: 'relay' }, e2);
    }
  }
  try {
    return await fetchRetry(url, { fetchImpl, tries: RELAY_BASE ? 1 : 2, timeoutMs: 25000 });
  } catch (e) {
    const retryable = !e || !e.status || e.status === 429 || e.status >= 500;
    if (!RELAY_BASE || !retryable || (e && e.status === 400)) throw e;
    relayUntil.set(host, Date.now() + 10 * 60 * 1000);
    try {
      return await fetchRetry(relayUrl(url), { fetchImpl, tries: 2, timeoutMs: 30000 });
    } catch (e2) {
      if (e2 && e2.status === 400) throw e2;
      throw limitError(e, e2);
    }
  }
}

const coord = (v) => v.toFixed(2); // ~1 km: lets cached answers be reused for nearby pins

/** Deterministic models at the pin (all variables). On a 400 (an unknown model or variable), retries
 *  with a core model set and then with fewer variables, so one bad parameter never kills the run. */
export async function fetchDeterministic(lat, lon, models, fetchImpl) {
  // no snowfall south of 25°N (keeps the request light); 15-minute data only where a model produces it
  const vars = HOURLY_VARS.filter((v) => v !== 'snowfall' || Math.abs(lat) >= 25);
  const anyHires = models.some((m) => m.hires);
  const base = {
    latitude: coord(lat), longitude: coord(lon),
    hourly: vars.join(','),
    past_hours: 3, forecast_hours: 8,
    timeformat: 'unixtime', timezone: 'auto', wind_speed_unit: 'kmh',
  };
  if (anyHires) Object.assign(base, { minutely_15: 'precipitation', past_minutely_15: 12, forecast_minutely_15: 32 });
  const all = models.map((m) => m.id);
  const core = all.filter((id) => CORE_FALLBACK.includes(id));
  const noQuarter = { ...base };
  delete noQuarter.minutely_15; delete noQuarter.past_minutely_15; delete noQuarter.forecast_minutely_15;
  const basic = { ...noQuarter, hourly: vars.filter((v) => !v.includes('hPa')).join(',') };
  const attempts = [[base, all], [base, core], [noQuarter, core], [basic, core]];
  let lastErr;
  for (let k = 0; k < attempts.length; k++) {
    const [params, ids] = attempts[k];
    try {
      const j = await getJSON(`${FORECAST_URL}?${qs({ ...params, models: ids.join(',') })}`, fetchImpl);
      return { json: j, ids, degraded: k > 0 };
    } catch (e) {
      lastErr = e;
      if (!(e && e.status === 400)) throw e;
    }
  }
  throw lastErr;
}

/** Precipitation at 4 points on a ring around the pin (spatial neighbourhood) for the best models. */
export async function fetchRing(lat, lon, ids, fetchImpl, radiusKm = 25) {
  const pts = [0, 90, 180, 270].map((b) => destinationPoint(lat, lon, b, radiusKm));
  const ringIds = RING_MODELS.filter((id) => ids.includes(id));
  const params = {
    latitude: pts.map((p) => coord(p.lat)).join(','),
    longitude: pts.map((p) => coord(p.lon)).join(','),
    hourly: 'precipitation', models: (ringIds.length ? ringIds : ids.slice(0, 4)).join(','),
    past_hours: 3, forecast_hours: 8, timeformat: 'unixtime', timezone: 'auto',
  };
  const j = await getJSON(`${FORECAST_URL}?${qs(params)}`, fetchImpl);
  return { json: Array.isArray(j) ? j : [j], points: pts };
}

export async function fetchEnsemble(lat, lon, fetchImpl) {
  const base = {
    latitude: coord(lat), longitude: coord(lon), hourly: 'precipitation',
    past_hours: 3, forecast_hours: 8, timeformat: 'unixtime', timezone: 'auto',
  };
  let ids = ENSEMBLES.map((e) => e.id);
  try {
    const j = await getJSON(`${ENSEMBLE_URL}?${qs({ ...base, models: ids.join(',') })}`, fetchImpl);
    return { json: j, ids };
  } catch (e) {
    if (e && e.status === 400) {
      ids = ['icon_seamless', 'gfs_seamless'];
      const j = await getJSON(`${ENSEMBLE_URL}?${qs({ ...base, models: ids.join(',') })}`, fetchImpl);
      return { json: j, ids, degraded: true };
    }
    throw e;
  }
}

// ---------- Time interpolation ----------
/** Accumulations (value at T covers [T-step, T]) -> rate (mm/h) at time t, interpolated between interval centres. */
function rateAt(times, vals, stepSec, t) {
  const n = times.length;
  if (!vals || !n) return NaN;
  const half = stepSec / 2;
  const toRate = 3600 / stepSec;
  // centres c_i = times[i] - half
  if (t <= times[0] - half) return vals[0] == null ? NaN : vals[0] * toRate;
  for (let i = 0; i < n - 1; i++) {
    const c0 = times[i] - half;
    const c1 = times[i + 1] - half;
    if (t >= c0 && t <= c1) {
      const v0 = vals[i], v1 = vals[i + 1];
      if (v0 == null && v1 == null) return NaN;
      if (v0 == null) return v1 * toRate;
      if (v1 == null) return v0 * toRate;
      const f = (t - c0) / (c1 - c0);
      return (v0 + (v1 - v0) * f) * toRate;
    }
  }
  const last = vals[n - 1];
  return t <= times[n - 1] + half && last != null ? last * toRate : NaN;
}
/** Instantaneous variable at time t (linear). */
function valueAt(times, vals, t) {
  if (!vals || !times.length) return NaN;
  if (t <= times[0]) return vals[0] ?? NaN;
  for (let i = 0; i < times.length - 1; i++) {
    if (t >= times[i] && t <= times[i + 1]) {
      const v0 = vals[i], v1 = vals[i + 1];
      if (v0 == null || v1 == null) return v0 ?? v1 ?? NaN;
      return v0 + ((v1 - v0) * (t - times[i])) / (times[i + 1] - times[i]);
    }
  }
  return t - times[times.length - 1] <= 3600 ? vals[vals.length - 1] ?? NaN : NaN;
}
function dirAt(times, spd, dir, t) {
  // interpolate wind as a vector
  if (!dir || !spd) return NaN;
  let k = times.findIndex((x) => x >= t);
  if (k < 0) k = times.length - 1;
  const i0 = Math.max(0, k - 1);
  const pick = (i) => {
    const s = spd[i] ?? 1, d = dir[i];
    if (d == null) return null;
    return [s * Math.sin((d * Math.PI) / 180), s * Math.cos((d * Math.PI) / 180)];
  };
  const a = pick(i0), b = pick(k);
  if (!a && !b) return NaN;
  const f = times[k] === times[i0] ? 0 : clamp((t - times[i0]) / (times[k] - times[i0]), 0, 1);
  const u = a && b ? a[0] + (b[0] - a[0]) * f : (a || b)[0];
  const v = a && b ? a[1] + (b[1] - a[1]) * f : (a || b)[1];
  return ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
}

const nonNullIn = (times, vals, t0, t1) => {
  if (!vals) return 0;
  let n = 0;
  for (let i = 0; i < times.length; i++) if (times[i] >= t0 && times[i] <= t1 && vals[i] != null) n++;
  return n;
};

/**
 * Build model series on the timeline.
 * @returns {object} per-model series and pin variables
 */
export function processNWP({ det, ring, ens, models, timeline, nowSec }) {
  const dj = det.json;
  const nM = det.ids.length;
  const H = dj.hourly || {};
  const M15 = dj.minutely_15 || {};
  const ht = H.time || [];
  const mt = M15.time || [];
  const tEnd = timeline[timeline.length - 1];
  const out = { models: [], timezone: dj.timezone, tzAbbr: dj.timezone_abbreviation, utcOffset: dj.utc_offset_seconds, elevation: dj.elevation };

  for (const id of det.ids) {
    const meta = models.find((m) => m.id === id) || { id, label: id, short: id, prior: 0.5 };
    const p1 = seriesFor(H, 'precipitation', id, nM);
    if (nonNullIn(ht, p1, nowSec, tEnd) < 2) continue; // model does not cover this place/time
    const p15 = seriesFor(M15, 'precipitation', id, nM);
    const use15 = !!meta.hires && nonNullIn(mt, p15, nowSec, nowSec + 3 * 3600) >= 8;
    const ringSeries = ring ? ring.json.map((pt) => seriesFor(pt.hourly, 'precipitation', id, nM)) : [];
    const ringTimes = ring ? ring.json.map((pt) => (pt.hourly && pt.hourly.time) || []) : [];
    const get = (v) => seriesFor(H, v, id, nM);
    const series = {
      center: timeline.map((t) => (use15 ? rateAt(mt, p15, 900, t) : rateAt(ht, p1, 3600, t))),
      ring: ringSeries.map((s, j) => timeline.map((t) => rateAt(ringTimes[j], s, 3600, t))),
      temp: timeline.map((t) => valueAt(ht, get('temperature_2m'), t)),
      feels: timeline.map((t) => valueAt(ht, get('apparent_temperature'), t)),
      rh: timeline.map((t) => valueAt(ht, get('relative_humidity_2m'), t)),
      cloud: timeline.map((t) => valueAt(ht, get('cloud_cover'), t)),
      wind: timeline.map((t) => valueAt(ht, get('wind_speed_10m'), t)),
      gust: timeline.map((t) => valueAt(ht, get('wind_gusts_10m'), t)),
      dir: timeline.map((t) => dirAt(ht, get('wind_speed_10m'), get('wind_direction_10m'), t)),
      cape: timeline.map((t) => valueAt(ht, get('cape'), t)),
      snow: timeline.map((t) => rateAt(ht, get('snowfall'), 3600, t)),
      code: timeline.map((t) => {
        const c = get('weather_code');
        if (!c) return NaN;
        let k = ht.findIndex((x) => x >= t);
        if (k < 0) k = ht.length - 1;
        return c[k] ?? NaN;
      }),
      steer: (() => {
        const s = get('wind_speed_700hPa'), d = get('wind_direction_700hPa');
        if (!s || !d) return null;
        const sp = valueAt(ht, s, nowSec);
        const dd = dirAt(ht, s, d, nowSec);
        return Number.isFinite(sp) && Number.isFinite(dd) ? { speedKmh: sp, fromDeg: dd } : null;
      })(),
      // past precipitation for verification against radar: [{t (end of hour), center, ring[]}]
      past: ht
        .map((t, i) => ({ t, i }))
        .filter((o) => o.t <= nowSec + 60 && o.t > nowSec - 3 * 3600)
        .map(({ t, i }) => ({
          t,
          center: p1[i],
          ring: ringSeries.map((s, j) => {
            const k = ringTimes[j].indexOf(t);
            return k >= 0 && s ? s[k] : null;
          }),
        })),
      native15: use15,
    };
    out.models.push({ ...meta, series, weight: meta.prior, verify: null });
  }

  // Ensembles
  out.ensembles = [];
  if (ens && ens.json && ens.json.hourly) {
    const eh = ens.json.hourly;
    const et = eh.time || [];
    const groups = groupEnsembleMembers(eh, 'precipitation');
    for (const [key, series] of groups) {
      const meta = ensembleMeta(key, ens.ids.length === 1 ? ens.ids[0] : '');
      const mem = series.filter((sr) => nonNullIn(et, sr, nowSec, tEnd) >= 2);
      if (!mem.length) continue;
      out.ensembles.push({ ...meta, members: mem.map((sr) => timeline.map((t) => rateAt(et, sr, 3600, t))) });
    }
  }
  return out;
}

// ---------- Probabilities ----------
const RAIN_THR = 0.2; // mm/h, model grid-box mean that indicates rain is likely somewhere nearby
const OFFSETS = [-6, -3, 0, 3, 6]; // timeline steps of 5 min -> ±30 min timing tolerance
const OFF_W = [0.5, 0.75, 1, 0.75, 0.5];

function neighbourhoodProb(series, i, thr) {
  let s = 0, wsum = 0;
  for (let o = 0; o < OFFSETS.length; o++) {
    const k = i + OFFSETS[o];
    if (k < 0 || k >= series.center.length) continue;
    const c = series.center[k];
    if (Number.isFinite(c)) { s += 2 * OFF_W[o] * (c >= thr ? 1 : 0); wsum += 2 * OFF_W[o]; }
    for (const r of series.ring) {
      const v = r[k];
      if (Number.isFinite(v)) { s += OFF_W[o] * (v >= thr ? 1 : 0); wsum += OFF_W[o]; }
    }
  }
  return wsum > 0 ? s / wsum : NaN;
}

/** Combine models + ensembles into probabilities and distributions on the timeline. */
export function nwpProbabilities(nwp, timeline, thresholds) {
  const n = timeline.length;
  const res = {
    prob: thresholds.map(() => new Float32Array(n)),
    probModels: thresholds.map(() => new Float32Array(n)),
    probEns: thresholds.map(() => new Float32Array(n)).map((a) => a.fill(NaN)),
    mean: new Float32Array(n), q10: new Float32Array(n), q50: new Float32Array(n), q90: new Float32Array(n),
    spread: new Float32Array(n),
    samples: [], // per time: {vals, wts} for mixture quantiles
    perModel: {}, // model id -> chance of rain (neighbourhood) per time, logged for the scorecard
  };
  const ms = nwp.models;
  const totalW = ms.reduce((a, m) => a + m.weight, 0) || 1;
  for (const m of ms) res.perModel[m.id] = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const vals = [], wts = [];
    thresholds.forEach((thr, ti) => {
      // thresholds are point rates; models are grid-box means, so heavier classes use a softer threshold
      const t = ti === 0 ? RAIN_THR : thr * 0.7;
      let p = 0;
      let wsum = 0;
      const per = [];
      for (const m of ms) {
        const q = neighbourhoodProb(m.series, i, t);
        if (Number.isFinite(q)) {
          p += m.weight * q;
          wsum += m.weight;
          per.push(q);
          if (ti === 0) res.perModel[m.id][i] = q;
        }
      }
      // normalise by the weight of models that actually have data at this time
      res.probModels[ti][i] = wsum > 0 ? p / wsum : 0;
      if (ti === 0 && per.length > 1) {
        const mu = per.reduce((a, b) => a + b, 0) / per.length;
        res.spread[i] = Math.sqrt(per.reduce((a, b) => a + (b - mu) ** 2, 0) / per.length);
      }
    });
    for (const m of ms) {
      const c = m.series.center[i];
      if (Number.isFinite(c)) { vals.push(c); wts.push(m.weight / totalW); }
    }
    // ensembles
    if (nwp.ensembles.length) {
      const ensTot = nwp.ensembles.reduce((a, e) => a + e.weight, 0);
      thresholds.forEach((thr, ti) => {
        const t = ti === 0 ? RAIN_THR : thr * 0.7;
        let p = 0;
        for (const e of nwp.ensembles) {
          let hit = 0;
          for (const mem of e.members) {
            // ±30 min timing tolerance
            let any = false;
            for (const o of [-6, 0, 6]) {
              const v = mem[Math.min(n - 1, Math.max(0, i + o))];
              if (v >= t) { any = true; break; }
            }
            if (any) hit++;
          }
          p += (e.weight * hit) / e.members.length;
        }
        res.probEns[ti][i] = p / ensTot;
      });
      for (const e of nwp.ensembles) {
        const w = (0.6 * e.weight) / (ensTotal(nwp) * e.members.length);
        for (const mem of e.members) if (Number.isFinite(mem[i])) { vals.push(mem[i]); wts.push(w); }
      }
    }
    thresholds.forEach((_, ti) => {
      const pm = res.probModels[ti][i];
      const pe = res.probEns[ti][i];
      const p = Number.isFinite(pe) ? 0.6 * pm + 0.4 * pe : pm;
      res.prob[ti][i] = 0.02 + 0.96 * clamp(p, 0, 1);
    });
    let mu = 0, ws = 0;
    for (let k = 0; k < vals.length; k++) { mu += vals[k] * wts[k]; ws += wts[k]; }
    res.mean[i] = ws > 0 ? mu / ws : NaN;
    res.q10[i] = weightedQuantile(vals, wts, 0.1);
    res.q50[i] = weightedQuantile(vals, wts, 0.5);
    res.q90[i] = weightedQuantile(vals, wts, 0.9);
    res.samples.push({ vals, wts });
  }
  return res;
}
const ensTotal = (nwp) => nwp.ensembles.reduce((a, e) => a + e.weight, 0) || 1;

/** Weighted multi-model mean/spread of a pin variable. */
export function pinVariable(nwp, key, i) {
  let s = 0, w = 0;
  const vals = [];
  for (const m of nwp.models) {
    const v = m.series[key][i];
    if (Number.isFinite(v)) { s += v * m.weight; w += m.weight; vals.push(v); }
  }
  if (!w) return { mean: NaN, min: NaN, max: NaN };
  return { mean: s / w, min: Math.min(...vals), max: Math.max(...vals), n: vals.length };
}
export function pinWindDir(nwp, i) {
  let u = 0, v = 0;
  for (const m of nwp.models) {
    const d = m.series.dir[i];
    const s = m.series.wind[i];
    if (!Number.isFinite(d)) continue;
    const sp = Number.isFinite(s) ? s : 1;
    u += m.weight * sp * Math.sin((d * Math.PI) / 180);
    v += m.weight * sp * Math.cos((d * Math.PI) / 180);
  }
  if (!u && !v) return NaN;
  return ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
}
/** Fraction of model weight forecasting thunder (WMO codes 95–99) within ±1 h. */
export function thunderFraction(nwp, i) {
  let s = 0, w = 0;
  for (const m of nwp.models) {
    const c = m.series.code;
    let any = false;
    let known = false;
    for (let k = Math.max(0, i - 12); k <= Math.min(c.length - 1, i + 12); k++) {
      if (Number.isFinite(c[k])) { known = true; if (c[k] >= 95) { any = true; break; } }
    }
    if (!known) continue;
    s += m.weight * (any ? 1 : 0);
    w += m.weight;
  }
  return w ? s / w : NaN;
}
/** Model-mean 700 hPa steering wind at the pin now. */
export function steeringWind(nwp) {
  let u = 0, v = 0, w = 0;
  for (const m of nwp.models) {
    const s = m.series.steer;
    if (!s) continue;
    const to = ((s.fromDeg + 180) * Math.PI) / 180;
    u += m.weight * s.speedKmh * Math.sin(to);
    v += m.weight * s.speedKmh * Math.cos(to);
    w += m.weight;
  }
  if (!w) return null;
  u /= w; v /= w;
  return { speedKmh: Math.hypot(u, v), fromDeg: ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360 };
}

/**
 * Re-weight models by how well they matched the radar over the past hours (live verification).
 * obs: [{tEnd, frac}] observed rain fraction (radar) within ~25 km for each past hour.
 */
export function verifyModels(nwp, obs) {
  if (!obs || !obs.length) return null;
  const table = [];
  for (const m of nwp.models) {
    let err = 0, n = 0, wetObs = 0, wetMod = 0;
    for (const o of obs) {
      const p = m.series.past.find((q) => Math.abs(q.t - o.tEnd) < 300);
      if (!p) continue;
      const vals = [p.center, ...p.ring].filter((v) => v != null);
      if (!vals.length) continue;
      const frac = vals.filter((v) => v >= RAIN_THR).length / vals.length;
      err += (frac - o.frac) ** 2;
      n++;
      wetObs += o.frac; wetMod += frac;
    }
    if (!n) continue;
    const e = err / n;
    const informative = wetObs > 0.05 || wetMod > 0.05;
    const factor = informative ? 1 / (1 + 4 * e) : 1;
    m.verify = { error: e, hours: n, factor, informative };
    m.weight = m.prior * factor;
    table.push({ id: m.id, short: m.short, error: e, factor });
  }
  return table;
}
