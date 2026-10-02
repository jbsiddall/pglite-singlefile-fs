import assert from 'node:assert/strict';
import { classifyBenchmark } from './ci-benchmark-policy.mjs';

const base = { runtime: 'bun', version: '1.2.23', status: 1, signal: null, error: null };
const crash = 'Bun v1.2.23\npanic(main thread): Segmentation fault at address 0x123\noh no: Bun has crashed.';
const wasm = "RuntimeError: access to a null reference (evaluating 'getWasmTableEntry(e)(t, r, a)')\nat invoke_viii (pglite/dist/index.js)";
assert.equal(classifyBenchmark({ ...base, output: crash }), 'known_historical_engine_failure');
assert.equal(classifyBenchmark({ ...base, output: wasm }), 'known_historical_engine_failure');
const bounds = "Error: [bun/singlefile/initialize/setup] RuntimeError: Out of bounds memory access (evaluating 't(r, a)')\nat callMain (node_modules/@electric-sql/pglite/dist/index.js)";
assert.equal(classifyBenchmark({ ...base, output: bounds }), 'known_historical_engine_failure');
const sixArguments = "Error: [bun/singlefile/initialize/setup] RuntimeError: Out of bounds memory access (evaluating 'getWasmTableEntry(e)(t, r, a, o, _, s)')\nat callMain (node_modules/@electric-sql/pglite/dist/index.js)";
assert.equal(classifyBenchmark({ ...base, output: sixArguments }), 'known_historical_engine_failure');
assert.equal(classifyBenchmark({ ...base, output: sixArguments.replace('(t, r, a, o, _, s)', '($arg1)') }), 'known_historical_engine_failure');
assert.equal(classifyBenchmark({ ...base, output: sixArguments.replace('(t, r, a, o, _, s)', '()') }), 'fatal_failure');
assert.equal(classifyBenchmark({ ...base, output: sixArguments.replace('(t, r, a, o, _, s)', '(t, dangerous())') }), 'fatal_failure');
const abort = '[bun/nodefs/initialize/setup] RuntimeError: Aborted(). Build with -sASSERTIONS for more info.\n    at abort (/node_modules/@electric-sql/pglite/dist/index.js:1:78246)';
assert.equal(classifyBenchmark({ ...base, output: abort }), 'known_historical_engine_failure');
assert.equal(classifyBenchmark({ ...base, output: 'Error: baseline iteration 1: Error: ' + abort }), 'known_historical_engine_failure');
assert.equal(classifyBenchmark({ ...base, output: 'Error: Benchmark failed for nodefs, iteration 0, initialize\n  [cause]: Error: ' + abort }), 'known_historical_engine_failure');
assert.equal(classifyBenchmark({ ...base, output: abort.replace('/initialize/setup]', '/batchRead/query]') }), 'fatal_failure');
assert.equal(classifyBenchmark({ ...base, output: abort.replace('@electric-sql/pglite', 'another-library') }), 'fatal_failure');
assert.equal(classifyBenchmark({ ...base, output: abort.replace('\n    at abort', '\n    at otherFrame (other.js:1:1)\n    at abort') }), 'fatal_failure');
for (const diagnostic of ['AssertionError: wrong rows', 'SQLiteError: database is locked', 'Error: SQLITE_CORRUPT', 'Error: ENOENT: no such file', 'Error: EIO: read failed', 'Error: worker timed out', 'TypeError: unrelated failure', 'Error: unrelated failure', 'Error: SQL failed', 'RuntimeError: unknown failure', 'error: unrelated failure', '[sqlite] SQLiteError: database is locked', '[other-module] Error: unrelated failure', '[unknown] RuntimeError: unknown failure']) {
  for (const known of [abort, crash, bounds, sixArguments]) assert.equal(classifyBenchmark({ ...base, output: known + '\n' + diagnostic }), 'fatal_failure');
}
assert.equal(classifyBenchmark({ ...base, output: crash + '\nError: [bun/nodefs] worker exited code=null signal=SIGSEGV: ' }), 'known_historical_engine_failure');
assert.equal(classifyBenchmark({ ...base, output: crash + '\nError: [bun/nodefs] worker exited code=null signal=SIGKILL: ' }), 'fatal_failure');
assert.equal(classifyBenchmark({ ...base, output: abort + '\nError: Benchmark failed for nodefs, iteration 0, unknownPhase' }), 'fatal_failure');
assert.equal(classifyBenchmark({ ...base, output: abort + '\n at harmless (/sqlite/timeout/benchmark.html:1:1)' }), 'known_historical_engine_failure');

assert.equal(classifyBenchmark({ ...base, output: bounds + '\nAssertionError: checksum mismatch' }), 'fatal_failure');
assert.equal(classifyBenchmark({ ...base, output: 'RuntimeError: Out of bounds memory access\nat pglite/dist/index.js' }), 'fatal_failure');
assert.equal(classifyBenchmark({ ...base, output: "RuntimeError: Out of bounds memory access (evaluating 't(r, a)')\nat other-library.js" }), 'fatal_failure');
for (const output of ['AssertionError: wrong bytes', 'checksum mismatch', crash + '\nAssertionError: wrong rows', 'TypeError: bad option', 'RuntimeError: unrelated WASM error', 'Error: SQL failed']) {
  assert.equal(classifyBenchmark({ ...base, output }), 'fatal_failure');
}
assert.equal(classifyBenchmark({ ...base, runtime: 'node', output: crash }), 'fatal_failure');
assert.equal(classifyBenchmark({ ...base, version: '1.3.14', output: crash }), 'fatal_failure');
assert.equal(classifyBenchmark({ ...base, error: 'Timeout', output: crash }), 'fatal_failure');
assert.equal(classifyBenchmark({ ...base, status: 0, output: '' }), 'success');
console.log('Benchmark policy checks passed: narrow historical engine exception; verification failures remain fatal.');
