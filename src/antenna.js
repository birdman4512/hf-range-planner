// antenna.js — elevation-plane gain of common amateur HF antennas over real
// ground. Each pattern is the free-space element pattern times the ground
// "array factor" |1 + R·e^(−j·2kh·sinΔ)| using complex Fresnel coefficients
// for average ground (ITU-R P.527), so the low-angle behaviour (the thing that
// makes or breaks DX) depends properly on height above ground and frequency.

import { fresnel, SURFACE } from './clutter.js';

const DEG = Math.PI / 180;
const GROUND = SURFACE.land;

export const ANTENNAS = [
  { id: 'dipole', label: 'Dipole / inverted-V', height: true },
  { id: 'vertical', label: '¼λ vertical + radials', height: false },
  { id: 'yagi3', label: '3-el Yagi (aimed)', height: true },
  { id: 'iso', label: 'Isotropic (0 dBi ref.)', height: false },
];

export function antennaById(id) {
  return ANTENNAS.find((a) => a.id === id) || ANTENNAS[0];
}

function groundFactor(R, kh2, elevDeg) {
  // |1 + R e^{−jφ}|, φ = 2kh sinΔ
  const phi = kh2 * Math.sin(elevDeg * DEG);
  const re = 1 + R[0] * Math.cos(phi) + R[1] * Math.sin(phi);
  const im = R[1] * Math.cos(phi) - R[0] * Math.sin(phi);
  return Math.hypot(re, im);
}

/**
 * Gain (dBi) at elevation angle `elevDeg` (azimuth-averaged for omni-ish use;
 * a Yagi is assumed aimed at the far station).
 * @param {{type: string, heightM?: number}} ant
 */
export function antennaGainDbi(ant, freqMhz, elevDeg) {
  const el = Math.max(0.1, elevDeg);
  const type = ant && ant.type ? ant.type : 'dipole';
  if (type === 'iso') return 0;
  const lambda = 299.792458 / freqMhz;
  const k = 2 * Math.PI / lambda;
  const { h: Rh, v: Rv } = fresnel(GROUND, freqMhz, el);

  if (type === 'vertical') {
    // Ground-mounted λ/4 monopole: λ/2-dipole element pattern with its image in
    // real ground (feed at ground level), −3 dB for half-space, −1.5 dB radial loss.
    const s = Math.sin(el * DEG), c = Math.cos(el * DEG);
    const elem = Math.abs(Math.cos((Math.PI / 2) * s) / Math.max(1e-3, c));
    const g = 2.15 + 20 * Math.log10(Math.max(1e-4, elem * groundFactor(Rv, 0, el))) - 3 - 1.5;
    return Math.max(-30, g);
  }

  // Horizontal dipole (broadside element pattern is flat in elevation) at height h.
  const h = Math.max(1, (ant && ant.heightM) || 10);
  const gf = groundFactor(Rh, 2 * k * h, el);
  let g = 2.15 + 20 * Math.log10(Math.max(1e-4, gf));
  if (type === 'yagi3') g += 5.0;  // forward gain over a dipole, aimed
  else g -= 2.0;                   // azimuth average of a dipole's figure-8 + ground loss
  return Math.max(-30, g);
}
