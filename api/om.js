// Caching relay for Open-Meteo (used when a visitor's network has hit the free API's per-IP limit).
// Only forecast, ensemble and geocoding requests are relayed; answers are cached at Vercel's CDN.
const HOSTS = {
  forecast: 'https://api.open-meteo.com/v1/forecast',
  ensemble: 'https://ensemble-api.open-meteo.com/v1/ensemble',
  geocode: 'https://geocoding-api.open-meteo.com/v1/search',
};
const ALLOWED = new Set([
  'latitude', 'longitude', 'hourly', 'minutely_15', 'daily', 'current', 'models', 'past_hours', 'forecast_hours',
  'past_minutely_15', 'forecast_minutely_15', 'past_days', 'forecast_days', 'timeformat', 'timezone',
  'wind_speed_unit', 'temperature_unit', 'precipitation_unit', 'cell_selection', 'name', 'count', 'language',
  'format', 'countryCode',
]);

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://relay');
    const base = HOSTS[url.searchParams.get('u') || 'forecast'];
    if (!base) {
      res.status(400).json({ error: true, reason: 'unknown endpoint' });
      return;
    }
    const out = new URLSearchParams();
    for (const [k, v] of url.searchParams) {
      if (k !== 'u' && ALLOWED.has(k) && v.length < 2000) out.set(k, v);
    }
    const upstream = await fetch(`${base}?${out.toString()}`, { headers: { 'user-agent': 'nowcast-relay (weather.koushikv.site)' } });
    const body = await upstream.text();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', upstream.ok ? 'public, max-age=300, s-maxage=1200, stale-while-revalidate=1800' : 'no-store');
    res.status(upstream.status).send(body);
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: true, reason: String((e && e.message) || e) });
  }
}
