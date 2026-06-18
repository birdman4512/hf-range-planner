// bands.js — amateur HF band plan (IARU-ish centre frequencies) and helpers.

/** @typedef {{ name: string, label: string, mhz: number, lowMhz: number, highMhz: number }} Band */

/** Representative working frequencies per band (MHz). */
export const BANDS = [
  { name: '160m', label: '160 m', mhz: 1.9, lowMhz: 1.8, highMhz: 2.0 },
  { name: '80m', label: '80 m', mhz: 3.65, lowMhz: 3.5, highMhz: 4.0 },
  { name: '60m', label: '60 m', mhz: 5.35, lowMhz: 5.25, highMhz: 5.45 },
  { name: '40m', label: '40 m', mhz: 7.1, lowMhz: 7.0, highMhz: 7.3 },
  { name: '30m', label: '30 m', mhz: 10.12, lowMhz: 10.1, highMhz: 10.15 },
  { name: '20m', label: '20 m', mhz: 14.15, lowMhz: 14.0, highMhz: 14.35 },
  { name: '17m', label: '17 m', mhz: 18.1, lowMhz: 18.068, highMhz: 18.168 },
  { name: '15m', label: '15 m', mhz: 21.2, lowMhz: 21.0, highMhz: 21.45 },
  { name: '12m', label: '12 m', mhz: 24.93, lowMhz: 24.89, highMhz: 24.99 },
  { name: '10m', label: '10 m', mhz: 28.3, lowMhz: 28.0, highMhz: 29.7 },
];

export function bandByName(name) {
  return BANDS.find((b) => b.name === name);
}

/** Nearest band to a given frequency (MHz). */
export function nearestBand(mhz) {
  return BANDS.reduce((best, b) =>
    Math.abs(b.mhz - mhz) < Math.abs(best.mhz - mhz) ? b : best
  );
}
