// Units and local-time formatting.

const KEY = 'nowcast.units.v1';
const DEFAULTS = { temp: 'C', wind: 'kmh', rain: 'mm', dist: 'km' };

export function loadUnits() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* storage unavailable */ }
  // sensible default for US users
  try {
    const loc = (navigator.language || '').toLowerCase();
    if (loc === 'en-us' || loc.endsWith('-lr') || loc.endsWith('-mm')) return { temp: 'F', wind: 'mph', rain: 'in', dist: 'mi' };
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}
export function saveUnits(u) {
  try { localStorage.setItem(KEY, JSON.stringify(u)); } catch { /* ignore */ }
}

export function makeFormat(units, timeZone) {
  const tz = timeZone || undefined;
  let timeFmt;
  try {
    timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: tz });
  } catch {
    timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  let hourFmt;
  try {
    hourFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', timeZone: tz });
  } catch {
    hourFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });
  }
  const f = {
    units,
    time: (unixSec) => timeFmt.format(new Date(unixSec * 1000)),
    hour: (unixSec) => hourFmt.format(new Date(unixSec * 1000)),
    temp: (c) => {
      if (!Number.isFinite(c)) return '–';
      return units.temp === 'F' ? `${Math.round((c * 9) / 5 + 32)}°` : `${Math.round(c)}°`;
    },
    tempUnit: () => (units.temp === 'F' ? '°F' : '°C'),
    wind: (kmh) => {
      if (!Number.isFinite(kmh)) return '–';
      switch (units.wind) {
        case 'mph': return `${Math.round(kmh / 1.609)}`;
        case 'ms': return `${Math.round(kmh / 3.6)}`;
        case 'kn': return `${Math.round(kmh / 1.852)}`;
        default: return `${Math.round(kmh)}`;
      }
    },
    windUnit: () => ({ mph: 'mph', ms: 'm/s', kn: 'kn', kmh: 'km/h' }[units.wind]),
    speed: (kmh) => `${f.wind(kmh)} ${f.windUnit()}`,
    rate: (mmh) => {
      if (!Number.isFinite(mmh)) return '–';
      if (units.rain === 'in') {
        const v = mmh / 25.4;
        return v < 0.01 ? '0' : v < 0.1 ? v.toFixed(2) : v.toFixed(1);
      }
      return mmh < 0.1 ? '0' : mmh < 10 ? mmh.toFixed(1) : `${Math.round(mmh)}`;
    },
    rateUnit: () => (units.rain === 'in' ? 'in/h' : 'mm/h'),
    amount: (mm) => {
      if (!Number.isFinite(mm)) return '–';
      if (units.rain === 'in') {
        const v = mm / 25.4;
        return `${v < 0.01 ? '0' : v.toFixed(2)} in`;
      }
      return `${mm < 0.1 ? '0' : mm < 10 ? mm.toFixed(1) : Math.round(mm)} mm`;
    },
    dist: (km) => {
      if (!Number.isFinite(km)) return '–';
      return units.dist === 'mi' ? `${Math.round(km / 1.609)} mi` : `${Math.round(km)} km`;
    },
    pct: (p) => (Number.isFinite(p) ? `${Math.round(p * 100)}%` : '–'),
  };
  return f;
}
