// UI controller: location, refresh cycle, rendering, radar animation, alerts.
import { runForecast, briefing } from './engine.js';
import { RadarMap, RADAR_LEGEND, CHANCE_GRADIENT } from './map.js';
import { drawNextHour } from './charts.js';
import { loadUnits, saveUnits, makeFormat } from './format.js';
import { compassWords, rateCategory, nextFrame } from './util.js';
import { pinVariable, pinWindDir, setRelayBase } from './nwp.js';
import { setRadarRelay } from './radar.js';
import { Scorecard } from './scorecard.js';
import { loadModel } from './ai.js';

const $ = (id) => document.getElementById(id);
const LOC_KEY = 'nowcast.location.v1';
const PREF_KEY = 'nowcast.prefs.v1';
const REFRESH_MS = 5 * 60 * 1000;
const scorecard = new Scorecard();

// The forecast covers India (and the radar/AI grid around it).
const INDIA = { latMin: 6, latMax: 37.5, lonMin: 67.5, lonMax: 98 };
const inIndia = (lat, lon) => lat >= INDIA.latMin && lat <= INDIA.latMax && lon >= INDIA.lonMin && lon <= INDIA.lonMax;
const DEFAULT_PLACE = [28.6139, 77.209, 'New Delhi'];

const state = {
  lat: null, lon: null, name: '', nameFor: '', units: loadUnits(), prefs: loadPrefs(),
  result: null, fmt: null, frameIdx: 0, framesMeta: [], playing: false, playTimer: null,
  runId: 0, running: false, lastRun: 0, nhHover: null, alerted: '', source: '', mapMode: 'radar',
};

function loadPrefs() {
  try { return { theme: 'system', alert: 'off', ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; } catch { return { theme: 'system', alert: 'off' }; }
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
    const r = await runForecast({ lat, lon, calib, skill, ai, fetchImpl: cachedFetch, onStage });
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

// ---------- theme ----------
const darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
function isDark() {
  if (state.prefs.theme === 'dark') return true;
  if (state.prefs.theme === 'light') return false;
  return !!(darkQuery && darkQuery.matches);
}
function applyTheme() {
  const root = document.documentElement;
  if (state.prefs.theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', state.prefs.theme);
  if (radarMap) radarMap.setTheme(isDark());
  redrawCharts();
}

// ---------- map ----------
let radarMap = null;
function initMap() {
  radarMap = new RadarMap($('map'), { onPick: (lat, lon) => setLocation(lat, lon, { source: 'map' }), dark: isDark() });
  $('legend').innerHTML = RADAR_LEGEND.map(([n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join('') +
    '<span><i style="background:repeating-linear-gradient(45deg,rgba(128,136,148,.6) 0 2px,transparent 2px 5px)"></i>No radar</span>' +
    '<span><i style="background:var(--track);height:3px;vertical-align:3px"></i>Path of rain toward you (1 h)</span>';
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
  if (!name) reverseGeocode(state.lat, state.lon);
  refresh(true);
}

function renderLocation() {
  $('loc-name').textContent = state.name || 'Dropped pin';
  const ns = state.lat >= 0 ? 'N' : 'S', ew = state.lon >= 0 ? 'E' : 'W';
  $('loc-sub').textContent = `${Math.abs(state.lat).toFixed(3)}° ${ns}, ${Math.abs(state.lon).toFixed(3)}° ${ew}`;
  document.title = state.name ? `${state.name.split(',')[0]} · Nowcast` : 'Nowcast';
}

let geoTimer = null;
function reverseGeocode(lat, lon) {
  clearTimeout(geoTimer);
  geoTimer = setTimeout(async () => {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=12&accept-language=${encodeURIComponent(navigator.language || 'en')}`;
      const j = await (await fetch(url)).json();
      if (state.lat !== lat || state.lon !== lon) return;
      const a = j.address || {};
      const place = a.city || a.town || a.village || a.suburb || a.hamlet || a.municipality || a.county || a.state_district || a.state || j.name;
      const region = a.state && a.state !== place ? a.state : a.country;
      state.name = [place, region].filter(Boolean).join(', ') || '';
      renderLocation();
      try { localStorage.setItem(LOC_KEY, JSON.stringify({ lat: state.lat, lon: state.lon, name: state.name })); } catch { /* ignore */ }
    } catch { /* keep coordinates */ }
  }, 350);
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
    list.innerHTML = '<li class="hint">Search is unavailable right now. Tap the map to place the pin instead.</li>';
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
        ? 'Location access is blocked. Allow it in your browser settings, or tap the map to drop the pin.'
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
    safely('scorecard', () => scorecard.ingest(r));
    renderAll(true);
    checkAlert();
  } catch (e) {
    if (id !== state.runId) return;
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
  safely('summary', () => renderSummary(r));
  safely('strip', () => renderStrip(r));
  safely('about', () => renderAbout(r));
  safely('track', () => renderTrack(r));
  safely('map', () => renderMap(r, resetFrame));
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
  $('approach').textContent = b.approach;
  $('approach').hidden = !b.approach;

  // stats
  if (r.nwp) {
    const t = pinVariable(r.nwp, 'temp', 0).mean;
    const fl = pinVariable(r.nwp, 'feels', 0).mean;
    $('s-temp').textContent = f.temp(t);
    $('s-feels').textContent = Number.isFinite(fl) && Math.abs(fl - t) >= 1 ? `Feels like ${f.temp(fl)}` : '';
  } else {
    $('s-temp').textContent = '–';
    $('s-feels').textContent = '';
  }
  let nh = 0;
  for (let i = 0; i <= 12; i++) nh = Math.max(nh, r.blended.prob[0][i]);
  $('s-hour').textContent = f.pct(nh);
  $('s-total').textContent = f.amount(s.total5h);

  const radarT = r.radar ? f.time(r.nc.tLatest) : null;
  $('updated').textContent = `Updated ${f.time(r.nowSec)}${radarT ? ` · radar image ${radarT}` : ''}`;
  $('confidence').textContent = `Forecast confidence: ${s.confidence.toLowerCase()}`;

  // notices
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
    showNotice(`Showing ${state.name || 'a nearby city'}. <button class="btn" type="button" id="notice-gps">Use my location</button> or tap the map to move the pin.`, true);
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

const INTENSITY = ['', 'Light', 'Moderate', 'Heavy', 'Very heavy'];

function redrawCharts() {
  const r = state.result;
  if (!r || !state.fmt) return;
  const f = state.fmt;
  drawNextHour($('nexthour-canvas'), slice(r.blended, 13), f, { hover: state.nhHover });
  const P = r.blended.prob[0];
  if (state.nhHover != null) {
    const i = state.nhHover;
    const cat = rateCategory(r.blended.q50[i]);
    $('nh-readout').textContent = `${f.time(r.blended.times[i])}: ${f.pct(P[i])}${P[i] >= 0.2 && cat ? ` · ${INTENSITY[cat].toLowerCase()}` : ''}`;
  } else {
    let mi = 0;
    for (let i = 0; i <= 12; i++) if (P[i] > P[mi]) mi = i;
    $('nh-readout').textContent = P[mi] >= 0.1 ? `Highest ${f.pct(P[mi])} at ${f.time(r.blended.times[mi])}` : 'No rain expected';
  }
}

function dropIcon(color, chance) {
  const strong = chance >= 0.1;
  const fill = strong ? color : 'none';
  const op = strong ? (0.45 + 0.55 * Math.min(1, chance * 1.4)).toFixed(2) : '1';
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5C9 7 5.5 10.6 5.5 14.5a6.5 6.5 0 0 0 13 0C18.5 10.6 15 7 12 2.5z" fill="${fill}" fill-opacity="${op}" stroke="${strong ? color : 'var(--muted)'}" stroke-width="1.6"/></svg>`;
}
function arrowSvg(fromDeg) {
  const rot = (fromDeg + 180) % 360; // point where the wind blows to
  return `<svg viewBox="0 0 12 12" style="transform:rotate(${rot}deg)" aria-hidden="true"><path d="M6 1 L10 10 L6 8 L2 10 Z" fill="currentColor"/></svg>`;
}

function renderStrip(r) {
  const f = state.fmt;
  const b = r.blended;
  const cols = ['--rain-1', '--rain-1', '--rain-2', '--rain-3', '--rain-4'];
  let html = '';
  for (let i = 0; i <= 60; i += 6) {
    let p = 0, q50 = 0, ts = 0;
    for (let k = i; k < Math.min(i + 6, b.times.length); k++) {
      p = Math.max(p, b.prob[0][k]);
      q50 = Math.max(q50, b.q50[k]);
      ts = Math.max(ts, b.thunder[k]);
    }
    const cat = Math.max(1, rateCategory(q50));
    const color = `var(${cols[cat]})`;
    const word = p >= 0.2 ? INTENSITY[cat] : '';
    let temp = '–', wind = '';
    if (r.nwp) {
      temp = f.temp(pinVariable(r.nwp, 'temp', i).mean);
      const ws = pinVariable(r.nwp, 'wind', i).mean;
      const dir = pinWindDir(r.nwp, i);
      wind = `${Number.isFinite(dir) ? arrowSvg(dir) : ''}${f.wind(ws)} ${f.windUnit()}`;
    }
    const label = i === 0 ? 'Now' : f.time(b.times[i]);
    const aria = `${label}: ${f.pct(p)} chance of rain${word ? `, ${word.toLowerCase()}` : ''}${ts >= 0.25 ? ', thunderstorms possible' : ''}, ${temp}`;
    html += `<li class="slot" aria-label="${aria}">` +
      `<span class="t${i === 0 ? ' now' : ''}">${label}</span>` +
      dropIcon(color, p) +
      `<span class="p${p < 0.1 ? ' low' : ''}">${f.pct(p)}</span>` +
      `<span class="i">${word}</span>` +
      (ts >= 0.25 ? `<span class="ts">Thunder ${f.pct(ts)}</span>` : '') +
      `<span class="temp">${temp}</span>` +
      `<span class="w">${wind}</span></li>`;
  }
  $('strip').innerHTML = html;
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
  box.innerHTML = '<h3>How much each model counts right now</h3>' + ms.map((m) => {
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
  $('sc-aside').textContent = st.n ? `${st.n} checks${st.days ? ` over ${st.days} day${st.days === 1 ? '' : 's'}` : ''}` : '';
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
    $('frame-label').textContent = 'Radar unavailable';
    $('play-btn').disabled = true;
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
    ?'Chance of rain at each place at some point in the next hour, from the AI model trained on Indian radar, blended with the projected movement of the rain.'
    : 'Chance of rain at each place at some point in the next hour, from the projected movement of the rain on radar.';
  const slider = $('frame-slider');
  slider.max = String(frames.length - 1);
  if (resetFrame || state.frameIdx >= frames.length) state.frameIdx = rd.frames.length - 1;
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
    label = k === nObs - 1 ? `Latest · ${f.time(fr.time)}` : `${f.time(fr.time)} · ${Math.round((r.nowSec - fr.time) / 60)} min ago`;
  } else {
    const ahead = Math.round((fr.time - r.nowSec) / 60);
    label = `Forecast · ${f.time(fr.time)}${ahead > 0 ? ` (in ${ahead} min)` : ''}`;
  }
  $('frame-label').textContent = label;
  $('frame-slider').value = String(k);
}

function setMapMode(mode) {
  state.mapMode = mode;
  document.querySelectorAll('#map-mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === mode)));
  const chance = mode === 'chance';
  $('radar-controls').hidden = chance;
  $('legend').hidden = chance;
  $('chance-legend').hidden = !chance;
  if (chance) {
    togglePlay(false);
    radarMap.showChance();
    const r = state.result;
    $('frame-label').textContent = r && r.radar ? `Next hour from ${state.fmt.time(r.nowSec)}` : 'Radar unavailable';
  } else if (state.result && state.result.radar) {
    showFrame(state.frameIdx);
  }
}

function togglePlay(force) {
  state.playing = force ?? !state.playing;
  $('play-btn').textContent = state.playing ? 'Pause' : 'Play';
  $('play-btn').setAttribute('aria-label', state.playing ? 'Pause radar animation' : 'Play radar animation');
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
  const body = `Rain expected around ${when} (${s.startMin <= 2 ? 'now' : `in ${s.startMin} min`}) at ${state.name || 'your pin'}.`;
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
    const val = k === 'theme' || k === 'alert' ? state.prefs[k] : state.units[k];
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
      if (k === 'theme') { state.prefs.theme = b.dataset.v; savePrefs(); applyTheme(); }
      else if (k === 'alert') {
        state.prefs.alert = b.dataset.v;
        savePrefs();
        if (b.dataset.v === 'on' && 'Notification' in window && Notification.permission === 'default') {
          try { await Notification.requestPermission(); } catch { /* ignore */ }
        }
        checkAlert();
      } else {
        state.units[k] = b.dataset.v;
        saveUnits(state.units);
        renderAll();
      }
      syncSettings();
    });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanels(); });
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
  if (darkQuery && darkQuery.addEventListener) darkQuery.addEventListener('change', () => { if (state.prefs.theme === 'system') applyTheme(); });
  window.addEventListener('hashchange', () => {
    const h = parseHash();
    if (h && (h.lat !== state.lat || h.lon !== state.lon)) setLocation(h.lat, h.lon, { source: 'link' });
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(false); });
  setInterval(() => { if (document.visibilityState === 'visible') refresh(false); }, 60 * 1000);
}

// ---------- start ----------
function boot() {
  // used only if the worker is unavailable and the forecast runs on the main thread
  setRelayBase(location.origin);
  setRadarRelay(location.origin);
  if (typeof L === 'undefined') {
    $('title').textContent = 'The map failed to load';
    $('detail').textContent = 'Reload the page to try again.';
    return;
  }
  applyTheme();
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
