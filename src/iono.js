// iono.js — analytic ionospheric model.
// Estimates the layer critical frequencies, heights and an absorption index at
// a point from solar activity (SSN) and solar zenith angle. Constants are
// calibrated to typical mid-latitude foF2/foE behaviour (solar min↔max,
// day↔night). These are statistical approximations, not measured values.

/**
 * E-layer critical frequency foE (MHz). Standard ITU form:
 *   foE = 0.9 · [(180 + 1.44·SSN)·cosχ]^0.25   (daytime)
 * with a small night floor (residual ionisation / sporadic-E baseline).
 */
export function foE(cosZenith, ssn) {
  const c = Math.max(0, cosZenith);
  const day = 0.9 * Math.pow((180 + 1.44 * ssn) * c, 0.25);
  return Math.max(0.5, day);
}

/**
 * F2 critical frequency foF2 (MHz). Empirical day/night blend:
 *   night floor grows with solar activity; daytime peak adds in quadrature and
 *   scales with cosχ. Calibrated so:
 *     solar min night ≈ 2 MHz, min noon ≈ 6 MHz,
 *     solar max night ≈ 4.5 MHz, max noon ≈ 13–14 MHz.
 * Optional geomagnetic-storm depression at higher latitudes (Kp driven).
 */
export function foF2(cosZenith, ssn, { kp = 0, absLat = 0 } = {}) {
  const s = ssn / 180;
  const fNight = 2.0 + 2.5 * s;
  const fDayMax = 6.0 + 7.0 * s;
  const fDay = fDayMax * Math.pow(Math.max(0, cosZenith), 0.5);
  let f = Math.sqrt(fNight * fNight + fDay * fDay);

  // Storm depression: stronger at high latitude and high Kp. Capped at 50%.
  const storm = Math.min(0.5, Math.max(0, 0.04 * kp * (absLat - 30) / 60));
  return f * (1 - storm);
}

/** F2 reflection height hmF2 (km). Rises with activity and at night. */
export function hmF2(cosZenith, ssn) {
  return 250 + 100 * (ssn / 180) + (cosZenith <= 0 ? 40 : 0);
}

/** E-layer reflection height hmE (km) — nearly constant. */
export function hmE() {
  return 110;
}

/**
 * Non-deviative absorption index (dimensionless, ≥0). Proportional to
 * (1 + 0.0037·SSN)·cosχ^0.75 — essentially zero at night (D-layer gone).
 * propagation.js converts this to per-hop dB absorption and the LUF.
 */
export function absorptionIndex(cosZenith, ssn) {
  const c = Math.max(0, cosZenith);
  return (1 + 0.0037 * ssn) * Math.pow(c, 0.75);
}

/**
 * Convenience: all parameters at a point.
 * @param {{cosZenith:number, ssn:number, kp?:number, absLat?:number}} p
 */
export function ionoAt({ cosZenith, ssn, kp = 0, absLat = 0 }) {
  return {
    foF2: foF2(cosZenith, ssn, { kp, absLat }),
    foE: foE(cosZenith, ssn),
    hmF2: hmF2(cosZenith, ssn),
    hmE: hmE(),
    absorptionIndex: absorptionIndex(cosZenith, ssn),
    cosZenith,
  };
}
