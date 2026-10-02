import assert from 'node:assert/strict';
import { classifyBenchmark } from './ci-benchmark-policy.mjs';

const base = { runtime: 'bun', version: '1.2.23', status: 1, signal: null, error: null };
const crash = 'Bun v1.2.23\npanic(main thread): Segmentation fault at address 0x123\noh no: Bun has crashed.';
const wasm = "RuntimeError: access to a null reference (evaluating 'getWasmTableEntry(e)(t, r, a)')\nat invoke_viii (pglite/dist/index.js)";
assert.equal(classifyBenchmark({ ...base, output: crash }), 'known_historical_engine_failure');
assert.equal(classifyBenchmark({ ...base, output: wasm }), 'known_historical_engine_failure');
for (const output of ['AssertionError: wrong bytes', 'checksum mismatch', crash + '\nAssertionError: wrong rows', 'TypeError: bad option', 'RuntimeError: unrelated WASM error', 'Error: SQL failed']) {
  assert.equal(classifyBenchmark({ ...base, output }), 'fatal_failure');
}
assert.equal(classifyBenchmark({ ...base, runtime: 'node', output: crash }), 'fatal_failure');
assert.equal(classifyBenchmark({ ...base, version: '1.3.14', output: crash }), 'fatal_failure');
assert.equal(classifyBenchmark({ ...base, error: 'Timeout', output: crash }), 'fatal_failure');
assert.equal(classifyBenchmark({ ...base, status: 0, output: '' }), 'success');
console.log('Benchmark policy checks passed: narrow historical engine exception; verification failures remain fatal.');
