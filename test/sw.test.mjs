// Service worker: caches the app shell for offline use, never stores live data (relays, AI model
// files), keeps the forecast worker's data cache when it updates, and removes old shell caches.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { vercelHeaders } = await import('./headers.mjs');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  for (const [k, v] of Object.entries(vercelHeaders(u.pathname))) res.setHeader(k, v);
  if (u.pathname.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"relay":true}');
  }
  const file = path.join(root, u.pathname === '/' ? 'index.html' : decodeURIComponent(u.pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://localhost:${server.address().port}`;

const browser = await chromium.launch();
try {
  const page = await (await browser.newContext()).newPage();
  await page.route(/^https?:\/\/(?!localhost)/, (route) => route.abort()); // no outside network in this test
  await page.goto(`${origin}/manifest.webmanifest`);
  // caches left by an older version of the app, and the forecast worker's data cache
  await page.evaluate(async () => {
    await (await caches.open('nowcast-v5')).put('/old', new Response('old shell'));
    await (await caches.open('nowcast-data-v1')).put('/keep', new Response('model data'));
  });
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  });
  await page.reload(); // the page is now controlled by the service worker
  const names = await page.evaluate(async () => {
    if (!navigator.serviceWorker.controller) throw new Error('page not controlled');
    for (const u of ['/api/om?u=forecast&latitude=14.16', '/ai/metrics.json', '/index.html', '/css/app.css']) await fetch(u).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 300));
    const out = {};
    for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).map((q) => new URL(q.url).pathname + new URL(q.url).search);
    return out;
  });
  assert.ok(!('nowcast-v5' in names), 'old app-shell cache removed');
  assert.deepEqual(names['nowcast-data-v1'], ['/keep'], 'forecast data cache kept');
  const shell = names['nowcast-v8'] || [];
  assert.ok(shell.includes('/index.html') && shell.includes('/js/ai.js'), 'app shell cached');
  assert.ok(!shell.some((p) => p.startsWith('/api/') || p.startsWith('/ai/')), `no live data in the shell cache: ${shell.filter((p) => /^\/(api|ai)\//.test(p))}`);
  console.log(`  ok  shell cached (${shell.length} files), relays and AI files not stored, data cache kept, old cache removed`);
  console.log('All service worker tests passed');
} finally {
  await browser.close();
  server.close();
}
