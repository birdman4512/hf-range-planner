# HF Range Planner

An interactive, browser-based **HF skywave propagation planner** — the HF cousin of a
VHF/UHF line-of-sight tool. Instead of terrain line-of-sight, it models how signals refract
off the ionosphere ("skip"), driven by live solar weather and path geometry.

Two modes:

1. **Coverage** — pick a TX site and bands, and see where each lands, shaded by
   reliability: the **skip zone**, NVIS near-in coverage, and maximum reach.
2. **Path / Band** — drop two markers and get the **best band** for that path right now:
   MUF / FOT / LUF, per-band reliability and median SNR (short or long path), a link-budget
   breakdown, and a 24-hour band chart.

Predictions account for your **station** (power, mode, antenna type and height at both ends,
receive noise environment) and **live conditions**: smoothed sunspot number, Kp, GOES X-ray
flares and proton events from NOAA SWPC, plus **real-time ionosonde data** (GIRO via KC2G)
that corrects the ionospheric model.

It's also an **installable PWA** (web app manifest + service worker): add it to your home
screen / desktop and the app shell works offline (live data and map tiles still need a
connection).

> ⚠️ **Still a model.** The method follows ITU-R P.533 closely and is checked against real
> WSPR receptions (see *Validation*), but it is not a certified P.533 implementation, and
> sporadic-E is only known where an ionosonde sees it.

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
npm run test:unit   # Node built-in test runner — geometry, field, ionosphere, link budget
npm run test:smoke  # Playwright: app boots, modules load, no console/CSP errors
npm run verify      # lint + unit tests (the CI gate)
```

**No Node?** Serve the repo and open `/tests/browser/index.html` — it runs the same
`tests/unit/*.test.mjs` files in the browser (an import map stands in for `node:test`).

The unit tests check the model against reference values: IGRF field vs the BGS calculator,
CCIR climatology (diurnal shape, winter anomaly, equatorial anomaly, solar-cycle saturation),
P.1239 foE, P.1240 MUF, P.372 noise, Fresnel reflection and antenna patterns. They also
include a leave-one-out test on a real ionosonde snapshot (`tests/fixtures/`) showing the
assimilation beats the plain median model.

## Validation

[`tools/validate.html`](tools/validate.html) (also deployed at `…/tools/validate.html`) scores
the model against **complete WSPR reception data** from [wspr.live](https://wspr.live). For
each 2-minute slot and band, a transmitter→receiver pair is labelled *decoded* or *not
decoded*, using only transmitters demonstrably on the air and receivers demonstrably
listening on that band. It reports ROC AUC, Brier score, log-loss and a calibration table on
held-out slots, and can re-fit the calibration constants (`CALIBRATION` in
`src/propagation.js`).

Results from 2026-10-02 (held-out hours, never used for fitting):

| Model | ROC AUC | Log-loss | Brier |
| --- | --- | --- | --- |
| Previous analytic model | 0.717 | 0.362 | 0.0672 |
| **Current model** | **0.843** | **0.230** | **0.0622** |
| Constant guess (base rate) | 0.500 | 0.268 | 0.0698 |

*6 held-out hours, 67,716 transmitter→receiver pairs, all bands 160–10 m.* The previous
model's log-loss was worse than a constant guess (confidently wrong). Per-band AUC for the
current model runs 0.79–0.93. On a further 24 h of held-out slots the shipped calibration scored AUC 0.848 and
predicted decode rates of 0.8 % vs 1.5 % observed and 18.1 % vs 17.8 % observed.

How to read this: even on a wide-open path only about 20 % of WSPR station pairs decode
each other (weak receive setups, band-hopping receivers, slot collisions). The validation
models that as a separate *network ceiling* so it doesn't distort the propagation
constants. The fitted constants are a D-layer absorption scale of 0.3 (textbook
George–Bradley absorption is too high for these paths), a +8 dB system offset, and
σ = 10 dB. The absorption scale is only loosely pinned down: refits on different days land
anywhere from 0.2 to 0.7 with almost the same score.

## How it works

| Module | Responsibility |
| --- | --- |
| [`src/geo.js`](src/geo.js) | Great-circle geometry, solar position, terminator |
| [`src/magnetic.js`](src/magnetic.js) | IGRF-14 field → magnetic dip, MODIP, geomagnetic latitude, gyrofrequency |
| [`src/iono.js`](src/iono.js) | CCIR foF2/M(3000)F2 maps, P.1239 foE, P.533 mirror height, storm depression; the gridded ionospheric field |
| [`src/assimilate.js`](src/assimilate.js) | Live ionosondes → effective sunspot number + Gaussian-process (kriging) local corrections, sporadic-E |
| [`src/propagation.js`](src/propagation.js) | Mode enumeration, P.1240 MUF, E screening, link budget, reliability, coverage grids |
| [`src/noise.js`](src/noise.js) | Man-made, atmospheric and galactic noise (ITU-R P.372) |
| [`src/antenna.js`](src/antenna.js) | Elevation patterns of dipole / vertical / Yagi over real ground |
| [`src/clutter.js`](src/clutter.js) | Land/sea/ice mask and Fresnel ground-reflection loss |
| [`src/solar.js`](src/solar.js) | SWPC (R12, SFI, Kp, X-ray, protons, 27-day outlook) and ionosonde fetches |
| [`src/data/`](src/data/) | Embedded CCIR coefficients, IGRF-14, land mask — generated by `scripts/build_data.py` |
| [`src/overlays.js`](src/overlays.js) | Leaflet rendering: day/night, KC2G overlay, coverage rasters, path, ionosondes |
| [`tools/validate.*`](tools/) | WSPR validation and calibration |
| [`app.js`](app.js) | UI wiring and orchestration |

### The model

**Ionosphere.** foF2 and M(3000)F2 come from the CCIR numerical maps (ITU-R P.1239, the
coefficients behind IRI and VOACAP), evaluated in modified-dip coordinates from IGRF-14.
They are monthly medians with the real diurnal shape, seasonal and winter anomalies and the
equatorial anomaly. They are driven by the **12-month smoothed sunspot number** (SWPC's
predicted value converted to the CCIR v1 scale, ×0.7), not by daily SFI. foE follows the
P.1239 formula and the F2 reflection height follows P.533. Kp above 3 depresses foF2 by
geomagnetic latitude.

**Live correction.** When ionosonde data is available, the model first fits one *effective*
sunspot number to all stations (removing the day's global bias). It then interpolates the
remaining per-station error with Gaussian-process regression (about a 1500 km, 3 h kernel),
relaxing back to the model away from stations and in time. On a real snapshot this cut the
leave-one-out foF2 error from 23 % (median model) to 12 %. Areas near ionosondes also get a
narrower day-to-day MUF spread, and reported sporadic-E (foEs) adds Es modes nearby.

**Link budget (after ITU-R P.533).** For each path the engine considers n-hop F2 modes, E
modes (up to 4000 km) and Es modes. Each mode gets:

- P.1240 basic MUF at the control points, and E-layer screening of F2;
- free-space loss over the slant ray path;
- George–Bradley D-layer absorption at the actual 110 km penetration points, plus auroral
  (Kp), polar-cap (GOES protons) and flare (GOES X-ray, D-RAP) absorption;
- above-MUF loss, Fresnel ground-reflection loss over land, sea or ice, and P.533's 8.72 dB
  excess loss;
- antenna elevation gain at both ends, and P.372 noise at the receiver.

**Reliability** is the probability that the SNR meets the mode's requirement (FT8 −20 dB and
WSPR −28 dB in 2.5 kHz, CW about 0 dB in 500 Hz, SSB about +9 dB in 3 kHz). It combines the
day-to-day spread of the MUF (log-normal, ±15 % deciles) with signal and noise variability.
"Open" means at least 50 %, "marginal" 20–50 %. **LUF** is the lowest frequency whose median
SNR meets the requirement, and **FOT** is 0.85 × MUF.

### Data sources

- **Space weather** — [NOAA SWPC](https://services.swpc.noaa.gov/) JSON (CORS-enabled).
- **Ionosondes** — [GIRO](https://giro.uml.edu/) digisonde data as aggregated by
  [KC2G](https://prop.kc2g.com/). KC2G sends no CORS headers, so the
  [`ionosondes`](.github/workflows/ionosondes.yml) workflow mirrors `stations.json` to this
  repo's `data` branch every 15 minutes, and the app reads it from `raw.githubusercontent.com`.
  Without it the app falls back to the median model.
- **KC2G MUF overlay** — optional visual reference, not part of the model.
- **Embedded data** — CCIR coefficients (ITU-R P.1239, via IRI), IGRF-14 (IAGA) and Natural
  Earth land polygons. Regenerate with
  `py scripts/build_data.py <ccir_dir> <igrf14coeffs.txt> <ne_50m_land.geojson>`.
- **Validation** — the [wspr.live](https://wspr.live) WSPR database.
- **Basemap** — OpenStreetMap tiles.

## Deploy

Pushes to `main` run the gated **CI & Deploy** workflow: lint + unit + smoke tests must pass
before a clean `_site/` is assembled and published to GitHub Pages. Enable Pages →
"GitHub Actions" in repo settings.

The **Mirror ionosonde data** workflow runs every 15 minutes (or by hand from the Actions
tab) and force-pushes a single-commit `data` branch. GitHub pauses scheduled workflows after
60 days without repository activity. If the app says "Ionosondes: unavailable", re-enable it
from the Actions tab.

## License

MIT.
