// Official warnings (NDMA SACHET: IMD, state disaster authorities, CWC, INCOIS) matched to a
// location by name: its mandal/taluk (or town) and its district, as given by the place lookup.
// Alert areas are names such as "ksm-katrenikona Mandal" (Andhra Pradesh's lightning alerts) or
// "Chengalpattu, Chennai, Cuddalore districts of Tamil Nadu" (IMD), so names are normalised and
// compared with a small tolerance for spelling variants.

/** Lower-case letters only, without accents or administrative words. */
export function nameKey(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\b(districts?|dist|mandals?|taluks?|talukas?|tehsils?|tahsils?|blocks?|sub[- ]?division|municipal corporation|corporation)\b/g, ' ')
    .replace(/[^a-z]/g, '');
}

// Official and older spellings that are far apart as strings.
const ALIASES = [
  ['anantapur', 'anantapuramu', 'ananthapur', 'ananthapuramu'],
  ['srisathyasai', 'srisatyasai', 'sathyasai', 'satyasai'],
  ['kadapa', 'ysrkadapa', 'ysr', 'cuddapah', 'ysrdistrict'],
  ['nellore', 'spsrnellore', 'spsnellore', 'pottisriramulunellore'],
  ['visakhapatnam', 'vishakhapatnam', 'vizag'],
  ['tirupati', 'tirupathi'], ['kakinada', 'eastgodavari'],
  ['bengaluruurban', 'bangaloreurban'], ['bengalururural', 'bangalorerural'], ['bengaluru', 'bangalore'],
  ['mysuru', 'mysore'], ['belagavi', 'belgaum'], ['kalaburagi', 'gulbarga'], ['ballari', 'bellary'],
  ['shivamogga', 'shimoga'], ['tumakuru', 'tumkur'], ['chikkaballapura', 'chikballapur'],
  ['chennai', 'madras'], ['tiruchirappalli', 'tiruchirapalli', 'trichy'], ['thoothukudi', 'tuticorin'],
  ['kanniyakumari', 'kanyakumari'], ['puducherry', 'pondicherry'],
  ['gurugram', 'gurgaon'], ['prayagraj', 'allahabad'], ['ayodhya', 'faizabad'],
  ['kolkata', 'calcutta'], ['mumbai', 'bombay'], ['thiruvananthapuram', 'trivandrum'], ['kochi', 'cochin', 'ernakulam'],
];
const ALIAS = new Map();
for (const group of ALIASES) for (const k of group) ALIAS.set(k, group);

function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
/** Same place name, allowing for aliases and a typo or two in long names. */
export function sameName(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const ga = ALIAS.get(a);
  if (ga && ga.includes(b)) return true;
  const n = Math.min(a.length, b.length);
  if (n < 5) return false;
  return editDistance(a, b, n >= 10 ? 2 : 1) <= (n >= 10 ? 2 : 1);
}

/** Place names in an alert's area description. */
export function areaNames(area) {
  const out = [];
  const text = String(area || '').replace(/\b(districts?|mandals?) of [A-Za-z &]+$/i, '$1');
  for (const raw of text.split(/,|;|\band\b|\n/)) {
    const part = raw.trim();
    if (!part) continue;
    out.push(nameKey(part));
    // "ksm-katrenikona Mandal": a short district prefix, then the mandal
    const dash = part.split(/\s*-\s*/);
    if (dash.length > 1) for (const p of dash) out.push(nameKey(p));
  }
  return [...new Set(out.filter((k) => k.length >= 3))];
}

// Which states an IMD centre warns for (to list "elsewhere in your state").
const IMD_STATES = {
  chennai: ['tamilnadu', 'puducherry'], amaravati: ['andhrapradesh'], visakhapatnam: ['andhrapradesh'],
  hyderabad: ['telangana'], bengaluru: ['karnataka'], thiruvananthapuram: ['kerala', 'lakshadweep'],
  mumbai: ['maharashtra'], nagpur: ['maharashtra'], goa: ['goa'], raipur: ['chhattisgarh'],
  bhubaneswar: ['odisha'], kolkata: ['westbengal', 'andamanandnicobarislands'], guwahati: ['assam', 'meghalaya', 'arunachalpradesh', 'nagaland', 'manipur', 'mizoram'],
  agartala: ['tripura'], gangtok: ['sikkim'], patna: ['bihar'], ranchi: ['jharkhand'], lucknow: ['uttarpradesh'],
  bhopal: ['madhyapradesh'], ahmedabad: ['gujarat', 'dadraandnagarhavelianddamananddiu'], jaipur: ['rajasthan'],
  chandigarh: ['punjab', 'haryana', 'chandigarh'], delhi: ['delhi'], newdelhi: ['delhi'], dehradun: ['uttarakhand'],
  shimla: ['himachalpradesh'], srinagar: ['jammuandkashmir', 'ladakh'],
};
function alertStates(a) {
  const s = nameKey(a.sender);
  if (s.startsWith('imd')) return IMD_STATES[s.slice(3)] || [];
  return [s.replace(/sdma$|sdmaauthority$|stateemergencyoperationcentre$|seoc$/, '')];
}

/**
 * Sort alerts for a place. place: { state, district, sub, town } names.
 * Returns { here: [{ alert, level: 'local'|'district'|'state' }], state: [alerts elsewhere in the state] }
 */
export function matchAlerts(alerts, place) {
  const here = [], elsewhere = [];
  if (!place || !Array.isArray(alerts)) return { here, state: elsewhere };
  const local = [place.sub, place.town].map(nameKey).filter(Boolean);
  const district = nameKey(place.district);
  const stateK = nameKey(place.state);
  for (const a of alerts) {
    const names = areaNames(a.area);
    const areaK = nameKey(a.area);
    let level = null;
    if (names.some((n) => local.some((l) => sameName(n, l)))) level = 'local';
    else if (district && names.some((n) => sameName(n, district))) level = 'district';
    else if (stateK && (areaK === stateK || /all districts/i.test(a.area || '') && areaK.includes(stateK))) level = 'state';
    if (level) here.push({ alert: a, level });
    else if (stateK && (alertStates(a).includes(stateK) || areaK.endsWith(stateK))) elsewhere.push(a);
  }
  const rank = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3 };
  here.sort((x, y) => (rank[x.alert.severity] ?? 4) - (rank[y.alert.severity] ?? 4));
  return { here, state: elsewhere };
}

/** Thunderstorm, lightning or other convective weather. */
export const isStormAlert = (a) => /lightning|thunder|squall|hail|dust ?storm/i.test(`${a.event} ${a.headline}`);
export const isRainAlert = (a) => /rain|flood|cyclone|cloudburst|depression|storm surge/i.test(`${a.event} ${a.headline}`);

const LANG = { TL: 'Telugu', TE: 'Telugu', HI: 'Hindi', KN: 'Kannada', TA: 'Tamil', ML: 'Malayalam', MR: 'Marathi', OR: 'Odia', OD: 'Odia', BN: 'Bengali', GU: 'Gujarati', PA: 'Punjabi', AS: 'Assamese', UR: 'Urdu' };
export const languageName = (code) => LANG[String(code || '').toUpperCase()] || '';

/** "Andhra-Pradesh-SDMA" -> "Andhra Pradesh SDMA", "IMD-Chennai" -> "IMD Chennai". */
export const issuerName = (sender) => String(sender || '').replace(/-/g, ' ').replace(/\bSdma\b/i, 'SDMA');

/** A short place for the area: "Katrenikona mandal", "11 districts". */
export function areaLabel(a) {
  const names = String(a.area || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length > 2) return `${names.length} districts`;
  return names.map((n) => n.replace(/^[a-z]{2,4}-/i, '')).join(', ').replace(/\bMandal\b/i, 'mandal');
}
