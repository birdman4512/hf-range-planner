// lint.mjs — lightweight syntax check for all source/app JS without a build step.
// Runs `node --check` on each .js file and fails if any has a syntax error.

import { readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { execFileSync } from 'node:child_process';

const roots = ['src', 'tests', '.'];
const skipDirs = new Set(['node_modules', '.git', 'test-results', 'playwright-report']);
const files = new Set();

function walk(dir, recurse) {
  for (const entry of readdirSync(dir)) {
    if (skipDirs.has(entry)) continue;
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (recurse) walk(p, recurse);
    } else if (extname(p) === '.js' || extname(p) === '.mjs') {
      files.add(p);
    }
  }
}

walk('src', true);
walk('tests', true);
// Top-level app.js only (don't recurse the whole repo root).
for (const entry of readdirSync('.')) {
  if (extname(entry) === '.js') files.add(entry);
}

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error(`✗ ${f}\n${err.stderr?.toString() || err.message}`);
  }
}

if (failed) {
  console.error(`\nLint failed: ${failed} file(s) with syntax errors.`);
  process.exit(1);
}
console.log(`Lint OK: ${files.size} file(s) checked.`);
