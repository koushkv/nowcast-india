// Canvas chart for the next hour. Colours come from CSS tokens so both themes stay consistent.

import { rateCategory } from './util.js';

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}
export function rainColors() {
  return [cssVar('--rain-0'), cssVar('--rain-1'), cssVar('--rain-2'), cssVar('--rain-3'), cssVar('--rain-4')];
}

function setup(canvas) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(10, Math.round(rect.width));
  const h = Math.max(10, Math.round(rect.height));
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

const catColor = (cols, rate, p) => {
  const c = rateCategory(rate);
  if (c > 0) return cols[c];
  return p >= 0.15 ? cols[1] : cols[0];
};

/** Next hour: 13 bars (now .. +60 min), height = chance of rain, colour = likely intensity. */
export function drawNextHour(canvas, d, fmt, opts = {}) {
  const { ctx, w, h } = setup(canvas);
  const cols = rainColors();
  const ink = cssVar('--ink');
  const muted = cssVar('--muted');
  const line = cssVar('--line');
  const n = 13;
  const top = 8, bottom = 22, left = 42, right = 2;
  const ph = h - top - bottom;
  const bw = (w - left - right) / n;
  const font = cssVar('--font');
  ctx.font = `500 12px ${font}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  // gridlines at 0 / 50 / 100 %
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  for (const g of [0, 0.5, 1]) {
    const y = Math.round(top + ph * (1 - g)) + 0.5;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(w - right, y); ctx.stroke();
    ctx.fillStyle = muted;
    ctx.fillText(`${g * 100}%`, left - 6, y);
  }
  for (let i = 0; i < n; i++) {
    const p = d.prob[0][i];
    const x = left + i * bw + 2;
    if (p > 0.02) {
      const bh = Math.max(3, ph * p);
      ctx.fillStyle = catColor(cols, d.q50[i], p);
      roundRect(ctx, x, top + ph - bh, bw - 4, bh, 4);
      ctx.fill();
    }
    if (opts.hover === i) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1.5;
      roundRect(ctx, x - 1, top - 1, bw - 2, ph + 2, 5);
      ctx.stroke();
    }
  }
  ctx.fillStyle = muted;
  ctx.textBaseline = 'alphabetic';
  const labels = [[0, 'Now'], [3, '15 min'], [6, '30 min'], [9, '45 min'], [12, '60 min']];
  for (const [i, t] of labels) {
    const x = left + i * bw + bw / 2;
    ctx.textAlign = i === 0 ? 'left' : i === 12 ? 'right' : 'center';
    ctx.fillText(t, i === 0 ? left + 2 : i === 12 ? w - right : x, h - 5);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}
