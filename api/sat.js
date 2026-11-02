// Relay for Meteosat-9 (Indian Ocean coverage) infrared imagery from EUMETSAT's public WMS
// (EUMETView). Used to see storm clouds forming before radar picks them up.
//   ?p=latest                         -> { latest: "2026-11-02T16:45:00Z" } (newest 15-minute image)
//   ?p=map&t=<ISO time>&b=<lat0,lon0,lat1,lon1>&s=<pixels>  -> PNG of the IR10.8 channel
// Only small boxes over India at 15-minute image times are allowed; images never change once
// published, so the CDN keeps them for a day and shares them between visitors.
const WMS = 'https://view.eumetsat.int/geoserver';
const LAYER = 'msg_iodc:ir108';
const TIME = /^20\d\d-\d\d-\d\dT\d\d:(00|15|30|45):00Z$/;

function box(b) {
  const v = String(b || '').split(',').map(Number);
  if (v.length !== 4 || v.some((x) => !Number.isFinite(x))) return null;
  const [lat0, lon0, lat1, lon1] = v;
  const quarter = (x) => Math.abs(x * 4 - Math.round(x * 4)) < 1e-6;
  if (!v.every(quarter)) return null; // snapped grid only, so caches are shared
  if (lat0 < 0 || lat1 > 42 || lon0 < 60 || lon1 > 104) return null; // India and surroundings
  if (!(lat1 > lat0 && lon1 > lon0) || lat1 - lat0 > 3 || lon1 - lon0 > 3) return null;
  return v;
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://relay');
    const p = url.searchParams.get('p');
    const headers = { 'user-agent': 'nowcast-relay (weather.koushikv.site)' };
    if (p === 'latest') {
      const r = await fetch(`${WMS}/msg_iodc/ir108/ows?service=WMS&version=1.3.0&request=GetCapabilities`, { headers });
      const xml = await r.text();
      const m = /<Dimension[^>]*name="time"[^>]*default="([^"]+)"/.exec(xml);
      if (!r.ok || !m) throw new Error(`no time dimension (HTTP ${r.status})`);
      const latest = new Date(m[1]).toISOString().replace('.000Z', 'Z');
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=120, stale-while-revalidate=300');
      res.status(200).json({ latest });
      return;
    }
    if (p === 'map') {
      const t = url.searchParams.get('t') || '';
      const b = box(url.searchParams.get('b'));
      const s = Number(url.searchParams.get('s'));
      if (!TIME.test(t) || !b || !(s >= 16 && s <= 96)) {
        res.status(400).json({ error: true, reason: 'not an allowed satellite request' });
        return;
      }
      if (Date.parse(t) > Date.now() + 60000) {
        res.status(400).json({ error: true, reason: 'time is in the future' });
        return;
      }
      const q = `service=WMS&version=1.3.0&request=GetMap&layers=${LAYER}&styles=&crs=EPSG:4326` +
        `&bbox=${b.join(',')}&width=${s}&height=${s}&format=image/png&time=${t}`;
      const r = await fetch(`${WMS}/wms?${q}`, { headers });
      const type = r.headers.get('content-type') || '';
      const buf = Buffer.from(await r.arrayBuffer());
      const ok = r.ok && type.startsWith('image/png');
      res.setHeader('Content-Type', ok ? 'image/png' : 'application/json');
      res.setHeader('Cache-Control', ok ? 'public, max-age=3600, s-maxage=86400, immutable' : 'no-store');
      if (!ok) { res.status(502).json({ error: true, reason: `satellite service answered ${r.status}` }); return; }
      res.status(200).send(buf);
      return;
    }
    res.status(400).json({ error: true, reason: 'unknown request' });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: true, reason: String((e && e.message) || e) });
  }
}
