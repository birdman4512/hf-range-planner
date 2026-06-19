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

// Keep a ring's longitudes continuous so polygons that cross the ±180° date
// line don't draw a chord across the whole map (Leaflet handles lon outside
// [-180,180] fine via worldCopyJump).
function unwrapLon(points) {
  let prev = null;
  return points.map(([lat, lon]) => {
    if (prev !== null) {
      while (lon - prev > 180) lon -= 360;
      while (lon - prev < -180) lon += 360;
    }
    prev = lon;
    return [lat, lon];
  });
}

/**
 * Render one smoothed coverage tier (inner/outer reach per azimuth) as seamless
 * filled polygons: each contiguous open arc becomes a single polygon (no
 * internal radial seams), with real gaps between arcs (no chords) and date-line
 * safe longitudes. Returns an array of L.polygon.
 */
function arcPolygons(txLat, txLon, azStepDeg, sectors, innerRaw, outerRaw, style) {
  const n = sectors.length;
  const outer = circMean(medianSmooth(outerRaw), 3);
  const inner = circMean(medianSmooth(innerRaw), 2);
  const arcStep = Math.min(2, azStepDeg / 2);
  const dest = (az, d) => destinationPoint(txLat, txLon, az, Math.max(1, d));
  const open = outer.map((v) => v > 50);
  if (!open.some(Boolean)) return [];

  // Fully open → one seamless annulus with a skip-zone hole.
  if (open.every(Boolean)) {
    const outerRing = [], innerRing = [];
    for (let i = 0; i < n; i++) {
      const azc = sectors[i].azimuth + azStepDeg / 2;
      outerRing.push(dest(azc, outer[i]));
      innerRing.push(dest(azc, inner[i]));
    }
    return [L.polygon([unwrapLon(outerRing), unwrapLon(innerRing.reverse())], style)];
  }

  // Otherwise one polygon per contiguous open arc. Anchor at a closed sector.
  let start = 0;
  while (open[start]) start++;
  const order = Array.from({ length: n }, (_, k) => (start + k) % n);
  const polys = [];
  let run = [];
  const flush = () => {
    if (!run.length) return;
    const pts = [];
    for (const idx of run) {
      const a0 = sectors[idx].azimuth, a1 = a0 + azStepDeg;
      for (let az = a0; az <= a1 + 1e-6; az += arcStep) pts.push(dest(az, outer[idx]));
    }
    for (let r = run.length - 1; r >= 0; r--) {
      const idx = run[r], a0 = sectors[idx].azimuth, a1 = a0 + azStepDeg;
      for (let az = a1; az >= a0 - 1e-6; az -= arcStep) pts.push(dest(az, inner[idx]));
    }
    polys.push(L.polygon(unwrapLon(pts), style));
    run = [];
  };
  for (const idx of order) (open[idx] ? run.push(idx) : flush());
  flush();
  return polys;
}

/**
 * Render a coverage footprint with graded reliability: a faint full-reach area
 * plus a brighter "reliable core" near the FOT sweet-spot. Pass { color, opacity }
 * to tint (e.g. dual A/B coverage).
 */
export function makeFootprint(footprint, { color = '#2f81f7', opacity = 0.32 } = {}) {
  const { txLat, txLon, azStepDeg, sectors } = footprint;
  if (!sectors.length) return L.layerGroup([]);

  const reach = arcPolygons(
    txLat, txLon, azStepDeg, sectors,
    sectors.map((s) => s.reachInner), sectors.map((s) => s.reachOuter),
    { color, weight: 0, fillColor: color, fillOpacity: opacity * 0.5 },
  );
  const core = arcPolygons(
    txLat, txLon, azStepDeg, sectors,
    sectors.map((s) => s.goodInner), sectors.map((s) => s.goodOuter),
    { color, weight: 0, fillColor: color, fillOpacity: opacity },
  );
  return L.layerGroup([...reach, ...core]);
}

/** Render a great-circle path with hop reflection points. Returns a LayerGroup. */
export function makePath(a, b, analysis) {
  const items = [];
  const line = unwrapLon([[a.lat, a.lon], [b.lat, b.lon]]);
  items.push(L.polyline(line, { color: '#2f81f7', weight: 3, opacity: 0.9 }));
  for (const [lat, lon] of analysis.groundPoints) {
    items.push(L.circleMarker([lat, lon], {
      radius: 4, color: '#f7a32f', fillColor: '#f7a32f', fillOpacity: 0.9, weight: 1,
    }).bindTooltip('Ground reflection'));
  }
  return L.layerGroup(items);
}
