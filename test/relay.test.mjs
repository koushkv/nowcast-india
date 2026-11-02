// Relay functions (api/om.js, api/rv.js) with a stubbed upstream.
import assert from 'node:assert/strict';
import om from '../api/om.js';
import rv from '../api/rv.js';

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.stack || e}`); } };
function mockRes() {
  const r = { headers: {}, code: 0, body: null };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = (c) => { r.code = c; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.json = (o) => { r.body = JSON.stringify(o); return r; };
  return r;
}
const calls = [];
globalThis.fetch = async (url) => {
  calls.push(String(url));
  if (String(url).includes('fail')) return new Response('{"error":true,"reason":"Daily API request limit exceeded"}', { status: 429 });
  if (String(url).endsWith('.png')) return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } });
  return new Response('{"ok":1}', { status: 200, headers: { 'content-type': 'application/json' } });
};

console.log('Relay tests');
await test('Open-Meteo relay forwards allowed parameters and caches at the CDN', async () => {
  const res = mockRes();
  await om({ url: '/api/om?u=forecast&latitude=14.17&longitude=77.81&hourly=precipitation&models=ecmwf_ifs&evil=1' }, res);
  const last = calls.at(-1);
  assert.ok(last.startsWith('https://api.open-meteo.com/v1/forecast?'));
  assert.ok(last.includes('latitude=14.17') && !last.includes('evil'));
  assert.equal(res.code, 200);
  assert.match(res.headers['cache-control'], /s-maxage=1200/);
});
await test('Open-Meteo relay routes ensemble and geocoding', async () => {
  await om({ url: '/api/om?u=ensemble&latitude=1&longitude=2&hourly=precipitation' }, mockRes());
  assert.ok(calls.at(-1).startsWith('https://ensemble-api.open-meteo.com/v1/ensemble?'));
  await om({ url: '/api/om?u=geocode&name=Puttaparthi&countryCode=IN' }, mockRes());
  assert.ok(calls.at(-1).startsWith('https://geocoding-api.open-meteo.com/v1/search?name=Puttaparthi'));
  const bad = mockRes();
  await om({ url: '/api/om?u=somewhere-else' }, bad);
  assert.equal(bad.code, 400);
});
await test('upstream errors are passed through and never cached', async () => {
  const res = mockRes();
  await om({ url: '/api/om?u=forecast&latitude=fail' }, res);
  assert.equal(res.code, 429);
  assert.equal(res.headers['cache-control'], 'no-store');
});
await test('radar relay allows only the index and RainViewer tile paths', async () => {
  const a = mockRes();
  await rv({ url: '/api/rv?p=index' }, a);
  assert.equal(calls.at(-1), 'https://api.rainviewer.com/public/weather-maps.json');
  assert.match(a.headers['cache-control'], /s-maxage=60/);
  const b = mockRes();
  await rv({ url: `/api/rv?p=${encodeURIComponent('v2/radar/1793620800/512/6/44/29/2/0_0.png')}` }, b);
  assert.equal(calls.at(-1), 'https://tilecache.rainviewer.com/v2/radar/1793620800/512/6/44/29/2/0_0.png');
  assert.equal(b.code, 200);
  assert.match(b.headers['cache-control'], /immutable/);
  const c = mockRes();
  await rv({ url: `/api/rv?p=${encodeURIComponent('v2/coverage/0/512/6/44/29/0/0_0.png')}` }, c);
  assert.equal(c.code, 200);
  for (const evil of ['../etc/passwd', 'http://evil.com/x.png', 'v2/radar/abc/512/6/44/29/2/0_0.png?x=1']) {
    const d = mockRes();
    await rv({ url: `/api/rv?p=${encodeURIComponent(evil)}` }, d);
    assert.equal(d.code, 400, evil);
  }
});
console.log(failures ? `\n${failures} test(s) failed` : '\nAll relay tests passed');
process.exitCode = failures ? 1 : 0;
