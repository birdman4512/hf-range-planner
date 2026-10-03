// noise.js — receiver-site radio noise, after ITU-R P.372.
//
// External noise factor Fa (dB above kT₀b) is the power sum of:
//   * man-made noise — P.372 environment curves  Fam = c − d·log10 f;
//   * galactic noise — 52 − 23·log10 f, only when f exceeds foF2 overhead
//     (otherwise the ionosphere screens it);
//   * atmospheric noise (lightning) — a compact parameterisation of the P.372
//     maps: the 1 MHz value Fam1 depends on latitude (tropics loudest), season
//     (summer loudest) and time of day (night loudest, as noise propagates in
//     from distant thunderstorms), then falls with frequency more steeply when
//     it is high. This is an approximation of the P.372 maps, not the maps
//     themselves — expect errors of several dB in specific places/seasons.
// Noise power density at the receiver is N₀ = Fa − 204 dBW/Hz.

export const NOISE_ENVIRONMENTS = [
  { id: 'quiet', label: 'Quiet rural', c: 53.6, d: 28.6 },
  { id: 'rural', label: 'Rural', c: 67.2, d: 27.7 },
  { id: 'residential', label: 'Residential', c: 72.5, d: 27.7 },
  { id: 'city', label: 'City / business', c: 76.8, d: 27.7 },
];

export function noiseEnvById(id) {
  return NOISE_ENVIRONMENTS.find((e) => e.id === id) || NOISE_ENVIRONMENTS[2];
}

/** Man-made noise Fam (dB) for an environment. */
export function manMadeFa(env, freqMhz) {
  return env.c - env.d * Math.log10(freqMhz);
}

/** Galactic noise Fam (dB). */
export function galacticFa(freqMhz) {
  return 52 - 23 * Math.log10(freqMhz);
}

/**
 * Atmospheric noise Fam (dB) at the receiver.
 * @param {number} lat  receiver latitude (deg)
 * @param {number} cosZ cosine of the solar zenith angle at the receiver
 * @param {number} dayOfYear 1..366
 */
export function atmosphericFa(freqMhz, lat, cosZ, dayOfYear) {
  const absLat = Math.abs(lat);
  // Season: +1 local summer, −1 local winter.
  const season = Math.cos(2 * Math.PI * (dayOfYear - 172) / 365.25) * (lat >= 0 ? 1 : -1);
  // Night-time 1 MHz level vs latitude (tropics ≈ 90 dB, mid-lat ≈ 75, polar ≈ 55).
  let night = absLat <= 15 ? 90 : absLat <= 40 ? 90 - (absLat - 15) * 0.6 : Math.max(52, 75 - (absLat - 40) * 1.0);
  night += season * (absLat <= 15 ? 3 : 7);
  // Daytime drop (D-layer absorbs the long-range noise): ~25 dB.
  const day = Math.max(0, Math.min(1, (cosZ + 0.1) / 0.4));
  const fam1 = night - 25 * day;
  // Frequency fall-off: steeper when the 1 MHz level is high (P.372 Fig. 15).
  const k = 5 + 0.5 * Math.max(0, fam1 - 20);
  return fam1 - k * Math.log10(Math.max(1, freqMhz));
}

/**
 * Total external noise factor Fa (dB) at a receiver.
 * @param {{env: object, freqMhz: number, lat: number, cosZ: number, dayOfYear: number, foF2: number}} p
 */
export function totalNoiseFa({ env, freqMhz, lat, cosZ, dayOfYear, foF2 }) {
  const parts = [manMadeFa(env, freqMhz), atmosphericFa(freqMhz, lat, cosZ, dayOfYear)];
  if (freqMhz > foF2) parts.push(galacticFa(freqMhz));
  let p = 0;
  for (const x of parts) p += 10 ** (x / 10);
  return 10 * Math.log10(p);
}

/** Noise power spectral density at the receiver (dBW/Hz). */
export const noiseDensityDbW = (fa) => fa - 204;
