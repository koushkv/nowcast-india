// Official warnings: the SACHET relay (api/alerts.js) and matching alerts to a location
// (public/js/alerts.js), using alert files in the exact form SACHET publishes them.
import assert from 'node:assert/strict';
import handler, { parseFeed, parseCap, liveAlerts, decode } from '../api/alerts.js';
import { matchAlerts, sameName, nameKey, areaNames, isStormAlert, areaLabel, issuerName } from '../public/js/alerts.js';

let failures = 0;
const test = async (name, fn) => { try { await fn(); console.log(`  ok  ${name}`); } catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.stack || e}`); } };
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', '+00:00');
const NOW = Date.now();

// an Andhra Pradesh SDMA lightning alert, as served by FetchXMLFile (English + Telugu)
const capAP = (id, mandal, expiresMs) => `<cap:alert xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
<cap:identifier>IN-${id}_8</cap:identifier><cap:sender>Andhra-Pradesh-SDMA</cap:sender><cap:sent>${iso(NOW - 600000)}</cap:sent>
<cap:status>Actual</cap:status><cap:msgType>Alert</cap:msgType><cap:scope>Public</cap:scope><cap:restriction/><cap:addresses/><cap:note/><cap:incidents/>
<cap:info><cap:language>en-IN</cap:language><cap:category>Met</cap:category><cap:event>Lightning</cap:event><cap:urgency>Expected</cap:urgency>
<cap:severity>Severe</cap:severity><cap:certainty>Possible</cap:certainty><cap:audience>1</cap:audience>
<cap:effective>${iso(NOW - 600000)}</cap:effective><cap:onset>${iso(NOW - 600000)}</cap:onset><cap:expires>${iso(expiresMs)}</cap:expires>
<cap:headline>There is a possibility of lightning in your area. During thunderstorms, avoid trees, towers, poles, fields, and open spaces. Seek shelter in safe buildings - Andhra Pradesh Government.</cap:headline>
<cap:description/><cap:instruction>Please follow SDMA guidelines.</cap:instruction><cap:contact/>
<cap:parameter><cap:valueName>Polygon URL</cap:valueName><cap:value>https://sachet.ndma.gov.in/cap_public_website/FetchPolygonXMLFile?identifier=${id}</cap:value></cap:parameter>
<cap:area><cap:areaDesc>${mandal} </cap:areaDesc><cap:altitude>0</cap:altitude><cap:ceiling>0</cap:ceiling></cap:area></cap:info>
<cap:info><cap:language>TL</cap:language><cap:category>Met</cap:category><cap:event>Lightning</cap:event><cap:urgency>Expected</cap:urgency>
<cap:severity>Severe</cap:severity><cap:certainty>Possible</cap:certainty><cap:expires>${iso(expiresMs)}</cap:expires>
<cap:headline>మీ ప్రాంతంలో పిడుగులు పడే అవకాశం ఉంది.</cap:headline>
<cap:area><cap:areaDesc>${mandal} </cap:areaDesc></cap:area></cap:info></cap:alert>`;

// an IMD district warning that replaces an earlier one (msgType Update + references)
const capIMD = (id, areaDesc, expiresMs, refs = '') => `<cap:alert xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2">
<cap:identifier>IN-${id}_43</cap:identifier><cap:sender>IMD-Amaravati</cap:sender><cap:sent>${iso(NOW - 300000)}</cap:sent>
<cap:status>Actual</cap:status><cap:msgType>${refs ? 'Update' : 'Alert'}</cap:msgType><cap:scope>Public</cap:scope>
${refs ? `<cap:references>IMD-Amaravati,${refs},${iso(NOW - 900000)}</cap:references>` : ''}
<cap:info><cap:language>en-IN</cap:language><cap:category>Met</cap:category><cap:event>Thunderstorm &amp; Lightning</cap:event>
<cap:urgency>Expected</cap:urgency><cap:severity>Moderate</cap:severity><cap:certainty>Likely</cap:certainty>
<cap:expires>${iso(expiresMs)}</cap:expires>
<cap:headline>Thunderstorm with lightning is very likely at isolated places over Anantapuramu, Sri Satya Sai in next 3 hours.</cap:headline>
<cap:area><cap:areaDesc>${areaDesc}</cap:areaDesc>
<cap:geocode><cap:valueName>LGD District Code</cap:valueName><cap:value>502</cap:value></cap:geocode></cap:area></cap:info></cap:alert>`;

const feedXml = (items) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>All India CAP feed</title>${items.map((it) => `<item>
<title>${it.title}</title><description/><category>Met</category>
<link>https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=${it.id}</link>
<author>controlroom@ndma.gov.in (${it.author})</author><guid isPermaLink="false">${it.id}</guid>
<pubDate>${new Date(it.pub).toUTCString()}</pubDate></item>`).join('')}</channel></rss>`;

const PUTTAPARTHI = { state: 'Andhra Pradesh', district: 'Sri Sathya Sai District', sub: 'Puttaparthi Mandal', town: 'Puttaparthi' };

console.log('Official warnings');
await test('feed and alert files parse as SACHET publishes them', async () => {
  assert.equal(decode('Rain &amp; wind &#x26; hail'), 'Rain & wind & hail');
  const items = parseFeed(feedXml([{ id: '1793685786281008', title: 'Lightning', author: 'Andhra Pradesh SDMA', pub: NOW }]));
  assert.deepEqual(items.map((i) => [i.id, i.author]), [['1793685786281008', 'Andhra Pradesh SDMA']]);
  const a = parseCap(capAP('1793685786281008', 'sss-Puttaparthi Mandal', NOW + 3600e3), '1793685786281008');
  assert.equal(a.event, 'Lightning');
  assert.equal(a.severity, 'Severe');
  assert.equal(a.area, 'sss-Puttaparthi Mandal');
  assert.match(a.headline, /possibility of lightning/);
  assert.equal(a.local.language, 'TL');
  const b = parseCap(capIMD('2', 'Anantapuramu, Sri Satya Sai districts of Andhra Pradesh', NOW + 3600e3, 'IN-1_43'), '2');
  assert.equal(b.event, 'Thunderstorm & Lightning');
  assert.deepEqual(b.lgd, ['502']);
  assert.deepEqual(b.refs, ['IN-1_43']);
});

await test('only warnings still in force: expired, cancelled and replaced ones are dropped', async () => {
  const old = parseCap(capIMD('1', 'Sri Satya Sai districts of Andhra Pradesh', NOW + 3600e3), '1');
  const update = parseCap(capIMD('2', 'Sri Satya Sai districts of Andhra Pradesh', NOW + 7200e3, 'IN-1_43'), '2');
  const expired = parseCap(capAP('3', 'sss-Puttaparthi Mandal', NOW - 60e3), '3');
  const cancel = { ...parseCap(capAP('4', 'sss-Kothacheruvu Mandal', NOW + 3600e3), '4'), msgType: 'Cancel' };
  const live = liveAlerts([old, update, expired, cancel], NOW);
  assert.deepEqual(live.map((a) => a.id), ['2']);
});

await test('relay: polite polling (ETag on the feed, each alert file fetched once) and a shared CDN cache', async () => {
  const calls = [];
  const items = [
    { id: '101', title: 'Lightning', author: 'Andhra Pradesh SDMA', pub: NOW - 600e3 },
    { id: '102', title: 'Thunderstorm', author: 'IMD Amaravati', pub: NOW - 300e3 },
    { id: '103', title: 'Old', author: 'IMD Chennai', pub: NOW - 30 * 3600e3 }, // older than a day: not fetched
  ];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push([u, init.headers && init.headers['if-none-match']]);
    if (u.endsWith('rss_india.xml')) {
      if (init.headers && init.headers['if-none-match'] === '"v1"') return new Response(null, { status: 304 });
      return new Response(feedXml(items), { status: 200, headers: { etag: '"v1"' } });
    }
    const id = /identifier=(\d+)/.exec(u)[1];
    if (id === '101') return new Response(capAP('101', 'sss-Puttaparthi Mandal', NOW + 3600e3), { status: 200 });
    if (id === '102') return new Response(capIMD('102', 'Anantapuramu, Sri Satya Sai districts of Andhra Pradesh', NOW + 3600e3), { status: 200 });
    return new Response('no', { status: 404 });
  };
  const mk = () => { const r = { headers: {} }; r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; }; r.status = (c) => { r.code = c; return r; }; r.json = (o) => { r.body = o; return r; }; return r; };
  const res1 = mk();
  await handler({ url: '/api/alerts' }, res1);
  assert.equal(res1.code, 200);
  assert.deepEqual(res1.body.alerts.map((a) => a.id).sort(), ['101', '102']);
  assert.equal(res1.body.complete, true);
  assert.match(res1.headers['cache-control'], /s-maxage=180/);
  assert.ok(!calls.some(([u]) => u.includes('identifier=103')), 'alerts older than a day are not fetched');
  const n = calls.length;
  const res2 = mk();
  await handler({ url: '/api/alerts' }, res2);
  assert.equal(res2.body.alerts.length, 2);
  assert.deepEqual(calls.slice(n), [['https://sachet.ndma.gov.in/cap_public_website/rss/rss_india.xml', '"v1"']], 'second time: only the feed, with If-None-Match');
});

await test('matching: your mandal, your district (any spelling), and nothing from other mandals', async () => {
  const A = (area, event = 'Lightning', sender = 'Andhra-Pradesh-SDMA', severity = 'Severe') => ({ id: area, area, event, sender, severity, headline: event });
  const m = matchAlerts([
    A('sss-Puttaparthi Mandal'),
    A('Anantapuramu, Sri Satya Sai, Kurnool districts of Andhra Pradesh', 'Thunderstorm & Lightning', 'IMD-Amaravati', 'Moderate'),
    A('ksm-katrenikona Mandal'),
    A('atp-Puttur Mandal'),
    A('cb_next6h_priority_for_SACHET', 'Cyclone', 'Andhra-Pradesh-SDMA', 'Extreme'),
    A('Chengalpattu, Chennai districts of Tamil Nadu', 'Moderate Rain', 'IMD-Chennai', 'Moderate'),
  ], PUTTAPARTHI);
  assert.deepEqual(m.here.map((h) => [h.alert.area, h.level]), [
    ['sss-Puttaparthi Mandal', 'local'],
    ['Anantapuramu, Sri Satya Sai, Kurnool districts of Andhra Pradesh', 'district'],
  ]);
  assert.deepEqual(m.state.map((a) => a.area), ['ksm-katrenikona Mandal', 'atp-Puttur Mandal', 'cb_next6h_priority_for_SACHET']);
  assert.ok(!sameName('puttur', 'puttaparthi') && sameName('srisatyasai', nameKey('Sri Sathya Sai District')) && sameName('anantapur', 'anantapuramu'));
  assert.deepEqual(areaNames('Bengaluru Urban, Bengaluru Rural districts of Karnataka'), ['bengaluruurban', 'bengalururural']);
  assert.ok(!matchAlerts([A('Bengaluru Rural districts of Karnataka')], { state: 'Karnataka', district: 'Bengaluru Urban', sub: 'Bangalore North' }).here.length, 'urban and rural districts stay apart');
  assert.ok(isStormAlert({ event: 'Thunderstorm & Lightning', headline: '' }) && !isStormAlert({ event: 'Moderate Rain', headline: 'Rain likely' }));
  assert.equal(areaLabel({ area: 'sss-Puttaparthi Mandal ' }), 'Puttaparthi mandal');
  assert.equal(issuerName('Andhra-Pradesh-SDMA'), 'Andhra Pradesh SDMA');
});

console.log(failures ? `\n${failures} test(s) failed` : '\nAll alert tests passed');
process.exitCode = failures ? 1 : 0;
