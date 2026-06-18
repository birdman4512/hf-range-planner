// overlays.js — Leaflet rendering helpers (terminator, KC2G reference, footprint,
// path). Uses the global `L` provided by the Leaflet script tag.

import { terminatorPolyline, nightPolygon, destinationPoint } from './geo.js';

const L = window.L;
const KC2G_URL = 'https://prop.kc2g.com/renders/current/mufd-normal-now.svg';

// The map repeats horizontally, so overlays are drawn on adjacent world copies.
const WORLD_COPIES = [-360, 0, 360];
const shiftLon = (pts, d) => pts.map(([lat, lon]) => [lat, lon + d]);

/**
 * Day/night overlay: a dark shaded NIGHT hemisphere, the terminator boundary
 * line, and a subsolar "sun" marker — repeated across world copies so the
 * shading continues as the user pans east/west. Returns a LayerGroup.
 */
export function makeTerminator(subsolar) {
  const night = nightPolygon(subsolar);
  const line = terminatorPolyline(subsolar);
  const items = [];
  for (const d of WORLD_COPIES) {
    items.push(L.polygon(shiftLon(night, d), {
      stroke: false, fillColor: '#000018', fillOpacity: 0.42, interactive: false,
    }));
    items.push(L.polyline(shiftLon(line, d), {
      color: '#f7a32f', weight: 1.5, dashArray: '4 4', opacity: 0.8, interactive: false,
    }));
    items.push(L.circleMarker([subsolar.lat, subsolar.lon + d], {
      radius: 6, color: '#ffd451', fillColor: '#ffd451', fillOpacity: 0.9, weight: 1,
    }).bindTooltip('Subsolar point (local noon)'));
  }
  return L.layerGroup(items);
}

/**
 * KC2G MUF reference overlay (equirectangular SVG). Alignment is approximate —
 * it is a third-party visual reference, not part of the model. Returns the
 * layer; caller toggles it. `onError` fires if the image fails to load.
 */
export function makeKc2gOverlay(onError) {
  const layer = L.imageOverlay(KC2G_URL, [[-90, -180], [90, 180]], {
    opacity: 0.55, interactive: false,
  });
  layer.on('error', () => onError && onError());
  return layer;
}

const FOOT_STYLE = { color: '#2f81f7', weight: 0, fillColor: '#2f81f7', fillOpacity: 0.33 };

/**
 * Render a coverage footprint (from propagation.coverageFootprint) as one
 * smooth filled wedge per azimuth, spanning from the inner reach edge (the
 * skip-zone boundary) out to the maximum reach in that direction. Closed
 * directions produce no wedge, so the result reads as a filled coverage region
 * with a central skip-zone hole and angular gaps — not radial streaks.
 */
// Circular 3-point median — kills isolated single-azimuth spikes/dropouts.
function medianSmooth(arr) {
  const n = arr.length;
  return arr.map((_, i) => {
    const t = [arr[(i - 1 + n) % n], arr[i], arr[(i + 1) % n]].sort((x, y) => x - y);
    return t[1];
  });
}

// Circular moving average over ±w samples — smooths the envelope so the
// day/night terminator "comb" merges into a continuous coverage region.
function circMean(arr, w) {
  const n = arr.length;
  return arr.map((_, i) => {
    let sum = 0;
    for (let k = -w; k <= w; k++) sum += arr[(i + k + n) % n];
    return sum / (2 * w + 1);
  });
}

/**
 * One smooth filled polygon: an outer reach envelope with a skip-zone hole.
 * Directions that are closed collapse the envelope toward the TX, reading as
 * gaps/notches rather than radial streaks.
 */
export function makeFootprint(footprint) {
  const { txLat, txLon, azStepDeg, sectors } = footprint;
  const n = sectors.length;
  if (!n) return L.layerGroup([]);

  const outer = circMean(medianSmooth(sectors.map((s) => (s.intervals.length ? s.intervals.at(-1)[1] : 0))), 2);
  const inner = circMean(medianSmooth(sectors.map((s) => (s.intervals.length ? s.intervals[0][0] : 0))), 1);
  if (outer.every((v) => v <= 1)) return L.layerGroup([]);

  const mid = (i) => sectors[i].azimuth + azStepDeg / 2;
  const outerRing = [];
  const innerRing = [];
  for (let i = 0; i < n; i++) {
    outerRing.push(destinationPoint(txLat, txLon, mid(i), Math.max(1, outer[i])));
    innerRing.push(destinationPoint(txLat, txLon, mid(i), Math.max(1, inner[i])));
  }
  // Polygon with a hole: [outer ring, inner ring (reversed)].
  const poly = L.polygon([outerRing, innerRing.reverse()], FOOT_STYLE);
  return L.layerGroup([poly]);
}

/** Render a great-circle path with hop reflection points. Returns a LayerGroup. */
export function makePath(a, b, analysis) {
  const items = [];
  items.push(L.polyline([[a.lat, a.lon], [b.lat, b.lon]], { color: '#2f81f7', weight: 3, opacity: 0.9 }));
  for (const [lat, lon] of analysis.groundPoints) {
    items.push(L.circleMarker([lat, lon], {
      radius: 4, color: '#f7a32f', fillColor: '#f7a32f', fillOpacity: 0.9, weight: 1,
    }).bindTooltip('Ground reflection'));
  }
  return L.layerGroup(items);
}
