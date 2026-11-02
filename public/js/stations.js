// IMD Doppler weather radar network: which radars see a location, and how well.
//
// Positions come from IMD's radar network page (mausam.imd.gov.in/responsive/radar.php). Four
// entries on that page carry another station's coordinates (Delhi-HQ, Jammu, Tezpur, Jot); those are
// replaced here by the town's position. Accuracy is a few kilometres, which is plenty for distances
// of tens to hundreds of kilometres.

import { haversineKm } from './util.js';

// [IMD page id, display name, lat, lon]
export const IMD_RADARS = [
  ['Bhopal', 'Bhopal', 23.2599, 77.4126], ['Agartala', 'Agartala', 23.8315, 91.2868],
  ['Ayanagar', 'Delhi-Ayanagar', 28.4833, 77.125], ['Delhi', 'Delhi-HQ', 28.5893, 77.2225],
  ['Dimapur', 'Dimapur', 25.9028, 93.7031], ['Bhuj', 'Bhuj', 23.242, 69.6669],
  ['Chennai', 'Chennai', 12.9333, 80.2], ['Goa', 'Goa', 15.4909, 73.8278],
  ['Solapur', 'Solapur', 17.6599, 75.9064], ['Gopalpur', 'Gopalpur', 19.2647, 84.862],
  ['Hyderabad', 'Hyderabad', 17.385, 78.4867], ['Jaipur', 'Jaipur', 26.9124, 75.7873],
  ['Kolkata', 'Kolkata', 22.5726, 88.3639], ['Kochi', 'Kochi', 9.9312, 76.2673],
  ['Karaikal', 'Karaikal', 10.9254, 79.838], ['Lucknow', 'Lucknow', 26.8467, 80.9462],
  ['Machilipatnam', 'Machilipatnam', 16.1905, 81.1362], ['Banihal', 'Banihal', 33.51, 75.205],
  ['Panvel', 'Panvel', 18.9319, 73.1622], ['Vile Parle', 'Mumbai-Vile Parle', 19.1072, 72.8369],
  ['Kalyan-Dombivli', 'Kalyan-Dombivli', 19.2267, 73.1183], ['Vasai-Virar', 'Vasai-Virar', 19.3839, 72.8286],
  ['Sambalpur', 'Sambalpur', 21.5374, 83.9809], ['Belonia', 'Belonia', 23.2489, 91.463],
  ['Mumbai-Veravali', 'Mumbai-Veravali', 19.1342, 72.8672], ['Mahabaleshwar', 'Mahabaleshwar', 17.9217, 73.6556],
  ['Mumbai-Colaba', 'Mumbai-Colaba', 19.076, 72.8777], ['Nagpur', 'Nagpur', 21.1458, 79.0882],
  ['Sohra', 'Sohra', 25.2702, 91.7323], ['Patiala', 'Patiala', 30.3398, 76.3869],
  ['Patna', 'Patna', 25.5941, 85.1376], ['Leh', 'Leh', 34.2833, 77.2833],
  ['Srinagar', 'Srinagar', 34.0517, 74.805], ['Jammu', 'Jammu', 32.7266, 74.857],
  ['Tezpur', 'Tezpur', 26.6338, 92.8], ['Thiruvananthapuram', 'Thiruvananthapuram', 8.5241, 76.9366],
  ['Visakhapatnam', 'Visakhapatnam', 17.6868, 83.2185], ['Mohanbari', 'Mohanbari', 27.4728, 94.912],
  ['Paradip', 'Paradip', 20.3166, 86.6114], ['Sriharikota', 'Sriharikota', 13.7259, 80.2266],
  ['Jot', 'Jot', 32.4867, 76.05], ['Murari', 'Murari Devi', 31.505, 76.8133],
  ['Palam', 'Delhi-Palam', 28.5901, 77.0888], ['Mukteshwar', 'Mukteshwar', 29.46, 79.66],
  ['Kufri', 'Kufri', 31.0983, 77.265], ['Surkandaji', 'Surkanda Devi', 30.4117, 78.2883],
  ['Lansdowne', 'Lansdowne', 29.85, 78.6767], ['Raipur', 'Raipur', 21.25, 81.63],
  ['Mangaluru', 'Mangaluru', 12.95, 74.84], ['Pallikaranai', 'Chennai-Pallikaranai', 12.9451, 80.2115],
  ['Jorhat', 'Jorhat', 26.7169, 94.194], ['Silkheda', 'Silkheda', 23.5716, 77.2461],
];

const R_EFF = (6371 * 4) / 3; // standard 4/3-Earth radius for radar propagation

/** Height (km) of the radar beam centre above the radar at a ground distance, for a 0.5° scan. */
export function beamHeightKm(distKm, elevDeg = 0.5) {
  const th = (elevDeg * Math.PI) / 180;
  return Math.sqrt(distKm * distKm + R_EFF * R_EFF + 2 * distKm * R_EFF * Math.sin(th)) - R_EFF;
}

function bearingDeg(lat1, lon1, lat2, lon2) {
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180, dl = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** The n nearest IMD radars: distance, direction from the location, and beam height over it. */
export function nearestRadars(lat, lon, n = 3) {
  return IMD_RADARS
    .map(([id, name, rlat, rlon]) => {
      const distKm = haversineKm(lat, lon, rlat, rlon);
      return {
        id, name, lat: rlat, lon: rlon, distKm,
        bearing: bearingDeg(lat, lon, rlat, rlon),
        beamKm: beamHeightKm(distKm),
        url: `https://mausam.imd.gov.in/responsive/radar.php?id=${encodeURIComponent(id)}`,
      };
    })
    .sort((a, b) => a.distKm - b.distKm)
    .slice(0, n);
}

/**
 * How much to trust the radar picture at a location (weakest link of coverage, freshness and beam
 * height). Far from a radar the lowest beam passes kilometres above the ground and misses shallow
 * rain, so distance matters as much as whether the location is inside the coverage area.
 */
export function radarConfidence({ available, coverageNear, ageMin, stale, beamKm }) {
  if (!available) return { level: 'None', score: 0, limit: 'unavailable' };
  const cov = Math.max(0, Math.min(1, (coverageNear ?? 0) / 0.9));
  const age = stale ? 0.2 : ageMin <= 15 ? 1 : ageMin <= 30 ? 0.7 : ageMin <= 60 ? 0.4 : 0.1;
  const beam = !Number.isFinite(beamKm) ? 0.5 : beamKm <= 2 ? 1 : beamKm <= 3.5 ? 0.8 : beamKm <= 5 ? 0.55 : beamKm <= 7 ? 0.35 : 0.2;
  const parts = { coverage: cov, age, beam };
  let limit = 'coverage', score = cov;
  for (const [k, v] of Object.entries(parts)) if (v < score) { score = v; limit = k; }
  const level = score >= 0.75 ? 'High' : score >= 0.45 ? 'Moderate' : 'Low';
  return { level, score, limit, parts };
}
