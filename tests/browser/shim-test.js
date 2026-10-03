// Minimal browser stand-in for `node:test`, so tests/unit/*.test.mjs can run in
// a plain browser (see tests/browser/index.html) on machines without Node.
const queue = [];
export function test(name, fn) { queue.push({ name, fn }); }
export const it = test;
export function describe(name, fn) { fn(); }

export async function runQueued(log) {
  let pass = 0, fail = 0;
  while (queue.length) {
    const { name, fn } = queue.shift();
    const t0 = performance.now();
    try {
      await fn();
      pass++;
      log(`ok   ${name} (${(performance.now() - t0).toFixed(0)} ms)`);
    } catch (e) {
      fail++;
      log(`FAIL ${name}\n     ${e && e.message ? e.message : e}`);
    }
  }
  return { pass, fail };
}
