// Synthetic radar + model data with KNOWN truth, used to test the engine and the UI offline.
// Nothing here is shipped to users.

import zlib from 'node:zlib';
import {
  chooseBlock, dbzToRGBA, RV_TILE, RV_ZOOM,
} from '../public/js/radar.js';
import { tileXToLon, tileYToLat, destinationPoint, mercatorPixelKm } from '../public/js/util.js';

// ---------- PNG encoder (RGBA, 8 bit, filter 0) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Scenario: a rain band + convective cells moving at a fixed velocity.
 * motion: {speedKmh, toDeg}. Cells are placed upstream of the pin so they arrive at known times.
 */
export function makeScenario({
  lat = 14.165, lon = 77.811, speedKmh = 36, toDeg = 70, nowSec = 1793620800,
  frames = 7, stepMin = 10, ageMin = 6, cells, band = true, coverageHoleKm = null,
} = {}) {
  const block = chooseBlock(lat, lon);
  const latestTime = nowSec - ageMin * 60;
  const times = Array.from({ length: frames }, (_, k) => latestTime - (frames - 1 - k) * stepMin * 60);
  const kmPerPx = mercatorPixelKm(lat, RV_ZOOM, RV_TILE);
  const toRad = (toDeg * Math.PI) / 180;
  const ve = speedKmh * Math.sin(toRad); // km/h east
  const vn = speedKmh * Math.cos(toRad); // km/h north
  // Default storm set: a cell that reaches the pin ~40 min after "now", a band arriving ~130 min.
  const upstream = (minutesAfterNow, offsetKm = 0) => {
    // position at time "now" such that it reaches the pin after `minutesAfterNow`
    const dist = (speedKmh * minutesAfterNow) / 60;
    const p = destinationPoint(lat, lon, (toDeg + 180) % 360, dist);
    return offsetKm ? destinationPoint(p.lat, p.lon, (toDeg + 90) % 360, offsetKm) : p;
  };
  const cellList = cells || [
    { at: upstream(40), peakDbz: 48, radiusKm: 9, growth: 0 },
    { at: upstream(25, 45), peakDbz: 52, radiusKm: 7, growth: 0 },
    { at: upstream(-60, -30), peakDbz: 44, radiusKm: 10, growth: 0 },
  ];
  const bandSpec = band ? { at: upstream(130), widthKm: 18, lengthKm: 400, dbz: 30 } : null;

  const W = block.W, H = block.H;
  const toPx = (p) => ({
    x: ((((p.lon + 180) / 360) * 2 ** block.z) - block.x0) * block.size,
    y: ((1 - Math.log(Math.tan((p.lat * Math.PI) / 180) + 1 / Math.cos((p.lat * Math.PI) / 180)) / Math.PI) / 2 * 2 ** block.z - block.y0) * block.size,
  });
  const dbzField = (tSec) => {
    const dtH = (tSec - nowSec) / 3600;
    const shiftE = ve * dtH, shiftN = vn * dtH; // km displacement relative to "now"
    const f = new Float32Array(W * H).fill(-99);
    const put = (x, y, v) => { if (x >= 0 && y >= 0 && x < W && y < H) { const i = y * W + x; if (v > f[i]) f[i] = v; } };
    for (const c of cellList) {
      const c0 = toPx(c.at);
      const cx = c0.x + shiftE / kmPerPx;
      const cy = c0.y - shiftN / kmPerPx;
      const rpx = c.radiusKm / kmPerPx;
      const peak = c.peakDbz + (c.growth || 0) * dtH;
      for (let y = Math.floor(cy - 3 * rpx); y <= cy + 3 * rpx; y++) {
        for (let x = Math.floor(cx - 3 * rpx); x <= cx + 3 * rpx; x++) {
          const d2 = ((x - cx) ** 2 + (y - cy) ** 2) / (rpx * rpx);
          const v = peak - 12 * d2; // dBZ falls off quadratically -> ~Gaussian in Z
          if (v > 8) put(x, y, v);
        }
      }
    }
    if (bandSpec) {
      const b0 = toPx(bandSpec.at);
      const bx = b0.x + shiftE / kmPerPx;
      const by = b0.y - shiftN / kmPerPx;
      // band axis perpendicular to motion
      const ax = Math.cos(toRad), ay = Math.sin(toRad); // perpendicular dir in px (east, south)
      const nxm = Math.sin(toRad), nym = -Math.cos(toRad); // motion dir in px coords
      for (let y = 0; y < H; y += 1) {
        for (let x = 0; x < W; x += 1) {
          const dx = x - bx, dy = y - by;
          const along = (dx * ax + dy * ay) * kmPerPx;
          const across = (dx * nxm + dy * nym) * kmPerPx;
          if (Math.abs(along) > bandSpec.lengthKm / 2 || Math.abs(across) > bandSpec.widthKm * 2) continue;
          const v = bandSpec.dbz - 10 * (across / bandSpec.widthKm) ** 2 + 4 * Math.sin(along / 23);
          if (v > 8) put(x, y, v);
        }
      }
    }
    return f;
  };

  const pngs = new Map(); // url -> Buffer
  const host = 'https://tilecache.rainviewer.com';
  const index = {
    version: '2.0', generated: nowSec - 60, host,
    radar: { past: times.map((t) => ({ time: t, path: `/v2/radar/${t.toString(16)}` })), nowcast: [] },
    satellite: { infrared: [] },
  };
  const maxT = 2 ** block.z;
  for (const t of times) {
    const field = dbzField(t);
    for (let j = 0; j < block.n; j++) {
      for (let i = 0; i < block.n; i++) {
        const rgba = new Uint8Array(block.size * block.size * 4);
        for (let y = 0; y < block.size; y++) {
          for (let x = 0; x < block.size; x++) {
            const v = field[(j * block.size + y) * W + i * block.size + x];
            const c = dbzToRGBA(v);
            const o = (y * block.size + x) * 4;
            rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = c[3];
          }
        }
        const x = (((block.x0 + i) % maxT) + maxT) % maxT;
        const url = `${host}/v2/radar/${t.toString(16)}/${block.size}/${block.z}/${x}/${block.y0 + j}/2/0_0.png`;
        pngs.set(url, encodePNG(block.size, block.size, rgba));
      }
    }
  }
  // coverage: everything covered, optionally a hole
  for (let j = 0; j < block.n; j++) {
    for (let i = 0; i < block.n; i++) {
      const rgba = new Uint8Array(block.size * block.size * 4);
      if (coverageHoleKm) {
        const pinPx = { x: block.pinX, y: block.pinY };
        const hole = coverageHoleKm / kmPerPx;
        for (let y = 0; y < block.size; y++) {
          for (let x = 0; x < block.size; x++) {
            const gx = i * block.size + x, gy = j * block.size + y;
            if (Math.hypot(gx - pinPx.x + hole * 1.2, gy - pinPx.y) < hole) {
              const o = (y * block.size + x) * 4;
              rgba[o + 3] = 255;
            }
          }
        }
      }
      const x = (((block.x0 + i) % maxT) + maxT) % maxT;
      pngs.set(`${host}/v2/coverage/0/${block.size}/${block.z}/${x}/${block.y0 + j}/0/0_0.png`, encodePNG(block.size, block.size, rgba));
    }
  }
  return {
    block, times, nowSec, index, pngs, kmPerPx, truth: { ve, vn, speedKmh, toDeg, cells: cellList, band: bandSpec },
    tileXToLon, tileYToLat,
  };
}

/** A fetch() stand-in that serves the scenario's tiles and index. */
export function scenarioFetch(sc, extra = {}) {
  return async (url) => {
    const u = String(url);
    if (u.startsWith('https://api.rainviewer.com/public/weather-maps.json')) {
      return new Response(JSON.stringify(sc.index), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (sc.pngs.has(u)) {
      return new Response(sc.pngs.get(u), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    for (const [prefix, handler] of Object.entries(extra)) {
      if (u.startsWith(prefix)) return handler(u);
    }
    return new Response('not found', { status: 404 });
  };
}

// ---------- Synthetic Open-Meteo responses ----------
/**
 * rainFn(modelId, tSec, pointIndex) -> mm per hour (accumulation over the hour ending at tSec).
 * pointIndex: -1 = pin, 0..7 = ring.
 */
export function openMeteoHandlers({ nowSec, rainFn, tz = 'Asia/Kolkata', tzAbbr = 'GMT+5:30', offset = 19800, temp = 26 }) {
  const hourTimes = (past, fut) => {
    // like Open-Meteo with timezone=auto: hours follow local clock hours (xx:30 UTC in India)
    const h0 = Math.floor((nowSec + offset) / 3600) * 3600 - offset;
    const out = [];
    for (let t = h0 - past * 3600; t <= h0 + fut * 3600; t += 3600) out.push(t);
    return out;
  };
  const q15Times = () => {
    const q0 = Math.floor(nowSec / 900) * 900;
    const out = [];
    for (let t = q0 - 12 * 900; t <= q0 + 32 * 900; t += 900) out.push(t);
    return out;
  };
  const parse = (u) => Object.fromEntries(new URL(u).searchParams.entries());
  const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
  return {
    'https://api.open-meteo.com/v1/forecast': (u) => {
      const p = parse(u);
      const models = p.models.split(',');
      const lats = p.latitude.split(',');
      const ht = hourTimes(3, 9);
      const base = { timezone: tz, timezone_abbreviation: tzAbbr, utc_offset_seconds: offset, elevation: 475 };
      if (lats.length > 1) {
        return json(lats.map((_, j) => {
          const hourly = { time: ht };
          for (const m of models) hourly[`precipitation_${m}`] = ht.map((t) => rainFn(m, t, j));
          return { ...base, hourly };
        }));
      }
      const hourly = { time: ht };
      const vars = p.hourly.split(',');
      for (const m of models) {
        for (const v of vars) {
          let f;
          switch (v) {
            case 'precipitation': f = (t) => rainFn(m, t, -1); break;
            case 'snowfall': f = () => 0; break;
            case 'temperature_2m': f = (t) => temp + 3 * Math.sin((t - nowSec) / 20000) + (m.length % 3) * 0.3; break;
            case 'apparent_temperature': f = (t) => temp + 2 + 3 * Math.sin((t - nowSec) / 20000); break;
            case 'relative_humidity_2m': f = () => 70; break;
            case 'cloud_cover': f = (t) => (rainFn(m, t, -1) > 0 ? 95 : 40); break;
            case 'wind_speed_10m': f = () => 12 + (m.length % 4); break;
            case 'wind_direction_10m': f = () => 250; break;
            case 'wind_gusts_10m': f = () => 25; break;
            case 'weather_code': f = (t) => (rainFn(m, t, -1) > 4 ? 95 : rainFn(m, t, -1) > 0.2 ? 61 : 2); break;
            case 'cape': f = () => 1200; break;
            case 'wind_speed_700hPa': f = () => 36; break;
            case 'wind_direction_700hPa': f = () => 250; break;
            default: f = () => null;
          }
          hourly[`${v}_${m}`] = ht.map(f);
        }
      }
      const mt = q15Times();
      const minutely_15 = { time: mt };
      for (const m of models) minutely_15[`precipitation_${m}`] = mt.map((t) => rainFn(m, Math.ceil(t / 3600) * 3600, -1) / 4);
      return json({ ...base, hourly, minutely_15 });
    },
    'https://ensemble-api.open-meteo.com/v1/ensemble': (u) => {
      const p = parse(u);
      const models = p.models.split(',');
      const ht = hourTimes(3, 9);
      const hourly = { time: ht };
      // Mirrors the real API (checked live): control + members, with the response's own model suffix,
      // e.g. precipitation_member07_icon_seamless_eps and precipitation_ncep_gefs_seamless for GEFS.
      const real = {
        icon_seamless: ['icon_seamless_eps', 39], ecmwf_ifs025: ['ecmwf_ifs025_ensemble', 50],
        ukmo_global_ensemble_20km: ['ukmo_global_ensemble_20km', 17], gfs_seamless: ['ncep_gefs_seamless', 30],
      };
      for (const m of models) {
        const [suffix, nmem] = real[m] || [m, 20];
        hourly[`precipitation_${suffix}`] = ht.map((t) => rainFn(m, t, -1));
        for (let k = 1; k <= nmem; k++) {
          const shift = ((k * 37) % 7 - 3) * 1200; // members disagree on timing by up to ±1 h
          hourly[`precipitation_member${String(k).padStart(2, '0')}_${suffix}`] = ht.map((t) => rainFn(m, t + shift, -1));
        }
      }
      return json({ timezone: tz, utc_offset_seconds: offset, hourly });
    },
  };
}
