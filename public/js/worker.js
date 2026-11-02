// Runs the forecast engine off the main thread so the page stays smooth on phones.
import { runForecast } from './engine.js';

import { setRelayBase } from './nwp.js';
import { setRadarRelay } from './radar.js';
import { loadModel } from './ai.js';

// AI model trained nightly on Indian radar (public/ai/); reloaded every few hours
let ai = null;
let aiAt = 0;
async function getAI() {
  if (ai && Date.now() - aiAt < 3 * 3600 * 1000) return ai;
  try { ai = await loadModel(`${self.location.origin}/ai`); } catch { ai = { model: null, metrics: null }; }
  aiAt = Date.now();
  return ai;
}
function aiStatus(a) {
  const m = (a && a.metrics) || null;
  return {
    model: !!(a && a.model),
    version: a && a.model ? a.model.man.version : null,
    status: m ? m.status : null,
    updated: m ? m.updated : null,
    trainDays: m ? m.trainDays : null,
    samples: m ? (m.trainSamples ?? m.samples ?? null) : null,
  };
}

// Use this site's caching relays (/api/om, /api/rv) when a direct request is refused.
setRelayBase(self.location.origin);
setRadarRelay(self.location.origin);

// Caching: model answers for 20 minutes (models update hourly at most), radar tiles for 3 hours (they
// never change), the radar index for 50 seconds. Model answers and tiles also persist across page
// reloads in Cache Storage, so reopening the app does not spend the free services' quotas again.
const memo = new Map();
const STORE = 'nowcast-data-v1';
function policy(u) {
  if (u.includes('open-meteo.com') || u.includes('/api/om?')) return { ttl: 20 * 60 * 1000, persist: true };
  if (u.includes('weather-maps.json') || u.includes('p=index')) return { ttl: 50 * 1000, persist: false };
  if (u.includes('tilecache.rainviewer.com') || u.includes('/api/rv?p=v2')) return { ttl: 3 * 3600 * 1000, persist: true };
  return null;
}
async function store() {
  try { return self.caches ? await self.caches.open(STORE) : null; } catch { return null; }
}
async function cachedFetch(url, init) {
  const u = String(url);
  const pol = policy(u);
  if (!pol) return fetch(u, init);
  const hit = memo.get(u);
  if (hit && Date.now() - hit.t < pol.ttl) return new Response(hit.body.slice(0), { status: 200, headers: { 'content-type': hit.type } });
  const cache = pol.persist ? await store() : null;
  if (cache) {
    try {
      const r = await cache.match(u);
      const savedAt = r ? Number(r.headers.get('x-saved-at')) : 0;
      if (r && Date.now() - savedAt < pol.ttl) {
        const body = await r.arrayBuffer();
        memo.set(u, { t: savedAt, body, type: r.headers.get('content-type') || 'application/octet-stream' });
        return new Response(body.slice(0), { status: 200, headers: { 'content-type': r.headers.get('content-type') || '' } });
      }
    } catch { /* cache unavailable: fall through to the network */ }
  }
  const res = await fetch(u, init);
  if (res.ok) {
    const body = await res.clone().arrayBuffer();
    const type = res.headers.get('content-type') || 'application/octet-stream';
    memo.set(u, { t: Date.now(), body, type });
    if (memo.size > 120) memo.delete(memo.keys().next().value);
    if (cache) {
      cache.put(u, new Response(body.slice(0), { headers: { 'content-type': type, 'x-saved-at': String(Date.now()) } })).catch(() => {});
    }
  }
  return res;
}
async function pruneStore() {
  const cache = await store();
  if (!cache) return;
  try {
    for (const req of await cache.keys()) {
      const r = await cache.match(req);
      const pol = policy(req.url) || { ttl: 0 };
      if (!r || Date.now() - Number(r.headers.get('x-saved-at')) > pol.ttl) await cache.delete(req);
    }
  } catch { /* ignore */ }
}

/** Keep what the UI needs; hand big arrays over without copying. */
function pack(r) {
  const transfer = new Set();
  let nc = null;
  if (r.nc) {
    nc = { ...r.nc };
    delete nc.lattice;
    delete nc.memberRates;
    delete nc.probField; // sent once, inside radar
  }
  let radar = null;
  if (r.radar) {
    radar = { ...r.radar, motion: { ...r.radar.motion } };
    delete radar.motion.field;
    for (const f of radar.frames) transfer.add(f.rate.buffer);
    for (const f of radar.forecast) { transfer.add(f.rate.buffer); transfer.add(f.known.buffer); }
    if (radar.cov) transfer.add(radar.cov.buffer);
    if (radar.probField) transfer.add(radar.probField.data.buffer);
  }
  const result = {
    log: r.log, pinObs: r.pinObs,
    lat: r.lat, lon: r.lon, nowSec: r.nowSec, timeline: r.timeline, blended: r.blended, summary: r.summary,
    nc, ncQuality: r.ncQuality, radar, nwp: r.nwp, nwpSkill: r.nwpSkill, verification: r.verification,
    models: r.models,
    errors: r.errors.map(([k, e]) => [k, { message: e && e.message ? e.message : String(e) }]),
    timezone: r.timezone, utcOffset: r.utcOffset, tzAbbr: r.tzAbbr, elevation: r.elevation,
  };
  return { result, transfer: [...transfer] };
}

self.onmessage = async (e) => {
  const { id, lat, lon, calib, skill } = e.data || {};
  try {
    const aiNow = await getAI();
    const r = await runForecast({
      lat, lon, calib, skill, ai: aiNow, fetchImpl: cachedFetch,
      onStage: (name, info) => self.postMessage({ id, type: 'stage', name, info }),
    });
    const { result, transfer } = pack(r);
    result.aiStatus = aiStatus(aiNow);
    self.postMessage({ id, type: 'done', result }, transfer);
    pruneStore();
  } catch (err) {
    self.postMessage({ id, type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
