// Relay functions (api/om.js, api/rv.js, api/sat.js) with a stubbed upstream.
import assert from 'node:assert/strict';
import om from '../api/om.js';
import rv from '../api/rv.js';
import sat from '../api/sat.js';

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
  if (String(url).includes('request=GetCapabilities')) return new Response('<Dimension name="time" default="2026-11-02T16:45:00Z" units="ISO8601">x</Dimension>', { status: 200, headers: { 'content-type': 'text/xml' } });
  if (String(url).includes('request=GetMap')) return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } });
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
await test('Satellite relay gives the newest image time and only small India boxes at 15-minute times', async () => {
  const a = mockRes();
  await sat({ url: '/api/sat?p=latest' }, a);
  assert.equal(a.code, 200);
  assert.deepEqual(JSON.parse(a.body), { latest: '2026-11-02T16:45:00Z' });
  assert.match(a.headers['cache-control'], /s-maxage=120/);
  const b = mockRes();
  await sat({ url: '/api/sat?p=map&t=2026-11-02T16:30:00Z&b=13.5,77,15,78.5&s=48' }, b);
  assert.equal(b.code, 200);
  const last = calls.at(-1);
  assert.ok(last.startsWith('https://view.eumetsat.int/geoserver/wms?') && last.includes('layers=msg_iodc:ir108') && last.includes('bbox=13.5,77,15,78.5') && last.includes('time=2026-11-02T16:30:00Z'), last);
  assert.match(b.headers['cache-control'], /immutable/);
  for (const q of [
    'p=map&t=2026-11-02T16:31:00Z&b=13.5,77,15,78.5&s=48', // not a 15-minute image time
    'p=map&t=2026-11-02T16:30:00Z&b=13.4,77,15,78.5&s=48', // off the 0.25° grid
    'p=map&t=2026-11-02T16:30:00Z&b=40,10,42,12&s=48', // not India
    'p=map&t=2026-11-02T16:30:00Z&b=10,70,20,80&s=48', // too large
    'p=map&t=2026-11-02T16:30:00Z&b=13.5,77,15,78.5&s=4000', // too many pixels
    'p=map&t=2099-01-01T00:00:00Z&b=13.5,77,15,78.5&s=48', // future
    'p=other',
  ]) {
    const r = mockRes();
    await sat({ url: `/api/sat?${q}` }, r);
    assert.equal(r.code, 400, q);
  }
});
console.log(failures ? `\n${failures} test(s) failed` : '\nAll relay tests passed');
process.exitCode = failures ? 1 : 0;
