// overlays.js — Leaflet rendering helpers (terminator, KC2G reference, footprint,
// path). Uses the global `L` provided by the Leaflet script tag.

import { terminatorPolyline, nightPolygon, destinationPoint } from './geo.js';

const L = window.L;
const KC2G_URL = 'https://prop.kc2g.com/renders/current/mufd-normal-now.svg';

/**
 * Day/night overlay: a dark shaded NIGHT hemisphere, the terminator boundary
 * line, and a subsolar "sun" marker. Returns a LayerGroup.
 */
export function makeTerminator(subsolar) {
  const night = L.polygon(nightPolygon(subsolar), {
    stroke: false, fillColor: '#000018', fillOpacity: 0.42, interactive: false,
  });
  const line = L.polyline(terminatorPolyline(subsolar), {
    color: '#f7a32f', weight: 1.5, dashArray: '4 4', opacity: 0.8, interactive: false,
  });
  const sun = L.circleMarker([subsolar.lat, subsolar.lon], {
    radius: 6, color: '#ffd451', fillColor: '#ffd451', fillOpacity: 0.9, weight: 1,
  }).bindTooltip('Subsolar point (local noon)');
  return L.layerGroup([night, line, sun]);
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

// Colour by reliability proxy: closer to FOT and fewer hops ⇒ stronger.
function sectorStyle(distKm) {
  // Nearer = more saturated; far multi-hop = fainter.
  const a = Math.max(0.12, 0.4 - distKm / 40000);
  return { color: '#2f81f7', weight: 0, fillColor: '#2f81f7', fillOpacity: a };
}

/**
 * Render a coverage footprint (from propagation.coverageFootprint) as annular
 * sectors. Returns a LayerGroup.
 */
export function makeFootprint(footprint) {
  const { txLat, txLon, azStepDeg, sectors } = footprint;
  const group = [];
  for (const sec of sectors) {
    for (const [d0, d1] of sec.intervals) {
      const ring = [];
      const az0 = sec.azimuth;
      const az1 = sec.azimuth + azStepDeg;
      // Outer arc forward, inner arc back → closed polygon.
      for (let az = az0; az <= az1; az += azStepDeg / 2) ring.push(destinationPoint(txLat, txLon, az, d1));
      for (let az = az1; az >= az0; az -= azStepDeg / 2) ring.push(destinationPoint(txLat, txLon, az, Math.max(1, d0)));
      group.push(L.polygon(ring, sectorStyle((d0 + d1) / 2)));
    }
  }
  const tx = L.circleMarker([txLat, txLon], {
    radius: 6, color: '#fff', fillColor: '#2f81f7', fillOpacity: 1, weight: 2,
  }).bindTooltip('TX');
  group.push(tx);
  return L.layerGroup(group);
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
