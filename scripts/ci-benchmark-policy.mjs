export const historicalReason = 'Historical Bun 1.2.23 baseline failures and observed WASM callback crashes are recorded. Only explicit historical runtime-crash signatures are advisory; correctness tests, assertions and other benchmark failures remain mandatory. The exact callback-crash cause has not been independently established.';

export function classifyBenchmark({ runtime, version, status, signal, error, output }) {
  if (status === 0 && !signal && !error) return 'success';
  if (runtime !== 'bun' || version !== '1.2.23' || error) return 'fatal_failure';
  // Never excuse a verification failure, including one mixed with an engine crash.
  if (/AssertionError|ERR_ASSERTION|(?:checksum|row count)\s+(?:mismatch|failed|failure)/i.test(output)) return 'fatal_failure';
  const crash = /Bun v1\.2\.23\b/.test(output)
    && /panic\([^)]*\): Segmentation fault/.test(output)
    && /Bun has crashed/.test(output);
  const wasm = /RuntimeError: (?:access to a null reference|Out of bounds memory access)[^\n]*(?:getWasmTableEntry|evaluating 't\(r,\s*a\)')/.test(output)
    && /(?:pglite\/dist|invoke_[a-z]+)/i.test(output);
  return crash || wasm ? 'known_historical_engine_failure' : 'fatal_failure';
}
