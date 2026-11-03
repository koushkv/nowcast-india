// "Rain journey": where the rain is, which way it is going and when it reaches you, drawn as SVG.
// Approaching rain is drawn along its path (rain at the top, you at the bottom, a north arrow for
// orientation). Every other situation is drawn as a small north-up radar scope around you.

import { compass16 } from './util.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const RAIN = ['--rain-1', '--rain-1', '--rain-2', '--rain-3', '--rain-4'];
const WORD = ['', 'Light', 'Moderate', 'Heavy', 'Very heavy'];
const TREND = { strengthening: '↑ strengthening', steady: 'steady', weakening: '↓ weakening' };

function cloud(cx, cy, s, color, extra = '') {
  return `<g transform="translate(${cx} ${cy}) scale(${s})"${extra}>
    <path d="M-26 8a12 12 0 0 1 2-23.6A17 17 0 0 1 8.5-20 13 13 0 0 1 26 -6a12 12 0 0 1-2 14z" fill="${color}" opacity=".95"/>
    <path d="M-14 14l-4 9M-2 14l-4 9M10 14l-4 9M22 14l-4 9" stroke="${color}" stroke-width="2.4" stroke-linecap="round" opacity=".8"/></g>`;
}
function you(cx, cy) {
  return `<g transform="translate(${cx} ${cy})"><circle r="7" fill="#000" stroke="#fff" stroke-width="2"/><circle r="2.2" fill="#fff"/>
    <path d="M0-15v5M0 10v5M-15 0h5M10 0h5" stroke="#fff" stroke-width="2"/></g>`;
}
function northArrow(x, y, rotDeg) {
  const a = (rotDeg * Math.PI) / 180;
  const tx = 23 * Math.sin(a), ty = -23 * Math.cos(a) + 3.5; // label stays upright at the arrow's tip
  return `<g transform="translate(${x} ${y})"><circle r="15" fill="none" stroke="var(--line-2)"/>
    <g transform="rotate(${rotDeg.toFixed(1)})"><path d="M0-12l4.5 9h-9z" fill="var(--ink)"/><path d="M0 12l3-6h-6z" fill="var(--faint)"/></g>
    <text x="${tx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="middle" class="jt-n">N</text></g>`;
}
function niceTicks(D) {
  if (D >= 24) {
    const step = D >= 60 ? 10 : 5;
    const a = Math.round((D * 2) / 3 / step) * step, b = Math.round(D / 3 / step) * step;
    return [...new Set([a, b])].filter((d) => d > 0 && d < D - step * 0.4);
  }
  const m = Math.round(D / 2);
  return m > 0 && m < D - 1 ? [m] : [];
}

function pathView(j, f, nowSec) {
  const D = Math.max(1, j.distKm);
  const yTop = 92, yYou = 232, x = 160;
  const yOf = (d) => yYou - (d / D) * (yYou - yTop);
  const tOf = (d) => j.eta * (1 - d / D); // minutes until the rain front is d km from you
  const color = `var(${RAIN[Math.min(4, Math.max(1, j.category || 1))]})`;
  let ticks = '';
  for (const d of niceTicks(D)) {
    const y = yOf(d);
    ticks += `<path d="M${x - 6} ${y}h12" stroke="var(--muted)"/>` +
      `<text x="${x - 14}" y="${y + 4}" text-anchor="end" class="jt">${esc(f.dist(d))}</text>` +
      `<text x="${x + 14}" y="${y + 4}" class="jt dim">+${Math.round(tOf(d))} min</text>`;
  }
  const trend = j.trend ? TREND[j.trend.label] : '';
  return `<svg viewBox="0 0 320 262" class="journey-svg" role="img" aria-label="${esc(`Rain ${f.dist(D)} to the ${compass16(j.bearing)}, moving toward you at ${f.speed(j.speedKmh)}, arriving in about ${Math.round(j.eta)} minutes`)}">
    ${northArrow(34, 40, -j.bearing)}
    <text x="34" y="76" text-anchor="middle" class="jt dim">from ${esc(compass16(j.bearing))}</text>
    ${cloud(x, 40, 1, color)}
    <text x="${x + 38}" y="30" class="jt">${esc(WORD[j.category || 1] || 'Rain')}</text>
    ${trend ? `<text x="${x + 38}" y="46" class="jt ${j.trend.label === 'strengthening' ? 'hot' : 'dim'}">${esc(trend)}</text>` : ''}
    <text x="${x - 38}" y="38" text-anchor="end" class="jt">${esc(f.dist(D))}</text>
    <text x="${x - 38}" y="54" text-anchor="end" class="jt dim">now</text>
    <path d="M${x} ${yTop - 18}V${yYou - 16}" stroke="${color}" stroke-width="2" stroke-dasharray="4 5"/>
    <path d="M${x - 5} ${yYou - 24}l5 8 5-8" fill="none" stroke="${color}" stroke-width="2"/>
    <text x="${x + 12}" y="${yTop - 2}" class="jt dim">${Number.isFinite(j.speedKmh) ? `↓ ${esc(f.speed(j.speedKmh))}` : ''}</text>
    ${ticks}
    ${you(x, yYou + 6)}
    <text x="${x + 22}" y="${yYou + 10}" class="jt strong">YOU</text>
    <text x="${x - 22}" y="${yYou + 10}" text-anchor="end" class="jt strong">+${Math.round(j.eta)} min</text>
  </svg>`;
}

/** North-up scope around you (radius ~ 100 km, square-root distance scale out to 250 km). */
function scopeView(j, f, sat) {
  const cx = 160, cy = 128, R = 104;
  const rOf = (km) => R * Math.sqrt(Math.min(250, km) / 250);
  const at = (km, deg) => [cx + rOf(km) * Math.sin((deg * Math.PI) / 180), cy - rOf(km) * Math.cos((deg * Math.PI) / 180)];
  let rings = '';
  for (const km of [10, 50, 100, 250]) {
    const r = rOf(km);
    rings += `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="none" stroke="var(--line-2)" stroke-dasharray="${km === 250 ? '0' : '2 5'}"/>` +
      `<text x="${cx + 3}" y="${(cy - r + 11).toFixed(1)}" class="jt faint">${km}</text>`;
  }
  let body = '';
  let label = '';
  if (j.state === 'nearby') {
    const [x, y] = at(j.distKm, j.bearing);
    body += cloud(x, y, 0.62, 'var(--rain-1)');
    if (Number.isFinite(j.towardDeg) && j.speedKmh > 3) {
      const a = (j.towardDeg * Math.PI) / 180;
      const x2 = x + 30 * Math.sin(a), y2 = y - 30 * Math.cos(a);
      body += `<path d="M${x.toFixed(1)} ${y.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="var(--track)" stroke-width="2" marker-end="url(#jarrow)"/>`;
    }
    label = `Nearest rain ${f.dist(j.distKm)} ${compass16(j.bearing)}${Number.isFinite(j.towardDeg) && j.speedKmh > 3 ? `, moving ${compass16(j.towardDeg)}` : ''}`;
  } else if (j.state === 'developing') {
    body += `<circle cx="${cx}" cy="${cy}" r="${rOf(40).toFixed(1)}" fill="rgba(251,146,60,.07)" stroke="var(--alert)" stroke-dasharray="3 4"/>`;
    if (j.where) {
      const [x, y] = at(Math.max(4, j.where.distKm), j.where.bearing);
      body += cloud(x, y, 0.55, 'var(--alert)', ' class="pulse"');
      label = `Cloud tops climbing ${f.dist(j.where.distKm)} ${compass16(j.where.bearing)}`;
    } else if (j.official) {
      label = `Official ${String(j.official).toLowerCase()} warning for your area`;
    } else {
      label = 'Showers may form within ~40 km';
    }
  } else if (j.state === 'overhead') {
    body += cloud(cx, cy - 26, 0.9, 'var(--rain-2)');
    label = 'Rain over you now';
  } else if (j.state === 'clear') {
    label = 'No rain on radar within 250 km';
  } else {
    label = 'No usable radar here: forecast from the weather models';
  }
  return `<svg viewBox="0 0 320 262" class="journey-svg" role="img" aria-label="${esc(label)}">
    <defs><marker id="jarrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--track)"/></marker></defs>
    ${rings}
    <text x="${cx}" y="${cy - R - 6}" text-anchor="middle" class="jt">N</text>
    ${body}
    ${you(cx, cy)}
    <text x="${cx}" y="252" text-anchor="middle" class="jt">${esc(label)}</text>
  </svg>`;
}

const CHECK_LABEL = { official: 'Official warning', radar: 'Radar track', satellite: 'Satellite', models: 'Models', ai: 'AI' };

/** Full card body: diagram, the headline numbers under it, and which sources agree. */
export function journeyHTML(j, f, nowSec) {
  const clock = (m) => f.time(nowSec + m * 60);
  let svg, k1 = '', v1 = '', s1 = '', k2 = '', v2 = '';
  if (j.state === 'approaching') {
    svg = pathView(j, f, nowSec);
    k1 = 'Estimated arrival';
    v1 = j.etaLate - j.etaEarly >= 4 ? `${Math.round(j.etaEarly)}–${Math.round(j.etaLate)} min` : `${Math.round(j.eta)} min`;
    s1 = j.etaLate - j.etaEarly >= 4 ? `${clock(j.etaEarly)}–${clock(j.etaLate)}` : clock(j.eta);
    k2 = 'Chance it reaches you';
    v2 = `${Math.round(j.chance * 100)}%`;
  } else {
    svg = scopeView(j, f);
    if (j.state === 'overhead') {
      k1 = 'Dry again';
      v1 = j.endMin != null ? clock(j.endMin) : 'Not soon';
      s1 = j.endMin != null ? (j.endLate - j.endEarly >= 15 ? `between ${clock(j.endEarly)} and ${clock(j.endLate)}` : `in ${Math.round(j.endMin)} min`) : 'Rain likely for the next few hours';
    } else if (j.state === 'developing') {
      k1 = 'Timing';
      v1 = j.eta != null ? `From ~${clock(j.eta)}` : 'Uncertain';
      s1 = 'Storms forming nearby: they can start with little warning';
      k2 = 'Chance of rain, 5 h';
      v2 = `${Math.round((j.chance || 0) * 100)}%`;
    } else {
      k1 = j.state === 'nearby' ? 'Not heading here' : j.state === 'clear' ? 'No rain expected' : 'Models only';
      v1 = '—';
      s1 = j.state === 'noradar' ? 'Timing is less precise without radar' : 'Nothing on radar is moving toward you';
      k2 = 'Chance of rain, 5 h';
      v2 = `${Math.round((j.chance || 0) * 100)}%`;
    }
  }
  // Which sources back the expected rain. Shown only when rain is expected: for a dry forecast a row
  // of ✓/✗ would read as "something is wrong" rather than "nothing is coming".
  let checksHTML = '';
  if (j.state === 'approaching' || j.state === 'overhead' || j.state === 'developing') {
    const checks = Object.entries(CHECK_LABEL).filter(([k]) => k !== 'official' || (j.checks && j.checks.official)).map(([k, label]) => {
      const v = j.checks ? j.checks[k] : null;
      const name = k === 'radar' && v == null && j.state === 'developing' ? 'Radar: nothing to track yet' : label;
      const cls = v === true ? 'yes' : v === false ? 'no' : 'na';
      const mark = v === true ? '✓' : v === false ? '✗' : '–';
      const title = v === true ? 'supports this forecast' : v === false ? 'disagrees with this forecast' : 'nothing to check yet';
      return `<span class="ck ${cls}" title="${name}: ${title}"><b aria-hidden="true">${mark}</b>${esc(name)}<span class="sr"> ${title}</span></span>`;
    }).join('');
    checksHTML = `<div class="checks">${checks}<p class="ck-key">✓ supports the rain forecast · ✗ disagrees · – nothing to check yet</p></div>`;
  }
  return `${svg}
    <dl class="readout journey-nums">
      <div><dt>${esc(k1)}</dt><dd>${esc(v1)}<span class="s">${esc(s1)}</span></dd></div>
      ${k2 ? `<div><dt>${esc(k2)}</dt><dd>${esc(v2)}</dd></div>` : '<div></div>'}
    </dl>
    ${checksHTML}`;
}
