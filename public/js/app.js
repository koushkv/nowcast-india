// UI controller: location, refresh cycle, rendering, radar animation, alerts.
import { runForecast, briefing } from './engine.js';
import { RadarMap, RADAR_LEGEND, CHANCE_GRADIENT } from './map.js';
import { drawNextHour } from './charts.js';
import { loadUnits, saveUnits, makeFormat, timeFormatter } from './format.js';
import { compass16, compassWords, rateCategory, nextFrame } from './util.js';
import { pinVariable, pinWindDir, setRelayBase } from './nwp.js';
import { setRadarRelay } from './radar.js';
import { Scorecard } from './scorecard.js';
import { loadModel } from './ai.js';
import { journeyHTML } from './journey.js';
import { matchAlerts, isStormAlert, isRainAlert, languageName, issuerName, areaLabel } from './alerts.js';

const $ = (id) => document.getElementById(id);
const LOC_KEY = 'nowcast.location.v1';
const PREF_KEY = 'nowcast.prefs.v1';
const REFRESH_MS = 5 * 60 * 1000;
const STALE_MS = 12 * 60 * 1000;
const scorecard = new Scorecard();

// The forecast covers India (and the radar/AI grid around it).
const INDIA = { latMin: 6, latMax: 37.5, lonMin: 67.5, lonMax: 98 };
const inIndia = (lat, lon) => lat >= INDIA.latMin && lat <= INDIA.latMax && lon >= INDIA.lonMin && lon <= INDIA.lonMax;
const DEFAULT_PLACE = [28.6139, 77.209, 'New Delhi'];
const DEFAULT_TZ = 'Asia/Kolkata';

const state = {
  lat: null, lon: null, name: '', units: loadUnits(), prefs: loadPrefs(),
  result: null, fmt: null, frameIdx: 0, framesMeta: [], playing: false, playTimer: null,
  runId: 0, running: false, lastRun: 0, lastOk: 0, failed: false, nhHover: null, alerted: '', source: '', mapMode: 'radar',
  admin: null, alertsData: null,
};

function loadPrefs() {
  try { return { alert: 'off', ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; } catch { return { alert: 'off' }; }
}
function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(state.prefs)); } catch { /* ignore */ } }

// ---------- caching fetch (models update hourly; avoid re-downloading every refresh) ----------
const memo = new Map();
async function cachedFetch(url, init) {
  const u = String(url);
  const ttl = u.includes('open-meteo.com') ? 12 * 60 * 1000 : u.includes('weather-maps.json') ? 50 * 1000 : 0;
  if (ttl) {
    const hit = memo.get(u);
    if (hit && Date.now() - hit.t < ttl) return new Response(hit.body.slice(0), { status: 200, headers: { 'content-type': hit.type } });
  }
  const res = await fetch(u, init);
  if (ttl && res.ok) {
    const body = await res.clone().arrayBuffer();
    memo.set(u, { t: Date.now(), body, type: res.headers.get('content-type') || 'application/json' });
    if (memo.size > 40) memo.delete(memo.keys().next().value);
  }
  return res;
}

// ---------- forecast computation (Web Worker, main-thread fallback) ----------
let worker = null; // null = not created yet, false = unavailable in this browser
let workerSeq = 0;
function getWorker() {
  if (worker === false) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  } catch {
    worker = false;
  }
  return worker || null;
}
function computeForecast(lat, lon, onStage) {
  // parameters learned from this device's checked forecasts at this spot (neutral until trained)
  let tune = { calib: null, skill: {} };
  try { tune = scorecard.params(lat, lon); } catch (e) { console.error('Nowcast: scorecard params failed', e); }
  const calib = tune.calib;
  const skill = tune.skill;
  const w = getWorker();
  const onMain = async () => {
    let ai = null;
    try { ai = await loadModel(`${location.origin}/ai`); } catch { /* no model */ }
    const r = await runForecast({ lat, lon, calib, skill, ai, fetchImpl: cachedFetch, onStage, satBase: location.origin });
    const m = (ai && ai.metrics) || null;
    r.aiStatus = {
      model: !!(ai && ai.model), version: ai && ai.model ? ai.model.man.version : null,
      status: m ? m.status : null, updated: m ? m.updated : null, trainDays: m ? m.trainDays : null,
      samples: m ? (m.trainSamples ?? m.samples ?? null) : null,
    };
    return r;
  };
  if (!w) return onMain();
  return new Promise((resolve, reject) => {
    const id = ++workerSeq;
    let settled = false;
    let timer = null;
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
    };
    const onMsg = (e) => {
      const m = e.data || {};
      if (m.id !== id || settled) return;
      if (m.type === 'stage') onStage(m.name, m.info);
      else if (m.type === 'done') { cleanup(); resolve(m.result); }
      else if (m.type === 'error') { cleanup(); reject(new Error(m.message)); }
    };
    const onErr = (ev) => {
      if (ev && ev.preventDefault) ev.preventDefault();
      if (settled) return;
      cleanup();
      // the worker could not start (old browser) or crashed: compute on the main thread from now on
      try { w.terminate(); } catch { /* ignore */ }
      worker = false;
      onMain().then(resolve, reject);
    };
    timer = setTimeout(() => onErr(null), 120000);
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    w.postMessage({ id, lat, lon, calib, skill });
  });
}

// ---------- header: station clock and data status ----------
let clockFmt = null;
let clockKey = '';
function tzLabel(tz) {
  if (/^Asia\/(Kolkata|Calcutta)$/.test(tz)) return 'IST';
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName');
    return part ? part.value : '';
  } catch { return ''; }
}
function tickClock() {
  const tz = (state.result && state.result.timezone) || DEFAULT_TZ;
  const key = `${tz}|${state.units.clock}`;
  if (key !== clockKey) {
    clockKey = key;
    clockFmt = timeFormatter(state.units.clock, tz, true);
    $('clock-tz').textContent = tzLabel(tz);
  }
  $('clock').textContent = clockFmt.format(new Date());
  if (!state.running && !state.failed && state.lastOk && Date.now() - state.lastOk > STALE_MS) setLive('stale', 'Delayed');
}
function setLive(st, text) {
  const el = $('live');
  if (el.dataset.state === st && $('live-text').textContent === text) return;
  el.dataset.state = st;
  $('live-text').textContent = text;
}
function liveFromResult(r) {
  if (!r.radar && !r.nwp) return setLive('offline', 'No data');
  if (!r.radar) return setLive('stale', 'Models only');
  if (r.radar.stale || r.radar.ageMin > 30) return setLive('stale', 'Radar delayed');
  return setLive('live', 'Live');
}

// ---------- map ----------
let radarMap = null;
function initMap() {
  radarMap = new RadarMap($('map'), { onPick: (lat, lon) => setLocation(lat, lon, { source: 'map' }), dark: true });
  $('legend').innerHTML = RADAR_LEGEND.map(([n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join('') +
    '<span><i style="background:repeating-linear-gradient(45deg,rgba(150,150,150,.55) 0 2px,transparent 2px 5px)"></i>No radar</span>' +
    '<span><i style="background:var(--track);height:2px;vertical-align:3px"></i>Rain path (1 h)</span>';
}

// ---------- location ----------
function parseHash() {
  const m = /^#(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(location.hash || '');
  if (!m) return null;
  const lat = +m[1], lon = +m[2];
  if (Math.abs(lat) > 85 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}
function initialLocation() {
  const h = parseHash();
  if (h && inIndia(h.lat, h.lon)) return { ...h, source: 'link' };
  try {
    const saved = JSON.parse(localStorage.getItem(LOC_KEY) || 'null');
    if (saved && Number.isFinite(saved.lat) && inIndia(saved.lat, saved.lon)) return { ...saved, source: 'saved' };
  } catch { /* ignore */ }
  return { lat: DEFAULT_PLACE[0], lon: DEFAULT_PLACE[1], name: DEFAULT_PLACE[2], source: 'default' };
}

function setLocation(lat, lon, { name = '', source = 'user', zoom } = {}) {
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  if (!inIndia(lat, lon)) {
    showNotice('This forecast covers India only. Pick a place in India: tap the map, search, or use your location when you are in India.');
    if (state.lat == null) { [lat, lon, name] = DEFAULT_PLACE; source = 'default'; } else { if (radarMap) radarMap.setPin(state.lat, state.lon); return; }
  }
  state.lat = +lat.toFixed(4);
  state.lon = +lon.toFixed(4);
  state.name = name;
  state.source = source;
  try { localStorage.setItem(LOC_KEY, JSON.stringify({ lat: state.lat, lon: state.lon, name })); } catch { /* ignore */ }
  const hash = `#${state.lat.toFixed(4)},${state.lon.toFixed(4)}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
  radarMap.setPin(state.lat, state.lon);
  if (source !== 'map' && source !== 'drag') radarMap.setView(state.lat, state.lon, zoom || 8);
  renderLocation();
  state.admin = null;
  lookupPlace(state.lat, state.lon, !name);
  refreshAlerts(false);
  refresh(true);
}

function renderLocation() {
  $('loc-name').textContent = state.name || 'Dropped pin';
  const ns = state.lat >= 0 ? 'N' : 'S', ew = state.lon >= 0 ? 'E' : 'W';
  const r = state.result;
  const elev = r && r.lat === state.lat && r.lon === state.lon && Number.isFinite(r.elevation) ? ` · ${Math.round(r.elevation)} m` : '';
  $('loc-sub').textContent = `${Math.abs(state.lat).toFixed(3)}°${ns}  ${Math.abs(state.lon).toFixed(3)}°${ew}${elev}`;
  document.title = state.name ? `${state.name.split(',')[0]} · Nowcast` : 'Nowcast · Rain forecast for India';
}

let geoTimer = null;
const PLACE_KEY = 'nowcast.places.v1';
function placeCache() {
  try { return JSON.parse(localStorage.getItem(PLACE_KEY) || '{}') || {}; } catch { return {}; }
}
/** Name and administrative areas (mandal/taluk, district, state) of a point, cached per ~1 km. */
function lookupPlace(lat, lon, needName) {
  clearTimeout(geoTimer);
  const ck = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = placeCache()[ck];
  if (hit && hit.admin && Date.now() - hit.t < 30 * 86400000) { applyPlace(hit, lat, lon, needName); return; }
  geoTimer = setTimeout(async () => {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=12&accept-language=en`;
      const j = await (await fetch(url)).json();
      const a = j.address || {};
      const place = a.city || a.town || a.village || a.suburb || a.hamlet || a.municipality || a.county || a.state_district || a.state || j.name;
      const region = a.state && a.state !== place ? a.state : a.country;
      const entry = {
        t: Date.now(),
        name: [place, region].filter(Boolean).join(', '),
        admin: { state: a.state || '', district: a.state_district || '', sub: a.county || a.municipality || '', town: a.city || a.town || a.village || a.suburb || a.hamlet || '' },
      };
      try {
        const all = placeCache();
        all[ck] = entry;
        const keys = Object.keys(all).sort((x, y) => all[x].t - all[y].t);
        for (const k of keys.slice(0, Math.max(0, keys.length - 40))) delete all[k];
        localStorage.setItem(PLACE_KEY, JSON.stringify(all));
      } catch { /* ignore */ }
      applyPlace(entry, lat, lon, needName);
    } catch { /* keep coordinates */ }
  }, 350);
}
function applyPlace(entry, lat, lon, needName) {
  if (state.lat !== lat || state.lon !== lon) return;
  state.admin = entry.admin;
  if (needName && entry.name) {
    state.name = entry.name;
    renderLocation();
    try { localStorage.setItem(LOC_KEY, JSON.stringify({ lat: state.lat, lon: state.lon, name: state.name })); } catch { /* ignore */ }
  }
  renderAlerts();
}

// ---------- official warnings (NDMA SACHET, through api/alerts.js) ----------
let alertsAt = 0;
async function refreshAlerts(force) {
  if (!force && Date.now() - alertsAt < 170 * 1000) return;
  alertsAt = Date.now();
  try {
    const r = await fetch('/api/alerts');
    if (!r.ok) throw new Error(String(r.status));
    const d = await r.json();
    if (!Array.isArray(d.alerts)) throw new Error('no alerts list');
    state.alertsData = d;
  } catch {
    if (!state.alertsData || state.alertsData.failed) state.alertsData = { failed: true, alerts: [] };
  }
  renderAlerts();
}
/** Warnings in force that cover this place, and others in the same state. Null when unknown. */
function officialMatches() {
  const d = state.alertsData;
  if (!d || d.failed || !state.admin) return null;
  const now = Date.now();
  return matchAlerts(d.alerts.filter((a) => !a.expires || Date.parse(a.expires) > now), state.admin);
}
const alertClock = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return state.fmt ? state.fmt.time(t / 1000) : new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};
function alertWhere(level, a) {
  if (level === 'local') return areaLabel(a);
  if (level === 'district') return `${(state.admin.district || 'your district').replace(/ District$/i, '')} district`;
  return state.admin.state || 'your state';
}
function renderAlertsBox() {
  const box = $('alerts');
  const m = officialMatches();
  if (!m) { box.hidden = true; box.innerHTML = ''; return m; }
  let html = m.here.map(({ alert: a, level }) => `<article class="alert" data-sev="${esc(a.severity)}">
      <div class="alert-top"><span>Official warning · ${esc(a.event || 'Weather')}${a.severity ? ` · ${esc(a.severity)}` : ''}</span><span class="until">${a.expires ? `until ${esc(alertClock(a.expires))}` : ''}</span></div>
      <p class="alert-h">${esc(a.headline)}</p>
      ${a.local && a.local.headline ? `<details class="alert-local"><summary>${esc(languageName(a.local.language) || 'Local language')}</summary>${esc(a.local.headline)}</details>` : ''}
      <p class="alert-meta">${esc(issuerName(a.sender))} · ${esc(alertWhere(level, a))} · via NDMA SACHET</p>
    </article>`).join('');
  if (!m.here.length) {
    const st = state.admin.state || 'your state';
    html = m.state.length
      ? `<details class="alerts-none"><summary>No official warnings for your area · ${m.state.length} elsewhere in ${esc(st)}</summary><ul>${m.state.slice(0, 15).map((a) => `<li>${esc(a.event || 'Warning')} · ${esc(areaLabel(a))}${a.expires ? ` · until ${esc(alertClock(a.expires))}` : ''}</li>`).join('')}</ul></details>`
      : '<p class="alerts-none">No official warnings for your area right now (NDMA SACHET).</p>';
  }
  box.innerHTML = html;
  box.hidden = false;
  return m;
}
function renderAlerts() {
  const m = renderAlertsBox();
  if (state.result) {
    safely('insight', () => renderInsight(state.result));
    safely('statusbar', () => renderStatusBar(state.result));
  }
  notifyOfficial(m);
}
const NOTIFIED_KEY = 'nowcast.notified.v1';
function notifyOfficial(m) {
  if (!m || !m.here.length || state.prefs.alert !== 'on') return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || '[]'); } catch { /* ignore */ }
  for (const { alert: a } of m.here) {
    if (seen.includes(a.id)) continue;
    seen.push(a.id);
    const title = `${a.event || 'Weather'} warning`;
    const body = `${a.headline}${a.expires ? ` Until ${alertClock(a.expires)}.` : ''} (${issuerName(a.sender)})`;
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then((reg) => reg.showNotification(title, { body, tag: `nowcast-official-${a.id}`, icon: 'icons/icon-192.png' }));
      } else {
        // eslint-disable-next-line no-new
        new Notification(title, { body, tag: `nowcast-official-${a.id}` });
      }
    } catch { /* notifications unsupported */ }
  }
  try { localStorage.setItem(NOTIFIED_KEY, JSON.stringify(seen.slice(-100))); } catch { /* ignore */ }
}

async function searchPlaces(q) {
  const list = $('search-results');
  list.innerHTML = '<li class="hint">Searching…</li>';
  try {
    const params = `name=${encodeURIComponent(q)}&count=8&language=${encodeURIComponent((navigator.language || 'en').slice(0, 2))}&format=json&countryCode=IN`;
    let j;
    try {
      const res = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`);
      if (!res.ok) throw new Error(String(res.status));
      j = await res.json();
    } catch {
      j = await (await fetch(`/api/om?u=geocode&${params}`)).json();
    }
    const rs = j.results || [];
    if (!rs.length) { list.innerHTML = '<li class="hint">No places found. Try a nearby town, or tap the map.</li>'; return; }
    list.innerHTML = '';
    for (const r of rs) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = '<b></b> <small></small>';
      b.querySelector('b').textContent = r.name;
      b.querySelector('small').textContent = [r.admin1, r.country].filter(Boolean).join(', ');
      b.addEventListener('click', () => {
        closePanels();
        setLocation(r.latitude, r.longitude, { name: [r.name, r.admin1 || r.country].filter(Boolean).join(', '), source: 'search', zoom: 8 });
      });
      li.appendChild(b);
      list.appendChild(li);
    }
  } catch {
    list.innerHTML = '<li class="hint">Search is unavailable right now. Tap the map to place the marker instead.</li>';
  }
}

function useMyLocation() {
  if (!navigator.geolocation) { showNotice('This browser cannot share your location. Tap the map or search instead.'); return; }
  const btn = $('gps-btn');
  btn.classList.add('spin');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.classList.remove('spin');
      setLocation(pos.coords.latitude, pos.coords.longitude, { source: 'gps', zoom: 9 });
    },
    (err) => {
      btn.classList.remove('spin');
      showNotice(err.code === 1
        ? 'Location access is blocked. Allow it in your browser settings, or tap the map to place the marker.'
        : 'Could not find your location. Tap the map or search instead.');
    },
    { enableHighAccuracy: false, timeout: 12000, maximumAge: 120000 },
  );
}

// ---------- forecast cycle ----------
async function refresh(force = false) {
  if (state.lat == null) return;
  if (!force && Date.now() - state.lastRun < REFRESH_MS - 5000) return;
  const id = ++state.runId;
  state.running = true;
  state.lastRun = Date.now();
  $('refresh-btn').classList.add('spin');
  const newPlace = !state.result || state.result.lat !== state.lat || state.result.lon !== state.lon;
  if (newPlace || state.failed) setLive('loading', 'Updating');
  if (newPlace) {
    setStatus('loading', 'Updating');
    $('title').textContent = 'Checking the radar…';
    $('detail').textContent = 'Getting live radar and the latest weather models for this spot.';
    $('approach').hidden = true;
  }
  await nextFrame();
  try {
    const r = await computeForecast(state.lat, state.lon, (name, info) => {
      if (id !== state.runId || !newPlace) return;
      if (name === 'radar' && info.state === 'loading' && info.progress != null) {
        $('detail').textContent = `Loading radar images… ${Math.round(info.progress * 100)}%`;
      } else if (name === 'radar' && info.state === 'processing') {
        $('detail').textContent = 'Working out where the rain is heading…';
      }
    });
    if (id !== state.runId) return;
    state.result = r;
    state.lastOk = Date.now();
    state.failed = false;
    safely('scorecard', () => scorecard.ingest(r));
    renderAll(true);
    liveFromResult(r);
    checkAlert();
  } catch (e) {
    if (id !== state.runId) return;
    state.failed = true;
    setLive('offline', 'Offline');
    setStatus('loading', 'Offline');
    $('title').textContent = 'Can’t get a forecast right now';
    $('detail').textContent = (e && e.message) || 'The weather data services could not be reached.';
    showNotice('Check your internet connection, then tap refresh.');
  } finally {
    if (id === state.runId) {
      state.running = false;
      $('refresh-btn').classList.remove('spin');
    }
  }
}

function setStatus(st, text) {
  $('status').dataset.state = st;
  $('status-text').textContent = text;
}
function showNotice(html, isHtml = false) {
  const n = $('notice');
  if (!html) { n.hidden = true; return; }
  if (isHtml) n.innerHTML = html; else n.textContent = html;
  n.hidden = false;
}

// ---------- rendering ----------
function renderAll(resetFrame = false) {
  const r = state.result;
  if (!r) return;
  state.fmt = makeFormat(state.units, r.timezone);
  clockKey = '';
  safely('location', renderLocation);
  safely('summary', () => renderSummary(r));
  safely('alerts', renderAlertsBox);
  safely('insight', () => renderInsight(r));
  safely('hours', () => renderHours(r));
  safely('about', () => renderAbout(r));
  safely('track', () => renderTrack(r));
  safely('map', () => renderMap(r, resetFrame));
  safely('statusbar', () => renderStatusBar(r));
  safely('charts', redrawCharts);
}

function safely(name, fn) {
  try {
    fn();
  } catch (e) {
    // keep the rest of the page working; report the problem in the console
    console.error(`Nowcast: ${name} failed`, e);
  }
}

const minutesFmt = (r) => (m) => state.fmt.time(r.nowSec + m * 60);
const INTENSITY = ['', 'Light', 'Moderate', 'Heavy', 'Very heavy'];
const RAIN_VAR = ['--rain-1', '--rain-1', '--rain-2', '--rain-3', '--rain-4'];

/** One readout value: big number, optional unit and a second line. */
function setReadout(id, value, { unit = '', sub = '', tone = '' } = {}) {
  const el = $(id);
  el.className = tone;
  el.innerHTML = `${esc(value)}${unit ? `<span class="u">${esc(unit)}</span>` : ''}${sub ? `<span class="s">${esc(sub)}</span>` : ''}`;
}
function inMin(m) {
  if (m <= 1) return 'now';
  if (m < 60) return `in ${Math.round(m)} min`;
  const h = Math.floor(m / 60), mm = Math.round(m - h * 60);
  return `in ${h} h${mm ? ` ${mm} min` : ''}`;
}

function renderSummary(r) {
  const f = state.fmt;
  const s = r.summary;
  const b = briefing(s, r.nc, minutesFmt(r), {
    dist: (km) => f.dist(km),
    dir: (deg) => compassWords(deg),
    speed: (kmh) => f.speed(kmh),
  });
  const thunder = s.thunderMax >= 0.5 && b.state !== 'dry';
  const text = thunder ? 'Thunderstorms possible' : { dry: 'Dry', chance: 'Showers possible', incoming: 'Rain on the way', raining: 'Raining' }[b.state];
  setStatus(thunder ? 'thunder' : b.state, text);
  $('title').textContent = b.title;
  $('detail').textContent = b.detail;
  // where the rain is: the same measured position the rain journey and radar panel show
  const jy = r.insight && r.insight.journey;
  const approach = jy && jy.state === 'approaching' && Number.isFinite(jy.speedKmh)
    ? `The rain is about ${f.dist(jy.distKm)} to the ${compassWords(jy.bearing)}, moving toward you at ${f.speed(jy.speedKmh)}.`
    : b.approach;
  $('approach').textContent = approach;
  $('approach').hidden = !approach;

  // ---- rain readouts ----
  const at = (m) => f.time(r.nowSec + m * 60);
  if (s.rainingNow) {
    setReadout('r-now', f.rate(s.rateNow), { unit: f.rateUnit(), sub: INTENSITY[Math.max(1, s.categoryNow)], tone: 'wet' });
  } else {
    setReadout('r-now', f.rate(0), { unit: f.rateUnit(), sub: 'Dry', tone: 'dim' });
  }
  let nh = 0;
  for (let i = 0; i <= 12; i++) nh = Math.max(nh, r.blended.prob[0][i]);
  setReadout('s-hour', String(Math.round(nh * 100)), { unit: '%', sub: nh >= 0.5 ? 'Likely' : nh >= 0.2 ? 'Possible' : 'Unlikely', tone: nh >= 0.5 ? 'wet' : nh < 0.1 ? 'dim' : '' });
  if (s.rainingNow) {
    $('r-start-label').textContent = 'Stops';
    if (s.endMin != null) setReadout('r-start', at(s.endMin), { sub: inMin(s.endMin) });
    else setReadout('r-start', '—', { sub: 'Not within 5 h', tone: 'dim' });
  } else {
    $('r-start-label').textContent = 'Starts';
    if (s.startMin != null) setReadout('r-start', at(s.startMin), { sub: inMin(s.startMin), tone: 'wet' });
    else setReadout('r-start', '—', { sub: 'None expected', tone: 'dim' });
  }
  if (s.peakRate >= 0.3 && s.peakMin != null) {
    setReadout('r-peak', f.rate(s.peakRate), { unit: f.rateUnit(), sub: `${INTENSITY[Math.max(1, rateCategory(s.peakRate))]} · ${at(s.peakMin)}`, tone: rateCategory(s.peakRate) >= 3 ? 'hot' : '' });
  } else {
    setReadout('r-peak', '—', { sub: 'No rain expected', tone: 'dim' });
  }
  const [tv, tu] = f.amount(s.total5h).split(' ');
  setReadout('s-total', tv, { unit: tu || '', sub: 'Most likely', tone: s.total5h < 0.1 ? 'dim' : '' });
  if (r.nwp && Number.isFinite(s.thunderMax)) {
    setReadout('r-thunder', String(Math.round(s.thunderMax * 100)), { unit: '%', sub: s.thunderMax >= 0.25 ? 'Possible' : 'Unlikely', tone: s.thunderMax >= 0.25 ? 'hot' : 'dim' });
  } else {
    setReadout('r-thunder', '—', { sub: 'Needs models', tone: 'dim' });
  }

  // ---- conditions (weather-model consensus for the current hour) ----
  if (r.nwp) {
    const v = (k) => pinVariable(r.nwp, k, 0).mean;
    const t = v('temp'), fl = v('feels'), rh = v('rh'), cl = v('cloud'), ws = v('wind'), gu = v('gust');
    const dir = pinWindDir(r.nwp, 0);
    setReadout('s-temp', f.tempNum(t), { unit: f.tempUnit() });
    setReadout('s-feels', f.tempNum(fl), { unit: f.tempUnit(), tone: Number.isFinite(fl) && fl - t >= 4 ? 'hot' : '' });
    setReadout('c-rh', Number.isFinite(rh) ? String(Math.round(rh)) : '–', { unit: '%' });
    setReadout('c-cloud', Number.isFinite(cl) ? String(Math.round(cl)) : '–', { unit: '%' });
    setReadout('c-wind', `${Number.isFinite(dir) && ws >= 2 ? `${compass16(dir)} ` : ''}${f.wind(ws)}`, { unit: f.windUnit() });
    setReadout('c-gust', f.wind(gu), { unit: f.windUnit() });
  } else {
    for (const id of ['s-temp', 's-feels', 'c-rh', 'c-cloud', 'c-wind', 'c-gust']) setReadout(id, '—', { tone: 'dim' });
  }

  const conf = s.confidence || '';
  $('confidence').textContent = conf ? `Confidence · ${conf}` : '';
  $('confidence').dataset.level = conf.toLowerCase();
  const radarT = r.radar ? f.time(r.nc.tLatest) : null;
  $('updated').textContent = `Updated ${f.time(r.nowSec)}${radarT ? ` · radar image ${radarT}` : ''} · refreshes every 5 min`;

  // ---- notices ----
  const notes = [];
  if (!r.radar) notes.push('Live radar is unavailable right now, so this forecast uses weather models only and timing is less precise.');
  else if (r.radar.coverageNear < 0.5) notes.push('Weather radar does not cover this spot well, so the forecast relies more on weather models.');
  else if (r.radar.stale) notes.push('The radar for this area has not updated recently, so the forecast relies more on weather models.');
  else if (r.radar.ageMin > 25) notes.push(`The latest radar image is ${Math.round(r.radar.ageMin)} minutes old.`);
  if (!r.nwp) {
    const err = (r.errors.find(([k]) => k === 'models') || [])[1];
    const limit = err && /limit|429/i.test(err.message || '');
    notes.push(limit
      ? 'The free weather-model service has hit its usage limit for your network (mobile and campus networks share one address among many people). Showing the radar-only forecast for the next 3 hours; it retries automatically every few minutes.'
      : 'Weather models are unreachable right now, so this is a radar-only forecast for the next 3 hours. It retries automatically every few minutes.');
  }
  if (state.source === 'default' && !state.dismissedDefault) {
    showNotice(`Showing ${esc(state.name || 'a nearby city')}. <button class="btn" type="button" id="notice-gps">Use my location</button> or tap the map to move the marker.`, true);
    const g = $('notice-gps');
    if (g) g.addEventListener('click', () => { state.dismissedDefault = true; useMyLocation(); });
  } else {
    showNotice(notes.join(' '));
  }
}

function slice(b, n) {
  const out = { times: b.times.slice(0, n), w: b.w.slice(0, n), q10: b.q10.slice(0, n), q50: b.q50.slice(0, n), q90: b.q90.slice(0, n), mean: b.mean.slice(0, n) };
  out.prob = b.prob.map((a) => a.slice(0, n));
  return out;
}

function redrawCharts() {
  const r = state.result;
  if (!r || !state.fmt) return;
  const f = state.fmt;
  drawNextHour($('nexthour-canvas'), slice(r.blended, 13), f, { hover: state.nhHover });
  const P = r.blended.prob[0];
  if (state.nhHover != null) {
    const i = state.nhHover;
    const cat = rateCategory(r.blended.q50[i]);
    $('nh-readout').textContent = `${f.time(r.blended.times[i])} · ${f.pct(P[i])}${P[i] >= 0.2 && cat ? ` · ${INTENSITY[cat].toLowerCase()}` : ''}`;
  } else {
    let mi = 0;
    for (let i = 0; i <= 12; i++) if (P[i] > P[mi]) mi = i;
    $('nh-readout').textContent = P[mi] >= 0.1 ? `Max ${f.pct(P[mi])} at ${f.time(r.blended.times[mi])}` : 'No rain expected';
  }
}

function arrowSvg(fromDeg) {
  const rot = (fromDeg + 180) % 360; // point where the wind blows to
  return `<svg viewBox="0 0 12 12" style="transform:rotate(${rot}deg)" aria-hidden="true"><path d="M6 1 L10 10 L6 8 L2 10 Z" fill="currentColor"/></svg>`;
}

/**
 * Next 5 hours on the clock's half hours: "Now" up to the next :00 or :30, then every 30 minutes.
 * Each row shows the most likely rain type, the highest chance and any thunder risk in its window.
 */
function renderHours(r) {
  const f = state.fmt;
  const b = r.blended;
  const n = b.times.length;
  let k0 = 1; // first half-hour mark after now (the 5-minute grid always lands on one)
  while (k0 < 6 && b.times[k0] % 1800 !== 0) k0++;
  const starts = [0];
  for (let i = k0; i <= 60 && i < n; i += 6) starts.push(i);
  const conf = (r.insight && r.insight.hours) || [];
  let html = '';
  let group = -1;
  for (let row = 0; row < starts.length; row++) {
    const i = starts[row];
    const hr = Math.max(0, Math.min(4, Math.floor((b.times[i] - r.nowSec) / 3600)));
    if (hr !== group) {
      group = hr;
      const c = conf[hr];
      const span = hr === 0 ? 'Now → +1 h' : `+${hr} → +${hr + 1} h`;
      if (c) {
        const bars = Math.max(1, Math.min(5, Math.round(c.score * 5)));
        const meter = Array.from({ length: 5 }, (_, k) => `<i class="${k < bars ? 'on' : ''}"></i>`).join('');
        html += `<tr class="grp"><th colspan="5" scope="rowgroup">${span}<span class="cf ${c.level.toLowerCase().replace(/[^a-z]+/g, '-')}">${esc(c.level)} · ${esc(c.led)} ${meter}</span></th></tr>`;
      } else {
        html += `<tr class="grp"><th colspan="5" scope="rowgroup">${span}</th></tr>`;
      }
    }
    const end = Math.min(row + 1 < starts.length ? starts[row + 1] : i + 6, n);
    let p = 0, q50 = 0, ts = 0;
    for (let k = i; k < end; k++) {
      p = Math.max(p, b.prob[0][k]);
      q50 = Math.max(q50, b.q50[k]);
      ts = Math.max(ts, b.thunder[k]);
    }
    const cat = Math.max(1, rateCategory(q50));
    const color = `var(${RAIN_VAR[cat]})`;
    const word = p >= 0.2 ? INTENSITY[cat] : '';
    let temp = '–', wind = '–';
    if (r.nwp) {
      temp = f.temp(pinVariable(r.nwp, 'temp', i).mean);
      const dir = pinWindDir(r.nwp, i);
      wind = `${Number.isFinite(dir) ? arrowSvg(dir) : ''}${f.wind(pinVariable(r.nwp, 'wind', i).mean)}`;
    }
    const label = i === 0 ? 'Now' : f.time(b.times[i]);
    const pct = Math.round(p * 100);
    html += `<tr${i === 0 ? ' class="now"' : ''}>` +
      `<td class="t">${label}</td>` +
      `<td class="rain${word ? '' : ' none'}">${word ? `<i style="background:${color}"></i>${word}` : '—'}${ts >= 0.25 ? `<span class="ts" title="Thunderstorm chance">TS ${Math.round(ts * 100)}%</span>` : ''}</td>` +
      `<td><div class="ch"><span class="bar"><span style="width:${pct}%;background:${p >= 0.2 ? color : '#3a3a3a'}"></span></span><b${p < 0.1 ? ' class="low"' : ''}>${pct}%</b></div></td>` +
      `<td class="num">${temp}</td>` +
      `<td class="num w">${wind}</td></tr>`;
  }
  $('hours').innerHTML = html;
}

// ---------- explanations: mode, why, rain journey, radar, storm watch ----------
const MODE_TEXT = {
  tracking: ['Radar tracking', {
    overhead: 'Rain is over you now and is being followed on radar. End times are usually right to within 15–30 minutes.',
    approaching: 'Rain already on radar is moving toward you. This is the most predictable case: arrival is usually right to within 10–20 minutes.',
  }],
  developing: ['Convective development', {
    satellite: 'No rain on radar is heading here, but satellite shows storm clouds growing nearby. Radar cannot track a storm before it forms, so rain could start with little warning and timing is uncertain.',
    models: 'No rain on radar is heading here yet, but the air is unstable and the models expect showers to form. Radar cannot track storms before they form, so timing is uncertain.',
  }],
  models: ['Model-led', {
    'no-radar': 'There is no usable radar view of this spot, so the forecast comes from the weather models. Timing can be off by an hour or more.',
    later: 'Nothing on radar is moving toward you; the rain in this forecast comes from the weather models and is expected later. Timing can be off by an hour or more.',
  }],
  settled: ['Settled', { dry: 'No rain on radar is moving toward you, nothing is developing, and the models agree it stays dry.' }],
};
const CONF_WORD = { High: 'high', Medium: 'moderate', Low: 'low' };
const linkOut = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)} ↗</a>`;

function renderInsight(r) {
  const f = state.fmt;
  const ins = r.insight;
  if (!ins) return;
  const s = r.summary;
  const at = (m) => f.time(r.nowSec + m * 60);
  const dir = (deg) => compass16(deg);

  // official warnings covering this place (lightning, thunderstorms, heavy rain, cyclone)
  const off = officialMatches();
  const offHere = off ? off.here : [];
  const offWx = offHere.filter((h) => isStormAlert(h.alert) || isRainAlert(h.alert));
  const offStorm = offHere.filter((h) => isStormAlert(h.alert));

  // prediction mode: an official storm or rain warning means weather is expected here even when
  // radar shows nothing heading this way yet
  let modeKey = ins.mode.mode, modeText;
  if (offWx.length && (modeKey === 'settled' || modeKey === 'models')) {
    const a = offWx[0].alert;
    modeKey = 'developing';
    modeText = `An official ${(a.event || 'weather').toLowerCase()} warning covers your area (${issuerName(a.sender)}). Radar shows nothing heading here yet, but storms can start with little warning.`;
  }
  const [modeName, texts] = MODE_TEXT[modeKey] || ['', {}];
  $('mode').hidden = !modeName;
  $('mode').dataset.mode = modeKey;
  $('mode-v').textContent = modeName;
  $('mode-d').textContent = modeText || texts[ins.mode.why] || Object.values(texts)[0] || '';

  // why: headline chance + reasons, each tagged with its source
  const j = ins.journey;
  let nh = 0;
  for (let i = 0; i <= 12; i++) nh = Math.max(nh, r.blended.prob[0][i]);
  let big, lbl;
  if (s.rainingNow) { big = 'Raining'; lbl = 'now, on radar'; }
  else if (j.state === 'approaching') { big = `${Math.round(j.chance * 100)}%`; lbl = 'chance it reaches you'; }
  else if (s.startMin != null && s.startMin > 60) { big = `${Math.round(s.maxP * 100)}%`; lbl = `chance by ${at(s.maxPMin)}`; }
  else { big = `${Math.round(nh * 100)}%`; lbl = 'chance in the next hour'; }
  const conf = CONF_WORD[s.confidence] || 'moderate';
  $('why-top').innerHTML = `<span class="big${s.rainingNow || nh >= 0.5 || j.state === 'approaching' ? ' wet' : ''}">${esc(big)}</span><span class="lbl">${esc(lbl)} · ${conf} confidence</span>`;

  const items = [];
  const add = (tone, html, tag) => items.push({ tone, html, tag });
  for (const { alert: a, level } of offHere.slice(0, 2)) {
    add('warn', `Official warning: <b>${esc(a.event || 'weather')}</b> for ${esc(alertWhere(level, a))}${a.expires ? ` until ${esc(alertClock(a.expires))}` : ''}`, 'Official');
  }
  const rd = r.radar;
  if (!rd) add('warn', 'No usable radar picture right now', 'Radar');
  else if (s.rainingNow) add('yes', 'Rain is falling here now', 'Radar');
  else if (j.state === 'approaching') add('yes', `Rain area <b>${esc(f.dist(j.distKm))} ${dir(j.bearing)}</b> is moving toward you`, 'Radar');
  else if (ins.nearestNow && ins.nearestNow.distKm <= 250) add('no', `Nearest rain on radar: <b>${esc(f.dist(ins.nearestNow.distKm))} ${dir(ins.nearestNow.bearing)}</b>, not heading here`, 'Radar');
  else add('no', 'No rain on radar within 250 km', 'Radar');
  if (ins.trend) {
    const t = ins.trend;
    const word = t.label === 'strengthening' ? 'strengthening ↑' : t.label === 'weakening' ? 'weakening ↓' : 'steady';
    add(t.label === 'strengthening' ? 'warn' : 'yes', `Radar trend: <b>${word}</b> (${t.changePct > 0 ? '+' : ''}${t.changePct}% in ${t.minutes} min)`, 'Radar');
  }
  const rainNear = s.rainingNow || j.state === 'approaching' || (ins.nearestNow && ins.nearestNow.distKm <= 150);
  if (rd && rd.motion.speedKmh > 3 && rainNear) {
    if (rd.motion.vectors >= 3) add('yes', `Moving toward the <b>${dir(rd.motion.toDeg)}</b> at <b>${esc(f.speed(rd.motion.speedKmh))}</b>`, 'Radar');
    else if (rd.steer) add('no', `Too little rain to track; wind ~3 km up would carry it toward the ${dir((rd.steer.fromDeg + 180) % 360)} at ${esc(f.speed(rd.steer.speedKmh))}`, 'Models');
  }
  if (!s.rainingNow && s.startMin != null) {
    if (j.state === 'approaching') {
      const win = j.etaLate - j.etaEarly >= 4 ? `${Math.round(j.etaEarly)}–${Math.round(j.etaLate)} min` : `${Math.round(j.eta)} min`;
      add('yes', `Estimated arrival: <b>${win}</b> (${at(j.etaEarly)}–${at(j.etaLate)})`, 'Blend');
    } else {
      add('yes', `Most likely from <b>${at(s.startMin)}</b>${s.startLate - s.startEarly >= 20 ? ` (between ${at(s.startEarly)} and ${at(s.startLate)})` : ''}`, 'Blend');
    }
  }
  if (ins.models && ins.models.n) {
    const m = ins.models;
    if (m.rainy === 0) add('ok', `All ${m.n} weather models keep it dry for the next 3 h`, 'Models');
    else add(m.rainy >= m.n / 2 ? 'yes' : 'no', `<b>${m.rainy} of ${m.n}</b> weather models show rain here within 3 h${m.firstTime ? `, from ~${f.time(m.firstTime)}` : ''}`, 'Models');
  }
  if (rd && rd.ai && rd.ai.used && Array.isArray(rd.ai.pin) && Number.isFinite(rd.ai.pin[2])) {
    add(rd.ai.pin[2] >= 0.5 ? 'yes' : 'no', `AI model (trained on Indian radar): <b>${Math.round(rd.ai.pin[2] * 100)}%</b> chance at +30 min`, 'AI');
  }
  const sat = ins.sat;
  if (sat && sat.ok) {
    if (ins.satVerdict === 'storm' && sat.where) {
      add('warn', `Satellite: cloud tops climbing ${sat.trend === 'rapid' ? 'fast ' : ''}<b>${esc(f.dist(sat.where.distKm))} ${dir(sat.where.bearing)}</b> (${sat.coolingK15} °C in 15 min)`, 'Satellite');
    } else if (ins.satVerdict === 'high-cloud' && sat.where) {
      add('no', `Satellite: cloud tops cooling ${esc(f.dist(sat.where.distKm))} ${dir(sat.where.bearing)}, but the air is stable: most likely high cloud spreading in, not a storm`, 'Satellite');
    } else if (sat.trend === 'decaying') add('no', 'Satellite: storm clouds nearby are weakening', 'Satellite');
    else if (sat.trend === 'clear') add('ok', 'Satellite: no storm clouds within 50 km', 'Satellite');
    else add('no', `Satellite: no growing storm clouds within 50 km${sat.cloudShare >= 0.3 ? ` (cloud tops down to ${sat.coldestC} °C)` : ''}`, 'Satellite');
  }
  if (ins.thunder && (ins.thunder.level === 'Moderate' || ins.thunder.level === 'High')) {
    add('warn', `Thunderstorm potential: <b>${ins.thunder.level.toLowerCase()}</b> (CAPE ${ins.thunder.cape.toLocaleString('en-IN')} J/kg)`, 'Models');
  }
  if (ins.boost) add('warn', 'Chance raised because storm clouds are forming nearby', 'Blend');
  const rc = ins.radarConf;
  if (rd && rc && rc.level === 'Low') {
    const nr = ins.radars && ins.radars[0];
    if (rc.limit === 'beam' && nr) add('warn', `Radar view is limited here: the nearest IMD radar (${esc(nr.name)}) is ${esc(f.dist(nr.distKm))} away and its beam passes ~${nr.beamKm.toFixed(1)} km up`, 'Radar');
    else if (rc.limit === 'age') add('warn', `Radar images are ${Math.round(rd.ageMin)} min old`, 'Radar');
    else add('warn', 'Weather radar barely covers this spot', 'Radar');
  }
  const ICON = { yes: '●', no: '○', warn: '!', ok: '✓' };
  $('why-list').innerHTML = items.map((x) => `<li class="${x.tone}"><span class="ic" aria-hidden="true">${ICON[x.tone] || '·'}</span><span>${x.html}</span><span class="tag">${esc(x.tag)}</span></li>`).join('');
  const nsrc = new Set(items.map((x) => x.tag).filter((t) => t !== 'Blend')).size;
  $('why-src').textContent = `${nsrc} source${nsrc === 1 ? '' : 's'}`;

  // rain journey
  let jy = { ...j, checks: { ...j.checks, official: offWx.length ? true : null } };
  if (offWx.length && (j.state === 'clear' || j.state === 'nearby')) {
    jy = { ...jy, state: 'developing', where: null, official: offWx[0].alert.event || 'weather' };
  }
  $('journey').innerHTML = journeyHTML(jy, f, r.nowSec);
  $('journey-src').textContent = jy.official ? 'Official warning' : ({ approaching: 'Rain on its way', overhead: 'Raining now', developing: 'Storms may form', nearby: 'Rain nearby', clear: 'All clear', noradar: 'Models only' }[jy.state] || '');

  // radar (IMD network)
  const rows = [];
  const kv = (k, v, small = '', cls = '') => rows.push(`<div><dt>${esc(k)}</dt><dd class="${cls}">${v}${small ? `<small>${small}</small>` : ''}</dd></div>`);
  const levelCls = { High: 'ok', Moderate: 'warn', Low: 'hot', None: 'hot' };
  const why = { beam: 'beam passes high over this spot', age: 'radar images are old', coverage: 'little radar coverage here', unavailable: 'radar unavailable' };
  kv('Radar confidence', esc(rc.level), rc.level === 'High' ? 'good coverage, fresh images' : why[rc.limit] || '', levelCls[rc.level]);
  if (rd) kv('Observation age', `${Math.round(rd.ageMin)} min`, `latest image ${f.time(r.nc.tLatest)}`, rd.ageMin > 25 ? 'warn' : '');
  const nr = ins.radars || [];
  if (nr[0]) kv('Nearest IMD radar', `${esc(nr[0].name)} · ${esc(f.dist(nr[0].distKm))} ${dir(nr[0].bearing)}`, `beam ~${nr[0].beamKm.toFixed(1)} km above you · ${linkOut(nr[0].url, 'IMD image')}`);
  if (nr[1]) kv('Next radar', `${esc(nr[1].name)} · ${esc(f.dist(nr[1].distKm))} ${dir(nr[1].bearing)}`, `beam ~${nr[1].beamKm.toFixed(1)} km · ${linkOut(nr[1].url, 'IMD image')}`);
  if (r.nc) {
    const nst = ins.nearestNow;
    kv('Nearest rain', nst && nst.distKm <= 250 ? `${esc(f.dist(nst.distKm))} ${dir(nst.bearing)}` : 'None within 250 km', nst && nst.distKm <= 250 ? 'now, moved on from the latest image' : '', nst && nst.distKm < 30 ? 'wet' : '');
    kv('Movement', rd.motion.speedKmh > 3 ? `toward ${dir(rd.motion.toDeg)} · ${esc(f.speed(rd.motion.speedKmh))}` : 'Little movement', rd.motion.vectors >= 3 ? `from ${rd.motion.vectors} tracked features` : 'too little rain to track; using upper wind');
    kv('Estimated arrival', j.state === 'approaching' ? `${Math.round(j.etaEarly)}–${Math.round(j.etaLate)} min` : s.rainingNow ? 'Raining now' : '—', j.state === 'approaching' ? `${at(j.etaEarly)}–${at(j.etaLate)}` : '', j.state === 'approaching' ? 'wet' : '');
    if (ins.trend) kv('Trend', ins.trend.label === 'strengthening' ? 'Strengthening ↑' : ins.trend.label === 'weakening' ? 'Weakening ↓' : 'Steady', `${ins.trend.changePct > 0 ? '+' : ''}${ins.trend.changePct}% rain in ${ins.trend.minutes} min`, ins.trend.label === 'strengthening' ? 'hot' : '');
  }
  $('radar-kv').innerHTML = rows.join('');
  $('rc-chip').textContent = `Confidence · ${rc.level}`;
  $('rc-chip').dataset.level = rc.level.toLowerCase();
  $('radar-note').textContent = `IMD Doppler weather radars, through RainViewer's composite (new image every 10 minutes). Radar confidence takes the weakest of coverage, image age and beam height.${nr[0] && nr[0].beamKm > 4 ? ` This far from a radar its lowest beam passes ~${nr[0].beamKm.toFixed(0)} km up, so low cloud and light rain can be invisible to it.` : ''}`;

  // storm watch: satellite, thunderstorm potential, lightning
  rows.length = 0;
  if (sat && sat.ok) {
    let T = { rapid: ['↑ Rapidly developing', 'hot'], developing: ['↑ Developing', 'hot'], steady: ['Steady', ''], decaying: ['↓ Weakening', ''], clear: ['No storm clouds', 'ok'] }[sat.trend];
    if (ins.satVerdict === 'high-cloud') T = ['High cloud spreading in', ''];
    kv('Cloud development', T[0], sat.where ? `${esc(f.dist(sat.where.distKm))} ${dir(sat.where.bearing)} · ${sat.coolingK15} °C in 15 min${ins.satVerdict === 'high-cloud' ? ' · stable air' : ''}` : 'within 50 km', T[1]);
    kv('Coldest cloud top', `${sat.coldestC} °C`, sat.coldestC <= -40 ? 'deep storm cloud (below −40 °C)' : sat.coldestC <= -10 ? 'cloud above freezing level' : 'low or no cloud', sat.coldestC <= -40 ? 'hot' : '');
    kv('Satellite image', `${sat.ageMin} min old`, 'Meteosat-9 infrared, every 15 min');
  } else {
    kv('Cloud development', 'Unavailable', sat ? esc(sat.reason || '') : 'satellite not loaded', 'warn');
  }
  if (ins.thunder) {
    const th = ins.thunder;
    kv('Thunderstorm potential', th.level, `CAPE ${th.cape.toLocaleString('en-IN')} J/kg · ${Math.round(th.share * 100)}% of models`, th.level === 'High' || th.level === 'Moderate' ? 'hot' : '');
  }
  const blitz = linkOut(`https://map.blitzortung.org/#8/${r.lat.toFixed(2)}/${r.lon.toFixed(2)}`, 'Live map (Blitzortung)');
  if (offStorm.length) {
    const a = offStorm[0].alert;
    kv('Lightning', 'Official warning', `${esc(issuerName(a.sender))} · ${esc(a.severity || '')}${a.expires ? ` · until ${esc(alertClock(a.expires))}` : ''} · ${blitz}`, 'hot');
  } else if (off) {
    const n = off.state.filter(isStormAlert).length;
    kv('Lightning', 'No warning for your area', `${n ? `${n} lightning or thunder warning${n === 1 ? '' : 's'} elsewhere in ${esc(state.admin.state)} · ` : ''}${blitz}`);
  } else {
    kv('Lightning', state.alertsData && state.alertsData.failed ? 'Warnings unavailable' : 'Checking warnings…', blitz, state.alertsData && state.alertsData.failed ? 'warn' : '');
  }
  $('storm-kv').innerHTML = rows.join('');
  let devLabel = sat && sat.ok ? (ins.satVerdict === 'storm' ? 'Developing' : ins.satVerdict === 'high-cloud' ? 'Quiet' : { rapid: 'Developing', developing: 'Developing', steady: 'Quiet', decaying: 'Easing', clear: 'Quiet' }[sat.trend]) : '—';
  if (offStorm.length) devLabel = 'Warning';
  $('sw-chip').textContent = devLabel;
  $('sw-chip').dataset.level = devLabel === 'Developing' || devLabel === 'Warning' ? 'low' : devLabel === 'Quiet' || devLabel === 'Easing' ? 'high' : 'none';
  $('storm-note').textContent = 'Lightning and thunderstorm warnings: official alerts from IMD and state disaster authorities through NDMA SACHET, matched to your mandal and district. Satellite: Meteosat-9 (EUMETSAT) infrared, about 30 minutes behind real time; cloud tops that cool fast mark storms forming before radar sees rain. Blitzortung is a volunteer network, not for safety decisions.';
}

/** Bottom status line: where every input stands right now. */
function renderStatusBar(r) {
  const f = state.fmt;
  const items = [];
  if (r.radar) {
    const rd = r.radar;
    const late = rd.stale || rd.ageMin > 25;
    items.push(`Radar <b class="${late ? 'warn' : ''}">${f.time(r.nc.tLatest)}</b> · ${Math.round(rd.ageMin)} min old`);
    items.push(`${rd.frames.length} frames`);
    const m = rd.motion;
    if (m.vectors >= 3 && m.speedKmh > 3) items.push(`Rain moving <b>${compass16(m.toDeg)} ${f.speed(m.speedKmh)}</b>`);
  } else {
    items.push('Radar <b class="warn">unavailable</b>');
  }
  if (r.nwp) {
    const ens = r.nwp.ensembles.reduce((a, e) => a + e.members.length, 0);
    items.push(`Models <b>${r.nwp.models.length}</b>${ens ? ` · ensemble <b>${ens}</b>` : ''}`);
  } else {
    items.push('Models <b class="warn">offline</b>');
  }
  const st = r.aiStatus || {};
  const ai = r.radar && r.radar.ai;
  if (ai && ai.used) items.push(`AI <b class="ok">on</b> · ${Math.round(ai.trust60 * 100)}% at 1 h`);
  else if (st.status === 'collecting') items.push('AI <b>learning</b>');
  else if (st.model) items.push('AI <b>standby</b>');
  const offSb = officialMatches();
  if (offSb && offSb.here.length) items.push(`Warnings <b class="warn">${offSb.here.length}</b>`);
  items.push(`Updated <b>${f.time(r.nowSec)}</b>`);
  $('sb-data').innerHTML = items.map((x) => `<span>${x}</span>`).join('');
}

function renderAbout(r) {
  const f = state.fmt;
  const facts = [];
  if (r.radar) {
    const rd = r.radar;
    const span = Math.round((rd.frames[rd.frames.length - 1].time - rd.frames[0].time) / 60);
    const cov = rd.coverageNear >= 0.9 ? 'good' : rd.coverageNear >= 0.5 ? 'partial' : 'poor';
    facts.push(['Radar', `Live radar from RainViewer: ${rd.frames.length} images over the past ${span} minutes. Latest image ${f.time(r.nc.tLatest)} (${Math.round(rd.ageMin)} min old). Radar coverage near you is ${cov}.${rd.stale ? ' The radar here has stopped updating.' : ''}`]);
    const m = rd.motion;
    if (m.vectors >= 3) {
      facts.push(['Rain movement', `Rain is moving toward the ${compassWords(m.toDeg)} at ${f.speed(m.speedKmh)} (measured from ${m.vectors} tracked rain features).`]);
    } else if (rd.steer) {
      facts.push(['Rain movement', `Too little rain on radar to track. Using the wind about 3 km up instead: from the ${compassWords(rd.steer.fromDeg)} at ${f.speed(rd.steer.speedKmh)}.`]);
    } else {
      facts.push(['Rain movement', 'Too little rain on radar to track.']);
    }
    const ts = r.nc.tau, tl = r.nc.tauLarge;
    if (Number.isFinite(ts)) {
      const life = (t) => (t >= 240 ? 'over 4 hours' : t >= 90 ? `about ${Math.round(t / 30) / 2} hours` : `about ${Math.round(t / 5) * 5} minutes`);
      const kind = ts < 45 ? 'Showers here are changing quickly' : ts < 120 ? 'Rain here is changing steadily' : 'Rain here is steady and organised';
      facts.push(['How fast it changes', `${kind}: individual showers keep their shape for ${life(ts)}${Number.isFinite(tl) ? `, rain areas for ${life(Math.max(tl, ts))}` : ''}.`]);
    }
    const st = r.aiStatus || {};
    const ai = rd.ai;
    if (ai && ai.used) {
      facts.push(['AI model', `A neural network trained on ${st.trainDays ? `${st.trainDays} days of ` : ''}Indian radar (updated ${st.updated ? st.updated.slice(0, 10) : 'recently'}) also predicts the rain here. Based on its last test it counts for about ${Math.round(ai.trust60 * 100)}% of the radar forecast at one hour ahead.`]);
    } else if (ai) {
      facts.push(['AI model', 'The AI model ran, but it has not yet beaten simple radar extrapolation in testing, so it is not used yet.']);
    } else if (st.model && rd.aiNote === 'frames') {
      facts.push(['AI model', 'The AI model needs the last hour of radar at 10-minute steps. Some of those images are missing right now, so it was skipped this time.']);
    } else if (st.model) {
      facts.push(['AI model', 'The AI model only covers India; it is not used for this location.']);
    } else if (st.status === 'collecting') {
      facts.push(['AI model', `Learning: Indian radar is being collected${st.samples ? ` (${st.samples} usable times so far)` : ''}. The first model is trained once there is enough data, usually after a few days.`]);
    }
    let lastRadar = -1;
    for (let i = 0; i <= 60; i++) if (r.blended.w[i] >= 0.5) lastRadar = i;
    facts.push(['Radar or models', lastRadar > 0 ? `The radar projection leads the forecast until about ${f.time(r.blended.times[lastRadar])}; after that the weather models lead.` : 'The weather models lead the whole forecast right now.']);
  } else {
    facts.push(['Radar', 'Unavailable for this update, so the forecast relies on the weather models.']);
  }
  if (r.nwp) {
    const names = r.nwp.models.map((m) => m.label).join(', ');
    facts.push(['Weather models', `${r.nwp.models.length} models (${names}), each checked at your spot and at 8 points 25 km around it.${r.nwp.models.some((m) => m.hires) ? ' Includes high-resolution regional models.' : ''}`]);
    const ens = r.nwp.ensembles;
    if (ens.length) facts.push(['Extra model runs', `${ens.reduce((a, e) => a + e.members.length, 0)} runs from ${ens.map((e) => `${e.label} (${e.members.length})`).join(', ')}, used to measure uncertainty.`]);
    const informative = r.nwp.models.some((m) => m.verify && m.verify.informative);
    facts.push(['Live check', r.verification && r.verification.length
      ? (informative ? 'Each model’s last hour was compared with the radar. Models that matched count for more.' : 'There was no rain in the last hour to check the models against.')
      : 'Not possible for this update (needs an hour of good radar data).']);
    if (Number.isFinite(r.elevation)) facts.push(['Location', `${Math.round(r.elevation)} m above sea level · ${r.timezone || ''}`]);
  }
  const issues = r.errors.filter(([k]) => k !== 'steer').map(([k, e]) => `${k}: ${e && e.message ? e.message.replace(/https?:\/\/\S+/g, '').slice(0, 80) : e}`);
  if (issues.length) facts.push(['Data problems', issues.join(' · ')]);
  $('facts').innerHTML = facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');

  const box = $('models');
  if (!r.nwp) { box.innerHTML = ''; return; }
  const ms = [...r.nwp.models].sort((a, b2) => b2.weight - a.weight);
  const maxW = Math.max(...ms.map((m) => m.weight)) || 1;
  box.innerHTML = '<h3>Weight of each model right now</h3>' + ms.map((m) => {
    let check = '<span class="check">not checked</span>';
    if (m.verify && m.verify.informative) {
      const e = m.verify.error;
      check = e < 0.06 ? '<span class="check good">matched radar</span>' : e < 0.25 ? '<span class="check">partly matched</span>' : '<span class="check poor">missed</span>';
    } else if (m.verify) {
      check = '<span class="check">no recent rain</span>';
    }
    return `<div class="model-row"><span>${esc(m.label)}</span><span class="w"><i style="width:${Math.round((m.weight / maxW) * 100)}%"></i></span>${check}</div>`;
  }).join('');
}

function renderTrack(r) {
  const st = scorecard.stats(r.lat, r.lon);
  const pr = scorecard.params(r.lat, r.lon);
  const pct = (v) => `${Math.round(v * 100)}%`;
  const enough = st.nHour >= 20;
  $('sc-aside').textContent = st.n ? `${st.n} checks${st.days ? ` · ${st.days} day${st.days === 1 ? '' : 's'}` : ''}` : '';
  if (!enough) {
    $('sc-summary').textContent = st.n
      ? `Checking its own forecasts at this spot: ${st.n} checked so far. The track record appears after 20 checks of the next hour.`
      : 'Each forecast is checked later against what the radar actually saw here. Keep the page open, or come back within two hours, and the results build up here.';
    $('sc-stats').hidden = true;
    $('sc-leads').innerHTML = '';
  } else {
    const tenths = Math.round(st.accuracyHour * 10);
    $('sc-summary').textContent = `For the next hour it has been right ${tenths} times out of 10 here.${st.rainShare < 0.05 ? ' It has hardly rained during these checks, so this mostly reflects dry calls.' : ''}`;
    $('sc-stats').hidden = false;
    $('sc-acc').textContent = pct(st.accuracyHour);
    $('sc-sr').textContent = st.warningsTrue == null ? '–' : pct(st.warningsTrue);
    $('sc-pod').textContent = st.rainCaught == null ? '–' : pct(st.rainCaught);
    $('sc-leads').innerHTML = st.byLead.filter((b) => b.n >= 10).map((b) => {
      const label = b.upTo <= 60 ? `${b.from}–${b.upTo} min` : `${b.from / 60}–${b.upTo / 60} h`;
      return `<div class="sc-row"><span>${label}</span><span class="sc-bar"><i style="width:${Math.round(b.right * 100)}%"></i></span><span>${pct(b.right)}</span></div>`;
    }).join('');
  }
  const learning = [];
  if (pr.calib) learning.push('the chance of rain has been recalibrated for this spot');
  if (Object.keys(pr.skill).length) learning.push('weather models that do better here get more weight');
  let text;
  if (learning.length) text = `Learning from these checks: ${learning.join(', and ')}.`;
  else text = st.n >= 15 ? 'No adjustment needed yet: the checks so far do not show a consistent bias.' : 'Once enough forecasts are checked, the forecast tunes itself to this spot.';
  if (st.betterThanModels != null) {
    text += st.betterThanModels > 0
      ? ` So far it is ${Math.round(st.betterThanModels * 100)}% more accurate than the weather models alone.`
      : ' So far it has not beaten the weather models alone here.';
  }
  $('sc-learn').textContent = text;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- radar map + animation ----------
function renderMap(r, resetFrame) {
  if (!r.radar) {
    const lbl = $('frame-label');
    lbl.textContent = 'Radar unavailable';
    lbl.dataset.kind = '';
    $('play-btn').disabled = true;
    $('scrub-marks').innerHTML = '';
    return;
  }
  $('play-btn').disabled = false;
  const rd = r.radar;
  const frames = [
    ...rd.frames.map((fr) => ({ time: fr.time, rate: fr.rate, kind: 'obs' })),
    ...rd.forecast.map((fr) => ({ time: fr.time, rate: fr.rate, known: fr.known, kind: 'fc' })),
  ];
  state.framesMeta = frames;
  radarMap.setFrames(frames, rd.block, rd.cov, rd.w, rd.h, rd.probField);
  $('chance-note').textContent = rd.ai && rd.ai.trustHour > 0
    ? 'Chance of rain at each place at some point in the next hour, from the AI model trained on Indian radar, blended with the projected movement of the rain.'
    : 'Chance of rain at each place at some point in the next hour, from the projected movement of the rain on radar.';
  const slider = $('frame-slider');
  slider.max = String(frames.length - 1);
  // timeline: grey = observed radar, blue = forecast; marks at the oldest image, the latest, the end
  const n = frames.length, nObs = rd.frames.length;
  const pos = (k) => (n > 1 ? (k / (n - 1)) * 100 : 0);
  slider.style.setProperty('--split', `${pos(nObs - 1).toFixed(1)}%`);
  const f = state.fmt;
  $('scrub-marks').innerHTML = `<span style="left:0">${f.time(frames[0].time)}</span>` +
    `<span class="now" style="left:${pos(nObs - 1).toFixed(1)}%">Latest</span>` +
    `<span style="left:100%">${f.time(frames[n - 1].time)}</span>`;
  if (resetFrame || state.frameIdx >= frames.length) state.frameIdx = nObs - 1;
  if (state.mapMode === 'chance') setMapMode('chance');
  else showFrame(state.frameIdx);
  const m = rd.motion;
  radarMap.setTrack(r.lat, r.lon, (m.toDeg + 180) % 360, m.speedKmh);
}

function showFrame(k) {
  const r = state.result;
  if (!r || !state.framesMeta[k]) return;
  if (state.mapMode === 'chance') return;
  state.frameIdx = k;
  radarMap.showFrame(k);
  const fr = state.framesMeta[k];
  const f = state.fmt;
  const nObs = r.radar.frames.length;
  let label;
  if (fr.kind === 'obs') {
    label = k === nObs - 1 ? `Radar ${f.time(fr.time)} · latest` : `Radar ${f.time(fr.time)} · ${Math.round((r.nowSec - fr.time) / 60)} min ago`;
  } else {
    const ahead = Math.round((fr.time - r.nowSec) / 60);
    label = `Forecast ${f.time(fr.time)}${ahead > 0 ? ` · in ${ahead} min` : ''}`;
  }
  const lbl = $('frame-label');
  lbl.textContent = label;
  lbl.dataset.kind = fr.kind;
  $('frame-slider').value = String(k);
}

function setMapMode(mode) {
  state.mapMode = mode;
  document.querySelectorAll('#map-mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === mode)));
  const chance = mode === 'chance';
  $('map').classList.toggle('chance-mode', chance);
  $('radar-controls').hidden = chance;
  $('legend').hidden = chance;
  $('chance-legend').hidden = !chance;
  if (chance) {
    togglePlay(false);
    radarMap.showChance();
    const r = state.result;
    const lbl = $('frame-label');
    lbl.textContent = r && r.radar ? `Next hour from ${state.fmt.time(r.nowSec)}` : 'Radar unavailable';
    lbl.dataset.kind = 'fc';
  } else if (state.result && state.result.radar) {
    showFrame(state.frameIdx);
  }
}

function togglePlay(force) {
  state.playing = force ?? !state.playing;
  const btn = $('play-btn');
  btn.setAttribute('aria-pressed', String(state.playing));
  btn.setAttribute('aria-label', state.playing ? 'Pause radar animation' : 'Play radar animation');
  clearTimeout(state.playTimer);
  if (!state.playing) return;
  const step = () => {
    if (!state.playing) return;
    const n = state.framesMeta.length;
    if (!n) return;
    let k = state.frameIdx + 1;
    if (k >= n) k = 0;
    showFrame(k);
    const nObs = state.result && state.result.radar ? state.result.radar.frames.length : 0;
    const hold = k === nObs - 1 ? 1100 : k === n - 1 ? 1400 : 380;
    state.playTimer = setTimeout(step, hold);
  };
  state.playTimer = setTimeout(step, 200);
}

// ---------- alerts ----------
function checkAlert() {
  if (state.prefs.alert !== 'on' || !state.result) return;
  const s = state.result.summary;
  if (s.rainingNow || s.startMin == null || s.startMin > 20) return;
  const key = `${state.lat},${state.lon},${Math.floor((state.result.nowSec + s.startMin * 60) / 1800)}`;
  if (state.alerted === key) return;
  state.alerted = key;
  const when = state.fmt.time(state.result.nowSec + s.startMin * 60);
  const body = `Rain expected around ${when} (${s.startMin <= 2 ? 'now' : `in ${s.startMin} min`}) at ${state.name || 'your location'}.`;
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then((reg) => reg.showNotification('Rain on the way', { body, tag: 'nowcast-rain', icon: 'icons/icon-192.png' }));
      } else {
        // eslint-disable-next-line no-new
        new Notification('Rain on the way', { body, tag: 'nowcast-rain' });
      }
    }
    if (navigator.vibrate) navigator.vibrate([120, 80, 120]);
  } catch { /* notifications unsupported */ }
}

// ---------- panels & controls ----------
function closePanels() {
  $('search-panel').hidden = true;
  $('settings-panel').hidden = true;
  $('loc-btn').setAttribute('aria-expanded', 'false');
  $('settings-btn').setAttribute('aria-expanded', 'false');
}
function togglePanel(panelId, btnId) {
  const p = $(panelId);
  const open = p.hidden;
  closePanels();
  p.hidden = !open;
  $(btnId).setAttribute('aria-expanded', String(open));
  return open;
}
function syncSettings() {
  document.querySelectorAll('#settings-panel .seg').forEach((seg) => {
    const k = seg.dataset.unit;
    const val = k === 'alert' ? state.prefs[k] : state.units[k];
    seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === val)));
  });
}

function bindUI() {
  $('loc-btn').addEventListener('click', () => {
    if (togglePanel('search-panel', 'loc-btn')) setTimeout(() => $('search-input').focus(), 30);
  });
  $('search-close').addEventListener('click', closePanels);
  $('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('search-input').value.trim();
    if (q.length >= 2) searchPlaces(q);
  });
  $('gps-btn').addEventListener('click', useMyLocation);
  $('refresh-btn').addEventListener('click', () => refresh(true));
  $('settings-btn').addEventListener('click', () => { togglePanel('settings-panel', 'settings-btn'); syncSettings(); });
  $('settings-close').addEventListener('click', closePanels);
  document.querySelectorAll('#settings-panel .seg').forEach((seg) => {
    seg.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const k = seg.dataset.unit;
      if (k === 'alert') {
        state.prefs.alert = b.dataset.v;
        savePrefs();
        if (b.dataset.v === 'on' && 'Notification' in window && Notification.permission === 'default') {
          try { await Notification.requestPermission(); } catch { /* ignore */ }
        }
        checkAlert();
      } else {
        state.units[k] = b.dataset.v;
        saveUnits(state.units);
        clockKey = '';
        tickClock();
        renderAll();
      }
      syncSettings();
    });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanels(); });
  document.addEventListener('pointerdown', (e) => {
    // close a popover when tapping outside it
    if (e.target.closest('.popover, #loc-btn, #settings-btn')) return;
    if (!$('search-panel').hidden || !$('settings-panel').hidden) closePanels();
  });
  const reset = $('sc-reset');
  let armed = false;
  reset.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      reset.textContent = 'Tap again to clear';
      setTimeout(() => { armed = false; reset.textContent = 'Clear history for this spot'; }, 4000);
      return;
    }
    armed = false;
    scorecard.clear(state.lat, state.lon);
    reset.textContent = 'Cleared';
    setTimeout(() => { reset.textContent = 'Clear history for this spot'; }, 2500);
    if (state.result) safely('track', () => renderTrack(state.result));
  });

  $('play-btn').addEventListener('click', () => togglePlay());
  $('chance-bar').style.background = CHANCE_GRADIENT;
  $('map-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) setMapMode(b.dataset.v);
  });
  $('frame-slider').addEventListener('input', (e) => { togglePlay(false); showFrame(+e.target.value); });

  const nh = $('nexthour-canvas');
  const nhMove = (e) => {
    if (!state.result) return;
    const rect = nh.getBoundingClientRect();
    state.nhHover = Math.max(0, Math.min(12, Math.floor(((e.clientX - rect.left) / rect.width) * 13)));
    redrawCharts();
  };
  nh.addEventListener('pointermove', nhMove);
  nh.addEventListener('pointerdown', nhMove);
  nh.addEventListener('pointerleave', () => { state.nhHover = null; redrawCharts(); });

  let rz = null;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { redrawCharts(); radarMap.invalidate(); }, 120); });
  window.addEventListener('hashchange', () => {
    const h = parseHash();
    if (h && (h.lat !== state.lat || h.lon !== state.lon)) setLocation(h.lat, h.lon, { source: 'link' });
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { refresh(false); refreshAlerts(false); } });
  setInterval(() => { if (document.visibilityState === 'visible') { refresh(false); refreshAlerts(false); } }, 60 * 1000);
  setInterval(() => { if (document.visibilityState === 'visible') tickClock(); }, 1000);
}

// ---------- start ----------
function boot() {
  // used only if the worker is unavailable and the forecast runs on the main thread
  setRelayBase(location.origin);
  setRadarRelay(location.origin);
  tickClock();
  if (typeof L === 'undefined') {
    $('title').textContent = 'The map failed to load';
    $('detail').textContent = 'Reload the page to try again.';
    setLive('offline', 'Error');
    return;
  }
  initMap();
  bindUI();
  syncSettings();
  const loc = initialLocation();
  setLocation(loc.lat, loc.lon, { name: loc.name || '', source: loc.source, zoom: 8 });
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
boot();
