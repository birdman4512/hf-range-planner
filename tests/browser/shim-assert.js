// Minimal browser stand-in for `node:assert/strict` (the subset the unit tests use).
class AssertionError extends Error {}
const fmt = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };

function ok(v, msg) { if (!v) throw new AssertionError(msg || `expected truthy, got ${fmt(v)}`); }
function equal(a, b, msg) { if (!Object.is(a, b)) throw new AssertionError(msg || `${fmt(a)} !== ${fmt(b)}`); }
function notEqual(a, b, msg) { if (Object.is(a, b)) throw new AssertionError(msg || `${fmt(a)} === ${fmt(b)}`); }
function deepEqual(a, b, msg) { if (fmt(a) !== fmt(b)) throw new AssertionError(msg || `${fmt(a)} ≠ ${fmt(b)}`); }
function throws(fn, msg) {
  try { fn(); } catch { return; }
  throw new AssertionError(msg || 'expected function to throw');
}

const assert = Object.assign((v, m) => ok(v, m), {
  ok, equal, notEqual, deepEqual, throws,
  strictEqual: equal, deepStrictEqual: deepEqual, AssertionError,
});
export default assert;
export { ok, equal, notEqual, deepEqual, throws };
