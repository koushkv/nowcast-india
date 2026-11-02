// Leaflet map: basemap, radar loop (observed + extrapolated frames), pin, range rings, storm track,
// optional satellite infrared layer.
/* global L */


// Radar colour stops (rain rate mm/h -> RGBA), tuned to read on both light and dark basemaps.
const STOPS = [
  [0.1, [130, 205, 235, 0.30]],
  [0.3, [95, 195, 240, 0.62]],
  [1, [50, 155, 238, 0.74]],
  [2.5, [30, 108, 222, 0.82]],
  [6, [62, 74, 214, 0.86]],
  [10, [122, 78, 240, 0.88]],
  [25, [200, 70, 205, 0.9]],
  [50, [236, 58, 140, 0.92]],
  [120, [255, 196, 222, 0.95]],
];
const LUT = (() => {
  // index by log10(rate) in [-1, 2.3] -> 256 entries
  const lut = new Uint8ClampedArray(256 * 4);
  for (let k = 0; k < 256; k++) {
    const r = Math.pow(10, -1 + (3.3 * k) / 255);
    let a = STOPS[0], b = STOPS[STOPS.length - 1];
    for (let s = 0; s < STOPS.length - 1; s++) {
      if (r >= STOPS[s][0] && r <= STOPS[s + 1][0]) { a = STOPS[s]; b = STOPS[s + 1]; break; }
    }
    const f = r <= a[0] ? 0 : r >= b[0] ? 1 : Math.log(r / a[0]) / Math.log(b[0] / a[0]);
    for (let c = 0; c < 3; c++) lut[k * 4 + c] = a[1][c] + (b[1][c] - a[1][c]) * f;
    lut[k * 4 + 3] = 255 * (a[1][3] + (b[1][3] - a[1][3]) * f);
  }
  return lut;
})();
// Chance-of-rain heat palette: pale yellow (unlikely) through orange and red to purple (near certain).
const PSTOPS = [
  [0.05, [254, 240, 138, 0.0]],
  [0.15, [253, 224, 71, 0.38]],
  [0.3, [251, 146, 60, 0.55]],
  [0.5, [239, 68, 68, 0.66]],
  [0.7, [190, 18, 60, 0.68]],
  [0.9, [126, 34, 206, 0.72]],
  [1.0, [88, 28, 135, 0.75]],
];
const PLUT = (() => {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let k = 0; k < 256; k++) {
    const p = k / 255;
    let a = PSTOPS[0], b = PSTOPS[PSTOPS.length - 1];
    for (let s = 0; s < PSTOPS.length - 1; s++) if (p >= PSTOPS[s][0] && p <= PSTOPS[s + 1][0]) { a = PSTOPS[s]; b = PSTOPS[s + 1]; break; }
    const f = p <= a[0] ? 0 : p >= b[0] ? 1 : (p - a[0]) / (b[0] - a[0]);
    for (let c = 0; c < 3; c++) lut[k * 4 + c] = a[1][c] + (b[1][c] - a[1][c]) * f;
    lut[k * 4 + 3] = p < PSTOPS[0][0] ? 0 : 255 * (a[1][3] + (b[1][3] - a[1][3]) * f);
  }
  return lut;
})();
export const CHANCE_GRADIENT = `linear-gradient(90deg, ${PSTOPS.slice(1).map(([p, c]) => `rgba(${c[0]},${c[1]},${c[2]},${Math.max(0.5, c[3])}) ${Math.round(p * 100)}%`).join(', ')})`;

/**
 * A field drawn at screen resolution with bilinear interpolation, so it stays smooth at every zoom.
 * The data grid is in Web Mercator pixels of the radar block, so screen -> grid is a linear map.
 */
const FieldLayer = L.Layer.extend({
  onAdd(map) {
    this._map = map;
    this._canvas = L.DomUtil.create('canvas', 'pw-field leaflet-zoom-hide');
    map.getPane('overlayPane').appendChild(this._canvas);
    map.on('moveend zoomend resize viewreset', this._draw, this);
    this._draw();
  },
  onRemove(map) {
    map.off('moveend zoomend resize viewreset', this._draw, this);
    L.DomUtil.remove(this._canvas);
  },
  /** field: { data: Uint8Array|Float32Array (w*h), w, h, scale (block px per data px), lut, mask?, isProb } */
  setField(field) {
    this._field = field;
    this._draw();
  },
  _draw() {
    const map = this._map;
    if (!map || !this._canvas) return;
    const size = map.getSize();
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this._canvas, topLeft);
    const cv = this._canvas;
    if (cv.width !== size.x || cv.height !== size.y) { cv.width = size.x; cv.height = size.y; }
    cv.style.width = `${size.x}px`;
    cv.style.height = `${size.y}px`;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, size.x, size.y);
    const f = this._field;
    if (!f || !f.block) return;
    // screen pixel -> block native pixel: world pixel at zoom Z (256 tiles) scaled to the block grid
    const z = map.getZoom();
    const origin = map.getPixelOrigin();
    const k = (f.block.size * 2 ** f.block.z) / (256 * 2 ** z);
    const ox = (topLeft.x + origin.x) * k - f.block.x0 * f.block.size;
    const oy = (topLeft.y + origin.y) * k - f.block.y0 * f.block.size;
    const sc = 1 / f.scale; // block native px -> data px
    const W = size.x, H = size.y, w = f.w, h = f.h, d = f.data, lut = f.lut, mask = f.mask;
    const img = ctx.createImageData(W, H);
    const out = img.data;
    const a = k * sc;
    for (let sy = 0; sy < H; sy++) {
      const gy = (oy + sy * k) * sc - 0.5;
      if (gy < 0 || gy > h - 1) continue;
      const j = Math.floor(gy);
      const fy = gy - j;
      const j1 = Math.min(h - 1, j + 1);
      let gx = ox * sc - 0.5;
      for (let sx = 0; sx < W; sx++, gx += a) {
        if (gx < 0 || gx > w - 1) continue;
        const i = Math.floor(gx);
        const fx = gx - i;
        const i1 = Math.min(w - 1, i + 1);
        const r0 = j * w, r1 = j1 * w;
        const o = (sy * W + sx) * 4;
        if (mask && !mask[Math.round(gy) * w + Math.round(gx)]) {
          // outside radar coverage: light diagonal hatch in screen space
          if ((sx + sy) % 9 === 0) { out[o] = 128; out[o + 1] = 136; out[o + 2] = 148; out[o + 3] = 90; }
          continue;
        }
        const v = (d[r0 + i] * (1 - fx) + d[r0 + i1] * fx) * (1 - fy) + (d[r1 + i] * (1 - fx) + d[r1 + i1] * fx) * fy;
        if (!(v >= 1)) continue;
        const li = (v > 255 ? 255 : v | 0) * 4;
        out[o] = lut[li]; out[o + 1] = lut[li + 1]; out[o + 2] = lut[li + 2]; out[o + 3] = lut[li + 3];
      }
    }
    ctx.putImageData(img, 0, 0);
  },
});

export const RADAR_LEGEND = [
  ['Light', 'rgb(95,195,240)'], ['Moderate', 'rgb(30,108,222)'], ['Heavy', 'rgb(122,78,240)'], ['Very heavy', 'rgb(236,58,140)'],
];

function pinIcon() {
  return L.divIcon({
    className: 'pw-pin',
    html: `<svg viewBox="0 0 32 44" width="32" height="44" aria-hidden="true">
      <path d="M16 1C8 1 2 7 2 15c0 10 14 27 14 27s14-17 14-27C30 7 24 1 16 1z" fill="var(--pin)" stroke="var(--pin-stroke)" stroke-width="2"/>
      <circle cx="16" cy="15" r="5.5" fill="var(--pin-dot)"/></svg>`,
    iconSize: [32, 44],
    iconAnchor: [16, 42],
  });
}

const SAT = (lon) => {
  if (lon >= 58 && lon < 102) return { url: 'https://view.eumetsat.int/geoserver/wms', layers: 'msg_iodc:ir108', name: 'Meteosat IODC infrared (EUMETSAT)' };
  if (lon >= -40 && lon < 58) return { url: 'https://view.eumetsat.int/geoserver/wms', layers: 'mtg_fd:ir105_hrfi', name: 'Meteosat MTG infrared (EUMETSAT)' };
  if (lon >= 102 || lon < -165) return { url: 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi', layers: 'Himawari_AHI_Band13_Clean_Infrared', name: 'Himawari infrared (NASA GIBS)' };
  if (lon < -105) return { url: 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi', layers: 'GOES-West_ABI_Band13_Clean_Infrared', name: 'GOES-West infrared (NASA GIBS)' };
  return { url: 'https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi', layers: 'GOES-East_ABI_Band13_Clean_Infrared', name: 'GOES-East infrared (NASA GIBS)' };
};

export class RadarMap {
  constructor(el, { onPick, dark }) {
    this.onPick = onPick;
    this.map = L.map(el, {
      zoomControl: false, minZoom: 4, maxZoom: 12, attributionControl: true, tap: true, preferCanvas: false,
      // India and its neighbourhood only
      maxBounds: L.latLngBounds([0, 60], [42, 104]), maxBoundsViscosity: 0.9,
    });
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    this.map.createPane('sat');
    this.map.getPane('sat').style.zIndex = 300;
    this.setTheme(dark);
    this.field = new FieldLayer().addTo(this.map);
    this.prepared = new Map();
    this.mode = 'radar';
    this.rings = [];
    this.track = null;
    this.marker = null;
    this.sat = null;
    this.map.on('click', (e) => this.onPick && this.onPick(e.latlng.lat, e.latlng.lng, 'map'));
  }

  setTheme(dark) {
    const style = dark ? 'dark' : 'light';
    if (this.style === style) return;
    this.style = style;
    // OpenStreetMap's standard tiles need no key; a CSS filter mutes (light) or inverts (dark)
    // them so the radar colours stand out.
    if (!this.base) {
      this.base = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(this.map);
    }
    const c = this.base.getContainer && this.base.getContainer();
    if (c) {
      c.classList.toggle('pw-base-dark', dark);
      c.classList.toggle('pw-base-light', !dark);
    } else {
      this.base.once('add', () => this.setTheme(dark));
      this.style = null;
    }
    if (this.sat && this.sat.getContainer && this.sat.getContainer()) this.sat.getContainer().style.mixBlendMode = dark ? 'screen' : 'normal';
  }

  setView(lat, lon, zoom) {
    this.map.setView([lat, lon], zoom ?? this.map.getZoom() ?? 8, { animate: false });
  }

  setPin(lat, lon) {
    if (!this.marker) {
      this.marker = L.marker([lat, lon], { icon: pinIcon(), draggable: true, keyboard: true, title: 'Forecast location', zIndexOffset: 1000 }).addTo(this.map);
      this.marker.on('dragend', () => {
        const p = this.marker.getLatLng();
        this.onPick && this.onPick(p.lat, p.lng, 'drag');
      });
    } else {
      this.marker.setLatLng([lat, lon]);
    }
    for (const r of this.rings) this.map.removeLayer(r);
    this.rings = [10, 25, 50].map((km) => L.circle([lat, lon], {
      radius: km * 1000, className: 'pw-ring', color: '#8894a3', weight: 1, dashArray: '3 5', fill: false, interactive: false,
    }).addTo(this.map));
  }

  /** frames: [{time, rate (Float32 w*h), known?}], block: radar block, cov: Uint8 coverage */
  setFrames(frames, block, cov, w, h, probField) {
    this.frames = frames;
    this.block = block;
    this.cov = cov;
    this.w = w;
    this.h = h;
    this.probField = probField || null;
    this.prepared.clear();
    if (this.mode === 'chance') this.showChance();
  }

  /** Rain rate -> palette index (0 = none), lightly smoothed so edges look natural, cached per frame. */
  prepare(k) {
    if (this.prepared.has(k)) return this.prepared.get(k);
    const { rate, known } = this.frames[k];
    const w = this.w, h = this.h;
    const idx = new Float32Array(w * h);
    for (let i = 0; i < rate.length; i++) {
      const r = rate[i];
      if (r >= 0.1) {
        const v = ((Math.log10(r) + 1) / 3.3) * 255;
        idx[i] = v < 1 ? 1 : v > 255 ? 255 : v;
      }
    }
    // separable [1 2 1]/4 blur
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        tmp[i] = 0.25 * idx[x > 0 ? i - 1 : i] + 0.5 * idx[i] + 0.25 * idx[x < w - 1 ? i + 1 : i];
      }
    }
    const out = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        out[i] = 0.25 * tmp[y > 0 ? i - w : i] + 0.5 * tmp[i] + 0.25 * tmp[y < h - 1 ? i + w : i];
      }
    }
    let mask = this.cov;
    if (known) {
      mask = new Uint8Array(w * h);
      for (let i = 0; i < mask.length; i++) mask[i] = known[i] && (!this.cov || this.cov[i]) ? 1 : 0;
    }
    const prep = { data: out, mask };
    this.prepared.set(k, prep);
    return prep;
  }

  showFrame(k) {
    if (!this.frames || !this.frames[k]) return;
    this.mode = 'radar';
    const p = this.prepare(k);
    this.field.setField({ block: this.block, w: this.w, h: this.h, scale: 2, data: p.data, mask: p.mask, lut: LUT });
  }

  /** Chance of rain in the next hour (lattice field, 4 R1 px spacing). */
  showChance() {
    this.mode = 'chance';
    const pf = this.probField;
    if (!pf) { this.field.setField(null); return; }
    const nx = pf.nx, ny = pf.ny;
    const raw = new Float32Array(nx * ny);
    const mask = new Uint8Array(nx * ny);
    for (let i = 0; i < raw.length; i++) {
      const v = pf.data[i];
      if (Number.isFinite(v)) { mask[i] = 1; raw[i] = v; }
    }
    // two passes of a [1 2 1] blur over known points: smooth contours without moving them
    let cur = raw;
    for (let pass = 0; pass < 2; pass++) {
      const next = new Float32Array(nx * ny);
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const i = y * nx + x;
          if (!mask[i]) continue;
          let s = 0, wsum = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= ny) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= nx || !mask[yy * nx + xx]) continue;
              const wgt = (dx ? 1 : 2) * (dy ? 1 : 2);
              s += cur[yy * nx + xx] * wgt;
              wsum += wgt;
            }
          }
          next[i] = s / wsum;
        }
      }
      cur = next;
    }
    const data = new Uint8ClampedArray(nx * ny);
    for (let i = 0; i < data.length; i++) if (mask[i]) data[i] = Math.round(cur[i] * 255);
    this.field.setField({ block: this.block, w: pf.nx, h: pf.ny, scale: 2 * pf.step, data, mask, lut: PLUT });
  }

  /** Dashed line along which rain reaches the pin within the next hour. */
  setTrack(lat, lon, fromDeg, speedKmh) {
    if (this.track) { this.map.removeLayer(this.track); this.track = null; }
    if (!(speedKmh > 3)) return;
    const pts = [];
    const R = 6371;
    for (let m = 0; m <= 60; m += 10) {
      const d = (speedKmh * m) / 60 / R;
      const b = (fromDeg * Math.PI) / 180;
      const p1 = (lat * Math.PI) / 180;
      const l1 = (lon * Math.PI) / 180;
      const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
      const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
      pts.push([(p2 * 180) / Math.PI, (l2 * 180) / Math.PI]);
    }
    const line = L.polyline(pts, { className: 'pw-track', color: '#e0a800', weight: 2.5, dashArray: '6 6', interactive: false });
    const ticks = pts.slice(1, -1).map((p, k) => L.circleMarker(p, {
      radius: 2.5, className: 'pw-track-dot', color: '#e0a800', weight: 1, fillOpacity: 1, interactive: false,
    }).bindTooltip(`${(k + 1) * 10} min`, { permanent: false, direction: 'top' }));
    this.track = L.layerGroup([line, ...ticks]).addTo(this.map);
  }

  toggleSatellite(on, lon, dark) {
    if (this.sat) { this.map.removeLayer(this.sat); this.sat = null; }
    if (!on) return null;
    const s = SAT(lon);
    this.sat = L.tileLayer.wms(s.url, {
      layers: s.layers, format: 'image/png', transparent: true, version: '1.3.0', opacity: dark ? 0.75 : 0.5,
      pane: 'sat', attribution: s.name, tileSize: 512, zoomOffset: -1,
    }).addTo(this.map);
    const c = this.sat.getContainer();
    if (c) c.style.mixBlendMode = dark ? 'screen' : 'normal';
    return s;
  }

  invalidate() { this.map.invalidateSize(); }
}
