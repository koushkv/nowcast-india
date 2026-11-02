// Caching relay for RainViewer radar (index and tiles), used when a visitor's network has hit
// RainViewer's 100-requests-per-minute-per-IP limit. Tiles never change once published, so the CDN
// keeps them for a day and every later visitor gets them without touching RainViewer.
const TILE = /^v2\/(radar\/[0-9a-z]+|coverage\/0)\/(256|512)\/\d{1,2}\/\d{1,4}\/\d{1,4}\/\d{1,2}\/\d_\d\.png$/;

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://relay');
    const p = url.searchParams.get('p') || '';
    let target;
    let cache;
    if (p === 'index') {
      target = 'https://api.rainviewer.com/public/weather-maps.json';
      cache = 'public, max-age=30, s-maxage=60';
    } else if (TILE.test(p)) {
      target = `https://tilecache.rainviewer.com/${p}`;
      cache = 'public, max-age=3600, s-maxage=86400, immutable';
    } else {
      res.status(400).json({ error: true, reason: 'not an allowed radar path' });
      return;
    }
    const upstream = await fetch(target, { headers: { 'user-agent': 'nowcast-relay (weather.koushikv.site)' } });
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', upstream.headers.get('content-type') || (p === 'index' ? 'application/json' : 'image/png'));
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', upstream.ok ? cache : 'no-store');
    res.status(upstream.status).send(buf);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: true, reason: String((e && e.message) || e) });
  }
}
