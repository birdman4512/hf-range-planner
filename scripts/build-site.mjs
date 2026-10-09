// build-site.mjs — assemble the deployable static site in _site/.
// Whitelist only: anything not listed here (tests, scripts, configs) is never published.

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';

const OUT = '_site';
const FILES = [
  'index.html', '404.html', 'styles.css', 'app.js', 'sw.js', 'manifest.webmanifest', '_headers',
  'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png',
];
const DIRS = ['src', 'tools'];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
for (const f of FILES) cpSync(f, `${OUT}/${f}`);
for (const d of DIRS) cpSync(d, `${OUT}/${d}`, { recursive: true });
if (existsSync('data')) cpSync('data', `${OUT}/data`, { recursive: true });
console.log(`Built ${OUT}/: ${FILES.length} files + ${DIRS.join(', ')}`);
