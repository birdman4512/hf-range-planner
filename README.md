# HF Range Planner

An interactive, browser-based **HF skywave propagation planner** — the HF cousin of a
VHF/UHF line-of-sight tool. Instead of terrain line-of-sight, it models how signals refract
off the ionosphere ("skip"), driven by live solar weather and path geometry.

Two modes:

1. **Coverage** — pick a TX site + frequency, and see where the signal lands: the **skip
   zone**, hop-landing rings, NVIS near-in coverage, and a max-reach estimate.
2. **Path / Band** — drop two markers and get the **best band** for that path right now
   (MUF / FOT / LUF), a per-band open/marginal/closed table, and a reliability estimate.

It folds in **live space weather** (NOAA SWPC, with manual override), a **day/night
overlay**, optional **KC2G MUF reference overlay**, and **ground-reflection clutter**
(sea vs land) at each bounce.

It's also an **installable PWA** (web app manifest + service worker): add it to your home
screen / desktop and the app shell works offline (live data and map tiles still need a
connection).

> ⚠️ **Estimates only.** This is a self-contained analytic model calibrated to typical
> ionospheric behaviour — *not* VOACAP or ITU-R P.533. Use it for planning intuition, not
> guarantees.

## Does it work locally? (Yes)

It's pure static files — HTML, CSS, and ES-module JavaScript. **No build step, no bundler.**
Clone it and serve the folder over HTTP with *any* static server.

> You must serve it over `http://` (or `https://`). Opening `index.html` as a `file://` URL
> will **not** work, because browsers block ES-module imports and `fetch()` on `file://`.
> This is the same reason ClearPath ships an `npm run serve`.

Pick whichever you have installed:

```bash
# Node (matches CI / deploy)
npm install
npm run serve            # → http://localhost:8080

# Python 3 (no Node needed)
python -m http.server 8080   # (or:  py -m http.server 8080  on Windows)

# VS Code: right-click index.html → "Open with Live Server"
```

Then open the printed URL. Geolocation ("📍 My location") needs `https://` or `localhost`
— both the dev server and the deployed GitHub Pages site qualify.

## Tests

```bash
npm run lint        # syntax-check all JS (no build)
npm run test:unit   # Node built-in test runner — geometry + ionosphere + propagation math
npm run test:smoke  # Playwright: app boots, modules load, no console/CSP errors
npm run verify      # lint + unit tests (the CI gate)
```

The propagation math is exercised by `tests/unit/*.test.mjs` against known-value sanity
checks (single-hop max range ≈ 3800 km, M-factor bounds, foF2 day/night ranges, FOT ≈
0.85·MUF, a reference daytime path MUF).

## How it works

| Module | Responsibility |
| --- | --- |
| [`src/geo.js`](src/geo.js) | Great-circle distance/bearing/destination, solar position (subsolar point, zenith angle), terminator + night polygon |
| [`src/solar.js`](src/solar.js) | Live NOAA SWPC fetch (SFI, Kp), SFI↔SSN conversion, graceful offline defaults |
| [`src/iono.js`](src/iono.js) | foF2 / foE / layer heights / D-layer absorption from SSN + zenith angle |
| [`src/propagation.js`](src/propagation.js) | Hop geometry, MUF/LUF/FOT, per-azimuth coverage footprint, point-to-point band recommendation |
| [`src/clutter.js`](src/clutter.js) | Coarse sea/land/ice classification + per-bounce reflection loss |
| [`src/overlays.js`](src/overlays.js) | Leaflet rendering: day/night, KC2G overlay, footprint sectors, path |
| [`app.js`](app.js) | UI wiring and orchestration |

### The model in one paragraph

For a path, the ionosphere is sampled at each hop's reflection point. Layer critical
frequencies (foF2/foE) come from the sunspot number and the local solar zenith angle; the
**MUF** is the critical frequency times the geometry-derived secant factor, limited by the
weakest hop. The **LUF** is solved from cumulative D-layer absorption (daytime only). The
**FOT** (≈ 0.85·MUF) is the day-to-day reliable working frequency. Coverage footprints reuse
the same path analysis across every azimuth and distance, so the skip zone falls out
naturally as the near-in gap where the frequency exceeds the short-hop MUF.

### Data sources

- **Solar weather** — [NOAA SWPC](https://services.swpc.noaa.gov/) JSON (CORS-enabled).
- **KC2G MUF overlay** — [prop.kc2g.com](https://prop.kc2g.com/) (IRI-2020 + GIRO ionosonde
  assimilation). Optional, best-effort, approximate alignment; not part of the model.
- **Basemap** — OpenStreetMap tiles.

## Deploy

Pushes to `main` run the gated **CI & Deploy** workflow: lint + unit + smoke tests must pass
before a clean `_site/` is assembled and published to GitHub Pages. Enable Pages →
"GitHub Actions" in repo settings.

## License

MIT.
