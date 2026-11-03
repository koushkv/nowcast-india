// Loads the real app in headless Chromium with all external services replaced by synthetic
// responses (radar tiles with a known storm, model JSON), checks for errors and takes screenshots.
// Run: node test/ui.test.mjs [outDir]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { makeScenario, openMeteoHandlers, encodePNG, satHandlers } from './synth.mjs';
import { vercelHeaders } from './headers.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const outDir = process.argv[2] || path.resolve(root, '..', 'test', 'shots');
fs.mkdirSync(outDir, { recursive: true });

// ---- static server ----
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const relayHits = { om: 0, rv: 0 };
let aiDir = null; // when set, /ai/* is served from here (a trained model) instead of public/ai
const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, 'http://x');
  for (const [k, v] of Object.entries(vercelHeaders(reqUrl.pathname))) res.setHeader(k, v);
  // emulate this site's relays (api/om.js, api/rv.js) against the synthetic upstreams
  if (reqUrl.pathname === '/api/om') {
    relayHits.om++;
    const kind = reqUrl.searchParams.get('u');
    reqUrl.searchParams.delete('u');
    const upstream = kind === 'ensemble' ? 'https://ensemble-api.open-meteo.com/v1/ensemble' : 'https://api.open-meteo.com/v1/forecast';
    const r = await om[upstream](`${upstream}?${reqUrl.searchParams.toString()}`);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(await r.text());
    return;
  }
  if (reqUrl.pathname === '/api/alerts') {
    // emulate api/alerts.js: a lightning warning for Puttaparthi mandal and one elsewhere in the state
    const exp = new Date(Date.now() + 2 * 3600e3).toISOString();
    const base = { status: 'Actual', msgType: 'Alert', refs: [], urgency: 'Expected', certainty: 'Possible', sender: 'Andhra-Pradesh-SDMA', event: 'Lightning', severity: 'Severe', expires: exp, sent: new Date().toISOString() };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ updated: new Date().toISOString(), complete: true, alerts: [
      { ...base, id: '1', capId: 'IN-1_8', area: 'sss-Puttaparthi Mandal', headline: 'There is a possibility of lightning in your area. Seek shelter in safe buildings - Andhra Pradesh Government.', local: { language: 'TL', headline: 'మీ ప్రాంతంలో పిడుగులు పడే అవకాశం ఉంది.' } },
      { ...base, id: '2', capId: 'IN-2_8', area: 'ksm-katrenikona Mandal', headline: 'There is a possibility of lightning in your area.' },
    ] }));
    return;
  }
  if (reqUrl.pathname === '/api/sat') {
    // emulate api/sat.js: cloud tops near -30 °C over the rain to the west-southwest, clear elsewhere
    const full = `http://site${req.url}`;
    const hs = satHandlers({ base: 'http://site', nowSec, tempK: (lat, lon) => (Math.hypot(lat - (LAT - 0.1), lon - (LON - 0.35)) < 0.3 ? 243 : 296) });
    const key = Object.keys(hs).find((k) => full.startsWith(k));
    if (!key) { res.writeHead(404); res.end(); return; }
    const r = await hs[key](full);
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') });
    res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  if (reqUrl.pathname === '/api/rv') {
    relayHits.rv++;
    const p = reqUrl.searchParams.get('p');
    if (p === 'index') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(sc.index)); return; }
    const png = sc.pngs.get(`https://tilecache.rainviewer.com/${p}`);
    if (png) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); return; }
    res.writeHead(404); res.end(); return;
  }
  if (aiDir && reqUrl.pathname.startsWith('/ai/')) {
    const f = path.join(aiDir, path.basename(reqUrl.pathname));
    if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': f.endsWith('.json') ? 'application/json' : 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
    return;
  }
  const p = decodeURIComponent(reqUrl.pathname);
  const file = path.join(root, p === '/' ? 'index.html' : p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/`;

// ---- synthetic world ----
const nowSec = Math.floor(Date.now() / 1000);
const LAT = 14.165, LON = 77.811;
const sc = makeScenario({ lat: LAT, lon: LON, nowSec, ageMin: 6 });
const om = openMeteoHandlers({ nowSec, rainFn: (m, t) => (t > nowSec + 2.2 * 3600 && t < nowSec + 4 * 3600 ? (m === 'cma_grapes_global' ? 0 : 1.2) : 0) });
const grey = encodePNG(256, 256, (() => { const a = new Uint8Array(256 * 256 * 4); for (let i = 0; i < a.length; i += 4) { a[i] = 200; a[i + 1] = 205; a[i + 2] = 212; a[i + 3] = 255; } return a; })());

async function route(page, opts = {}) {
  await page.context().route('**/*', async (rt) => {
    const u = rt.request().url();
    if (u.startsWith(base)) return rt.continue();
    const cors = { 'access-control-allow-origin': '*' };
    if (opts.limitDirect && (u.includes('rainviewer.com') || u.includes('open-meteo.com'))) {
      return rt.fulfill({ status: 429, headers: { ...cors, 'content-type': 'application/json' }, body: '{"error":true,"reason":"Daily API request limit exceeded"}' });
    }
    if (opts.failRadar && (u.includes('rainviewer.com'))) return rt.fulfill({ status: 503, headers: cors, body: 'down' });
    if (opts.failModels && u.includes('open-meteo.com')) return rt.fulfill({ status: 503, headers: cors, body: 'down' });
    if (u.startsWith('https://api.rainviewer.com/')) return rt.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(sc.index) });
    if (u.startsWith('https://tilecache.rainviewer.com/')) {
      const png = sc.pngs.get(u);
      return png ? rt.fulfill({ status: 200, headers: { ...cors, 'content-type': 'image/png' }, body: png }) : rt.fulfill({ status: 404, headers: cors, body: '' });
    }
    for (const [prefix, h] of Object.entries(om)) {
      if (u.startsWith(prefix)) {
        const res = h(u);
        return rt.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: await res.text() });
      }
    }
    if (u.startsWith('https://tile.openstreetmap.org/')) {
      return rt.fulfill({ status: 200, headers: { 'content-type': 'image/png' }, body: grey });
    }
    if (u.startsWith('https://nominatim.openstreetmap.org/')) return rt.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify({ address: { town: 'Puttaparthi', county: 'Puttaparthi Mandal', state_district: 'Sri Sathya Sai District', state: 'Andhra Pradesh', country: 'India' } }) });
    return rt.abort();
  });
}

const browser = await chromium.launch();
const results = [];
for (const cfg of [
  { name: 'phone-dark', viewport: { width: 390, height: 844 }, colorScheme: 'dark', isMobile: true, deviceScaleFactor: 2 },
  { name: 'phone-light', viewport: { width: 390, height: 844 }, colorScheme: 'light', isMobile: true, deviceScaleFactor: 2 },
  { name: 'desktop-dark', viewport: { width: 1440, height: 900 }, colorScheme: 'dark' },
  { name: 'desktop-light', viewport: { width: 1440, height: 900 }, colorScheme: 'light' },
  { name: 'tablet', viewport: { width: 1024, height: 768 }, colorScheme: 'dark', isMobile: true, deviceScaleFactor: 2 },
]) {
  const ctx = await browser.newContext({ viewport: cfg.viewport, colorScheme: cfg.colorScheme, isMobile: cfg.isMobile, deviceScaleFactor: cfg.deviceScaleFactor || 1, timezoneId: 'Asia/Kolkata', locale: 'en-IN' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if ((m.type() === 'error' && !/ERR_FAILED/.test(m.text())) || /Content Security Policy/i.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('requestfailed', (q) => { if (!q.url().includes('fonts.googleapis.com') && !q.url().includes('fonts.gstatic.com')) errors.push(`requestfailed: ${q.url().slice(0, 90)} (${q.failure() && q.failure().errorText})`); });
  await route(page);
  if (cfg.name.startsWith('desktop')) {
    // seed a track record for this spot so the scorecard card renders with data
    await page.addInitScript(({ lat, lon, now }) => {
      const k = `${(Math.round(lat * 20) / 20).toFixed(2)},${(Math.round(lon * 20) / 20).toFixed(2)}`;
      const records = [];
      for (let r = 0; r < 30; r++) {
        const t = now - (30 - r) * 3 * 3600;
        const rows = [0, 2, 4, 6, 8, 10, 12, 18, 24].map((i) => {
          const o = (r + i) % 4 === 0 ? 1 : 0;
          const pf = o ? 0.75 : (r % 7 === 0 ? 0.6 : 0.12);
          return { vt: t + i * 300, pb: pf, pf, pr: 0.5, pm: 0.35, w: 0.5, mp: { ecmwf_ifs: o ? 0.6 : 0.2 }, o };
        });
        records.push({ k, t, lat, lon, rows });
      }
      localStorage.setItem('nowcast.track.v1', JSON.stringify({ v: 1, records }));
    }, { lat: LAT, lon: LON, now: nowSec });
  }
  const t0 = Date.now();
  await page.goto(`${base}#${LAT},${LON}`);
  await page.waitForFunction(() => {
    const t = document.getElementById('title').textContent;
    return t && !t.startsWith('Checking') && document.getElementById('status').dataset.state !== 'loading';
  }, null, { timeout: 60000 });
  const ms = Date.now() - t0;
  await page.waitForFunction(() => !document.getElementById('alerts').hidden, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);
  const info = await page.evaluate(() => ({
    title: document.getElementById('title').textContent,
    detail: document.getElementById('detail').textContent,
    approach: document.getElementById('approach').textContent,
    status: document.getElementById('status-text').textContent,
    temp: document.getElementById('s-temp').textContent,
    hour: document.getElementById('s-hour').textContent,
    total: document.getElementById('s-total').textContent,
    meta: document.getElementById('updated').textContent + ' | ' + document.getElementById('confidence').textContent,
    frame: document.getElementById('frame-label').textContent,
    loc: document.getElementById('loc-name').textContent,
    rows: document.querySelectorAll('#hours tr:not(.grp)').length,
    clock: document.getElementById('clock').textContent,
    live: document.getElementById('live').dataset.state,
    statusbar: document.getElementById('sb-data').textContent,
    readouts: [...document.querySelectorAll('.readout dd')].map((d) => d.textContent).join(' | '),
    bg: getComputedStyle(document.body).backgroundColor,
    mode: document.getElementById('mode-v').textContent,
    why: [...document.querySelectorAll('#why-list li')].map((li) => li.textContent).join(' | '),
    journey: document.querySelector('#journey svg') ? document.getElementById('journey-src').textContent : 'missing',
    radarKv: document.getElementById('radar-kv').textContent,
    storm: document.getElementById('storm-kv').textContent,
    groups: [...document.querySelectorAll('#hours tr.grp')].map((g) => g.textContent).join(' | '),
    alerts: document.getElementById('alerts').hidden ? 'hidden' : document.getElementById('alerts').textContent.replace(/\s+/g, ' ').trim(),
    facts: document.querySelectorAll('#facts dt').length,
    track: document.getElementById('sc-summary').textContent,
    trackStats: document.getElementById('sc-stats').hidden ? 'hidden' : [document.getElementById('sc-acc').textContent, document.getElementById('sc-sr').textContent, document.getElementById('sc-pod').textContent].join(' / '),
    learn: document.getElementById('sc-learn').textContent,
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
  }));
  await page.screenshot({ path: path.join(outDir, `${cfg.name}.png`), fullPage: true });
  if (cfg.name === 'desktop-dark') {
    // step the radar into the forecast and open the details section
    await page.locator('#frame-slider').fill('15');
    await page.locator('#about summary').click();
    await page.waitForTimeout(200);
    info.frameForecast = await page.locator('#frame-label').textContent();
    await page.screenshot({ path: path.join(outDir, `${cfg.name}-interact.png`), fullPage: true });
    await page.locator('#map-mode button[data-v="chance"]').click();
    await page.waitForTimeout(250);
    info.chanceLabel = await page.locator('#frame-label').textContent();
    info.chancePixels = await page.evaluate(() => {
      const c = document.querySelector('canvas.pw-field');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
      return n;
    });
    await page.locator('#map').screenshot({ path: path.join(outDir, `${cfg.name}-chance.png`) });
    await page.locator('#map-mode button[data-v="radar"]').click();
    await page.waitForTimeout(150);
    await page.locator('#map').screenshot({ path: path.join(outDir, `${cfg.name}-radar.png`) });
  }
  if (info.rows !== 11) errors.push(`5-hour table has ${info.rows} rows`);
  if (!/^\d{2}:\d{2}:\d{2}$/.test(info.clock)) errors.push(`clock not running: "${info.clock}"`);
  if (info.bg !== 'rgb(0, 0, 0)') errors.push(`background is ${info.bg}, not black`);
  if (!info.statusbar.includes('Radar') || !info.statusbar.includes('Models')) errors.push(`status bar incomplete: "${info.statusbar}"`);
  if (info.live !== 'live') errors.push(`live indicator is "${info.live}"`);
  if (info.mode !== 'Radar tracking') errors.push(`prediction mode is "${info.mode}"`);
  if (info.journey !== 'Rain on its way') errors.push(`rain journey: "${info.journey}"`);
  if (!/Sriharikota/.test(info.radarKv)) errors.push('nearest IMD radar missing');
  if (!/Cloud development/.test(info.storm) || /Unavailable/.test(info.storm)) errors.push(`storm watch: "${info.storm.slice(0, 80)}"`);
  if ((info.groups.match(/→/g) || []).length < 5) errors.push(`confidence groups: "${info.groups}"`);
  if (!/Official warning · Lightning · Severe/.test(info.alerts) || /katrenikona/i.test(info.alerts)) errors.push(`official warning banner: "${info.alerts.slice(0, 120)}"`);
  if (!/Lightning\s*Official warning/.test(info.storm)) errors.push(`lightning row: "${info.storm.slice(0, 160)}"`);
  if (!/Official warning: Lightning for Puttaparthi mandal/.test(info.why)) errors.push('official warning missing from "Why"');
  if (!/°C/.test(info.temp)) errors.push(`not metric by default: "${info.temp}"`);
  results.push({ cfg: cfg.name, ms, info, errors });
  await ctx.close();
}
// degraded services: each source down in turn must still give a forecast without script errors
for (const [name, opts] of [['radar-down', { failRadar: true }], ['models-down', { failModels: true }], ['rate-limited-uses-relay', { limitDirect: true }]]) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', timezoneId: 'Asia/Kolkata', locale: 'en-IN' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await route(page, opts);
  const t0 = Date.now();
  await page.goto(`${base}#${LAT},${LON}`);
  await page.waitForFunction(() => {
    const t = document.getElementById('title').textContent;
    return t && !t.startsWith('Checking') && document.getElementById('status').dataset.state !== 'loading';
  }, null, { timeout: 90000 });
  const before = { ...relayHits };
  const info = await page.evaluate(() => ({
    title: document.getElementById('title').textContent,
    notice: document.getElementById('notice').hidden ? '' : document.getElementById('notice').textContent,
    frame: document.getElementById('frame-label').textContent,
    models: document.getElementById('facts').textContent.includes('Weather models'),
  }));
  info.relayCalls = { om: relayHits.om, rv: relayHits.rv };
  void before;
  if (opts.limitDirect && (!info.models || info.frame === 'Radar unavailable' || relayHits.om === 0 || relayHits.rv === 0)) {
    errors.push('relay fallback did not recover models and radar');
  }
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  results.push({ cfg: name, ms: Date.now() - t0, info, errors });
  await ctx.close();
}
// published AI model (written by test/py/test_train.py): loaded by the worker, used, and explained
const trained = path.resolve(root, '..', 'test', 'tmp-ai');
if (fs.existsSync(path.join(trained, 'model.json'))) {
  aiDir = trained;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', timezoneId: 'Asia/Kolkata', locale: 'en-IN' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/ERR_FAILED/.test(m.text())) errors.push(`console: ${m.text()}`); });
  await route(page);
  const t0 = Date.now();
  await page.goto(`${base}#${LAT},${LON}`);
  await page.waitForFunction(() => {
    const t = document.getElementById('title').textContent;
    return t && !t.startsWith('Checking') && document.getElementById('status').dataset.state !== 'loading';
  }, null, { timeout: 90000 });
  const info = await page.evaluate(() => {
    const facts = document.getElementById('facts').textContent;
    return {
      title: document.getElementById('title').textContent,
      aiFact: (facts.match(/AI model(.{0,190})/) || [])[1] || '',
      chanceNote: document.getElementById('chance-note').textContent,
    };
  });
  if (!info.aiFact.includes('A neural network trained on')) errors.push(`AI model not reported as used: "${info.aiFact}"`);
  if (!info.chanceNote.includes('AI model')) errors.push('heatmap caption does not mention the AI model');
  results.push({ cfg: 'ai-model-published', ms: Date.now() - t0, info, errors });
  await ctx.close();
  aiDir = null;
} else {
  console.log('(AI model scenario skipped: run test/py/test_train.py first)');
}
await browser.close();
server.close();
for (const r of results) {
  console.log(`\n[${r.cfg}] ready in ${r.ms} ms`);
  console.log(JSON.stringify(r.info, null, 1));
  if (r.errors.length) console.log('ERRORS:', r.errors);
}
const bad = results.filter((r) => r.errors.length || r.info.overflowX);
console.log(bad.length ? `\n${bad.length} configuration(s) with problems` : '\nUI OK in all configurations');
process.exitCode = bad.length ? 1 : 0;
