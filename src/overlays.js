// overlays.js — Leaflet rendering helpers (terminator, KC2G reference, footprint,
// path). Uses the global `L` provided by the Leaflet script tag.

import { terminatorPolyline, nightPolygon, intermediatePoint } from './geo.js';

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

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Render a GLOBAL coverage grid (from propagation.coverageGrids) as a reprojected
 * raster overlay — no range limit, and poles/antipodes render correctly (unlike
 * polygons). Cell values are reliability 0–255: shading deepens with
 * reliability and cells below ~5 % are left clear. The blocky grid is
 * bilinearly smoothed and drawn on every world copy. Pass { color, opacity }.
 */
export function makeFootprintRaster(grid, { color = '#2f81f7', opacity = 0.4 } = {}) {
  const { nLat, nLon, cells } = grid;
  const [r, g, b] = hexToRgb(color);
  const maxA = Math.min(1, opacity) * 255;

  // Equirectangular source canvas (lat +90 at the top row).
  const eq = document.createElement('canvas');
  eq.width = nLon; eq.height = nLat;
  const ectx = eq.getContext('2d');
  const id = ectx.createImageData(nLon, nLat);
  for (let iLat = 0; iLat < nLat; iLat++) {
    const y = nLat - 1 - iLat;
    for (let iLon = 0; iLon < nLon; iLon++) {
      const rel = cells[iLat * nLon + iLon] / 255;
      if (rel >= 0.05) {
        const p = (y * nLon + iLon) * 4;
        id.data[p] = r; id.data[p + 1] = g; id.data[p + 2] = b;
        id.data[p + 3] = Math.round(maxA * (0.25 + 0.75 * Math.min(1, rel / 0.9)));
      }
    }
  }
  ectx.putImageData(id, 0, 0);

  // Reproject equirectangular → Mercator (cheap canvas→canvas row copies).
  const W = 720, H = 720;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  const yTop = Math.log(Math.tan(Math.PI / 4 + (MERC_MAX * Math.PI / 180) / 2));
  for (let j = 0; j < H; j++) {
    const my = yTop - (2 * yTop) * (j / (H - 1));
    const lat = (2 * Math.atan(Math.exp(my)) - Math.PI / 2) * 180 / Math.PI;
    const srcRow = Math.max(0, Math.min(nLat - 1, ((90 - lat) / 180) * nLat));
    ctx.drawImage(eq, 0, srcRow, nLon, 1, 0, j, W, 1);
  }

  const url = cv.toDataURL('image/png');
  const group = L.layerGroup();
  for (const d of WORLD_COPIES) {
    L.imageOverlay(url, [[-MERC_MAX, -180 + d], [MERC_MAX, 180 + d]], { interactive: false }).addTo(group);
  }
  return group;
}

/** Render a great-circle path with hop reflection points, on every world copy. */
export function makePath(a, b, analysis) {
  const items = [];
  // Sample the great circle so the line passes through the reflection points.
  const pts = [];
  for (let i = 0; i <= 64; i++) pts.push(intermediatePoint(a.lat, a.lon, b.lat, b.lon, i / 64));
  const line = unwrapLon(pts);
  for (const d of WORLD_COPIES) {
    items.push(L.polyline(shiftLon(line, d), { color: '#2f81f7', weight: 3, opacity: 0.9 }));
    for (const [lat, lon] of analysis.groundPoints) {
      // Put each marker on the same world copy as the unwrapped line.
      const near = line.reduce((x, p) => (Math.abs(p[0] - lat) < Math.abs(x[0] - lat) ? p : x));
      const lw = lon + 360 * Math.round((near[1] - lon) / 360);
      items.push(L.circleMarker([lat, lw + d], {
        radius: 4, color: '#f7a32f', fillColor: '#f7a32f', fillOpacity: 0.9, weight: 1,
      }).bindTooltip('Ground reflection'));
    }
  }
  return L.layerGroup(items);
}

/**
 * Ionosonde stations used for assimilation, coloured by foF2, with a tooltip of
 * the latest observation. Drawn on every world copy.
 */
export function makeIonosondeMarkers(stations) {
  const items = [];
  const colour = (f) => (f >= 10 ? '#ff6b6b' : f >= 7 ? '#ffb454' : f >= 5 ? '#e6db74' : f >= 3 ? '#7ee787' : '#79c0ff');
  for (const s of stations) {
    const age = Math.round((Date.now() - s.timeMs) / 60000);
    const mufd = Number.isFinite(s.M3000) ? (s.foF2 * s.M3000).toFixed(1) : '—';
    const tip = `${s.name} (${s.code})<br>foF2 ${s.foF2.toFixed(2)} MHz · MUF(3000) ${mufd} MHz` +
      (Number.isFinite(s.foEs) ? ` · foEs ${s.foEs.toFixed(1)}` : '') + `<br>${age} min ago`;
    for (const d of WORLD_COPIES) {
      items.push(L.circleMarker([s.lat, s.lon + d], {
        radius: 5, color: '#0e1116', weight: 1, fillColor: colour(s.foF2), fillOpacity: 0.95,
      }).bindTooltip(tip));
    }
  }
  return L.layerGroup(items);
}
