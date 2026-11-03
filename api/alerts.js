// Official warnings for India from NDMA's SACHET portal (Common Alerting Protocol, public domain):
// IMD centres, state disaster management authorities (e.g. Andhra Pradesh's mandal-level lightning
// alerts), CWC and INCOIS. Returns every alert still in force, parsed, for the page to match to its
// location. One response for everyone, cached at the CDN for 3 minutes.
//
// Politeness, as NDMA's integration guide asks: the feed is fetched with If-None-Match (ETag), and
// each alert file is fetched once (an identifier never changes) and kept in memory.

const FEED = 'https://sachet.ndma.gov.in/cap_public_website/rss/rss_india.xml';
const CAP = (id) => `https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=${encodeURIComponent(id)}`;
const HEADERS = { 'user-agent': 'nowcast-relay (weather.koushikv.site)', accept: 'application/xml,text/xml' };
const LOOKBACK_MS = 24 * 3600 * 1000;

let feed = { etag: null, body: null };
const cache = new Map(); // RSS id -> parsed alert

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENT[e.toLowerCase()] || m;
    })
    .trim();
}
const tag = (xml, name) => {
  const m = new RegExp(`<(?:cap:)?${name}>([\\s\\S]*?)</(?:cap:)?${name}>`).exec(xml);
  return m ? decode(m[1]) : '';
};

/** RSS items: { id, title, pubDate, author } */
export function parseFeed(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const link = tag(it, 'link');
    const id = (/identifier=([0-9A-Za-z_-]+)/.exec(link) || [])[1] || tag(it, 'guid');
    if (!id) continue;
    out.push({ id, title: tag(it, 'title'), pubDate: tag(it, 'pubDate'), author: (/\(([^)]*)\)/.exec(tag(it, 'author')) || [])[1] || '' });
  }
  return out;
}

/** One CAP 1.2 alert -> compact object. English text is preferred; a regional-language text is kept too. */
export function parseCap(xml, id) {
  const infos = [...xml.matchAll(/<cap:info>([\s\S]*?)<\/cap:info>/g)].map((m) => {
    const x = m[1];
    const area = /<cap:area>([\s\S]*?)<\/cap:area>/.exec(x);
    const geocodes = area ? [...area[1].matchAll(/<cap:geocode>[\s\S]*?<cap:value>([\s\S]*?)<\/cap:value>[\s\S]*?<\/cap:geocode>/g)].map((g) => decode(g[1])) : [];
    return {
      language: tag(x, 'language'), event: tag(x, 'event'), urgency: tag(x, 'urgency'), severity: tag(x, 'severity'),
      certainty: tag(x, 'certainty'), effective: tag(x, 'effective'), onset: tag(x, 'onset'), expires: tag(x, 'expires'),
      headline: tag(x, 'headline'), description: tag(x, 'description'), instruction: tag(x, 'instruction'),
      areaDesc: area ? tag(area[1], 'areaDesc') : '', geocodes,
    };
  });
  if (!infos.length) return null;
  const en = infos.find((i) => /^en/i.test(i.language)) || infos[0];
  const local = infos.find((i) => i !== en && i.headline && i.headline !== en.headline);
  const refs = tag(xml, 'references').split(/\s+/).map((r) => r.split(',')[1]).filter(Boolean);
  return {
    id, capId: tag(xml, 'identifier'), sender: tag(xml, 'sender'), sent: tag(xml, 'sent'),
    status: tag(xml, 'status'), msgType: tag(xml, 'msgType'), refs,
    event: en.event, urgency: en.urgency, severity: en.severity, certainty: en.certainty,
    effective: en.effective, onset: en.onset, expires: en.expires,
    headline: en.headline || en.description, instruction: en.instruction,
    area: en.areaDesc, lgd: en.geocodes,
    local: local ? { language: local.language, headline: local.headline } : null,
  };
}

/** Alerts still in force: actual, not cancelled, not replaced by a later update, not expired. */
export function liveAlerts(alerts, nowMs) {
  const replaced = new Set(alerts.flatMap((a) => a.refs || []));
  return alerts
    .filter((a) => a && a.status === 'Actual' && a.msgType !== 'Cancel' && !replaced.has(a.capId))
    .filter((a) => !a.expires || Date.parse(a.expires) > nowMs)
    .sort((a, b) => Date.parse(b.sent) - Date.parse(a.sent));
}

async function getText(url, init, ms = 8000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(t); }
}

export default async function handler(req, res) {
  try {
    const r = await getText(FEED, { headers: { ...HEADERS, ...(feed.etag ? { 'if-none-match': feed.etag } : {}) } });
    if (r.status === 200) feed = { etag: r.headers.get('etag'), body: await r.text() };
    else if (!(r.status === 304 && feed.body)) throw new Error(`SACHET feed answered ${r.status}`);
    const now = Date.now();
    const items = parseFeed(feed.body).filter((it) => !(now - Date.parse(it.pubDate) > LOOKBACK_MS));
    // fetch alert files we have not seen yet, a few at a time, within the time budget
    const todo = items.filter((it) => !cache.has(it.id));
    const deadline = now + 20000;
    let next = 0;
    const worker = async () => {
      while (next < todo.length && Date.now() < deadline) {
        const it = todo[next++];
        try {
          const x = await getText(CAP(it.id), { headers: HEADERS });
          if (x.ok) cache.set(it.id, parseCap(await x.text(), it.id));
        } catch { /* try again on the next request */ }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    const ids = new Set(items.map((it) => it.id));
    for (const k of cache.keys()) if (!ids.has(k)) cache.delete(k);
    const alerts = liveAlerts(items.map((it) => cache.get(it.id)).filter(Boolean), now);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=180, stale-while-revalidate=600');
    res.status(200).json({
      updated: new Date(now).toISOString(),
      source: 'NDMA SACHET (Common Alerting Protocol), public domain',
      complete: items.every((it) => cache.has(it.id)),
      alerts,
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: true, reason: String((e && e.message) || e) });
  }
}
