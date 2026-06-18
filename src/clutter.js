// clutter.js — ground-reflection surface classification and per-bounce loss.
//
// At each intermediate ground reflection of a multi-hop path the wave loses
// energy; sea water (high conductivity) reflects far better than dry/urban
// ground. This module classifies a reflection point and returns a per-bounce
// loss used to gate the usable hop count and the reliability estimate.
//
// v1 classification is COARSE and clearly flagged: a built-in set of major
// ocean bounding boxes marks likely sea paths, everything else is treated as
// average land. The loss model and the injection seam are the real engineering
// — a higher-resolution land/sea raster can replace `classifySurface` later
// without touching the propagation code.

/** Surface types and their typical ground-reflection loss (dB per bounce, mid-HF). */
export const SURFACE = {
  sea: { label: 'Sea water', lossDb: 0.5 },
  land: { label: 'Average land', lossDb: 2.5 },
  poor: { label: 'Poor/urban ground', lossDb: 4.0 },
  ice: { label: 'Ice/snow', lossDb: 3.5 },
};

// Coarse major-ocean bounding boxes: [latMin, latMax, lonMin, lonMax].
// Deliberately conservative (deep-ocean cores) to avoid calling coastal land sea.
const OCEAN_BOXES = [
  [-55, 60, -65, -15],  // Atlantic (mid)
  [-55, 20, -180, -85], // E Pacific
  [-55, 30, 140, 180],  // W Pacific
  [-55, 25, 45, 100],   // Indian
  [-75, -60, -180, 180],// Southern Ocean
];

function inBox(lat, lon, [a, b, c, d]) {
  return lat >= a && lat <= b && lon >= c && lon <= d;
}

/**
 * Classify the surface at a reflection point. Returns a key of SURFACE.
 * @param {number} lat
 * @param {number} lon
 * @param {(lat:number,lon:number)=>('sea'|'land'|'poor'|'ice'|null)} [maskFn]
 *   Optional higher-resolution classifier; if it returns a value it wins.
 */
export function classifySurface(lat, lon, maskFn) {
  if (maskFn) {
    const m = maskFn(lat, lon);
    if (m) return m;
  }
  if (Math.abs(lat) > 70) return 'ice';
  for (const box of OCEAN_BOXES) if (inBox(lat, lon, box)) return 'sea';
  return 'land';
}

/** Per-bounce ground reflection loss (dB) at a reflection point. */
export function bounceLossDb(lat, lon, maskFn) {
  return SURFACE[classifySurface(lat, lon, maskFn)].lossDb;
}

/**
 * Total ground-reflection loss for a path: there are (hopCount − 1) intermediate
 * ground bounces between TX and RX. `reflectionPoints` are the [lat,lon] of those
 * intermediate touch-downs (not the TX/RX endpoints).
 */
export function groundReflectionLossDb(reflectionPoints, maskFn) {
  let total = 0;
  const detail = [];
  for (const [lat, lon] of reflectionPoints) {
    const key = classifySurface(lat, lon, maskFn);
    total += SURFACE[key].lossDb;
    detail.push({ lat, lon, surface: key });
  }
  return { totalDb: total, detail };
}
