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

// KC2G renders an equirectangular SVG with axes/labels around a plot area. These
// are the plot-area bounds in viewBox units (lon −180..180, lat 90..−90).
const KC2G_VB_W = 1144.848;
const KC2G_MAP = { x: 35.305, y: 24.142, w: 1092.8, h: 546.4 };
const MERC_MAX = 85.0511287798;

/**
 * KC2G MUF reference overlay. The source is equirectangular but our map is Web
 * Mercator, so we crop to the plot area and reproject (row-by-row) onto a canvas
 * before overlaying — that makes it actually line up. Returns a LayerGroup that
 * fills in once the image loads; `onError` fires if it can't (CORS/network).
 */
export function makeKc2gOverlay(onError) {
  const group = L.layerGroup();
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    try {
      // Rasterize the (complex) SVG plot area ONCE to a source canvas — drawing
      // an SVG is expensive, so we must not do it per output row.
      const s = img.naturalWidth / KC2G_VB_W;
      const srcW = Math.round(KC2G_MAP.w * s), srcH = Math.round(KC2G_MAP.h * s);
      const src = document.createElement('canvas');
      src.width = srcW; src.height = srcH;
      src.getContext('2d').drawImage(
        img, KC2G_MAP.x * s, KC2G_MAP.y * s, KC2G_MAP.w * s, KC2G_MAP.h * s, 0, 0, srcW, srcH);

      // Reproject equirectangular → Mercator with cheap canvas→canvas row copies.
      const W = 900, H = 900;
      const cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const ctx = cv.getContext('2d');
      const yTop = Math.log(Math.tan(Math.PI / 4 + (MERC_MAX * Math.PI / 180) / 2));
      for (let j = 0; j < H; j++) {
        const my = yTop - (2 * yTop) * (j / (H - 1));
        const lat = (2 * Math.atan(Math.exp(my)) - Math.PI / 2) * 180 / Math.PI;
        const srcRow = ((90 - lat) / 180) * srcH;
        ctx.drawImage(src, 0, srcRow, srcW, 1, 0, j, W, 1);
      }
      // Draw on each world copy so it repeats as the map scrolls.
      const url = cv.toDataURL('image/png');
      for (const d of WORLD_COPIES) {
        L.imageOverlay(url, [[-MERC_MAX, -180 + d], [MERC_MAX, 180 + d]], {
          opacity: 0.5, interactive: false,
        }).addTo(group);
      }
    } catch (e) {
      onError && onError();
    }
  };
  img.onerror = () => onError && onError();
  img.src = KC2G_URL;
  return group;
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
 * Build smoothed coverage-tier geometries (inner/outer reach per azimuth) as
 * seamless rings: each contiguous open arc is one geometry (no internal radial
 * seams), with real gaps between arcs (no chords) and date-line-safe longitudes.
 * Returns an array of geometries; each geometry is an array of rings suitable
 * for L.polygon (one ring = simple polygon; two rings = polygon with a hole).
 */
function arcGeometries(txLat, txLon, azStepDeg, sectors, innerRaw, outerRaw) {
  const n = sectors.length;
  const outer = circMean(medianSmooth(outerRaw), 3);
  const inner = circMean(medianSmooth(innerRaw), 2);

  // Don't let the coverage ring grow large enough to enclose the nearer pole —
  // a polygon that wraps a pole renders as horizontal-line artifacts. Clamp the
  // outer radius to stay a few degrees short of the pole (≈111 km per degree).
  const poleSafeKm = Math.max(2500, (90 - Math.abs(txLat) - 6) * 111.195);
  for (let i = 0; i < outer.length; i++) outer[i] = Math.min(outer[i], poleSafeKm);
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
    return [[unwrapLon(outerRing), unwrapLon(innerRing.reverse())]];
  }

  // Otherwise one geometry per contiguous open arc. Anchor at a closed sector.
  let start = 0;
  while (open[start]) start++;
  const order = Array.from({ length: n }, (_, k) => (start + k) % n);
  const geoms = [];
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
    geoms.push([unwrapLon(pts)]);
    run = [];
  };
  for (const idx of order) (open[idx] ? run.push(idx) : flush());
  flush();
  return geoms;
}

// Shift every ring of a geometry by dLon (for drawing across world copies).
const shiftGeom = (geom, d) => geom.map((ring) => shiftLon(ring, d));

/**
 * Render a coverage footprint as one clean filled region (the reachable area
 * with a skip-zone hole), drawn on every world copy so it wraps continuously as
 * the user pans. Pass { color, opacity } to tint per band.
 */
export function makeFootprint(footprint, { color = '#2f81f7', opacity = 0.32 } = {}) {
  const { txLat, txLon, azStepDeg, sectors } = footprint;
  if (!sectors.length) return L.layerGroup([]);

  const geoms = arcGeometries(txLat, txLon, azStepDeg, sectors,
    sectors.map((s) => s.reachInner), sectors.map((s) => s.reachOuter));

  const style = { color, weight: 0, fillColor: color, fillOpacity: opacity, interactive: false };
  const items = [];
  for (const d of WORLD_COPIES) {
    for (const g of geoms) items.push(L.polygon(shiftGeom(g, d), style));
  }
  return L.layerGroup(items);
}

/** Render a great-circle path with hop reflection points, on every world copy. */
export function makePath(a, b, analysis) {
  const items = [];
  const line = unwrapLon([[a.lat, a.lon], [b.lat, b.lon]]);
  for (const d of WORLD_COPIES) {
    items.push(L.polyline(shiftLon(line, d), { color: '#2f81f7', weight: 3, opacity: 0.9 }));
    for (const [lat, lon] of analysis.groundPoints) {
      items.push(L.circleMarker([lat, lon + d], {
        radius: 4, color: '#f7a32f', fillColor: '#f7a32f', fillOpacity: 0.9, weight: 1,
      }).bindTooltip('Ground reflection'));
    }
  }
  return L.layerGroup(items);
}
