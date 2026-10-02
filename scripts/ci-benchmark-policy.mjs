export const historicalReason = 'Bun 1.2.23 has reproduced upstream PGlite/WASM engine crashes. Only those explicit engine signatures are advisory; correctness tests, assertions and other benchmark failures remain mandatory.';

export function classifyBenchmark({ runtime, version, status, signal, error, output }) {
  if (status === 0 && !signal && !error) return 'success';
  if (runtime !== 'bun' || version !== '1.2.23' || error) return 'fatal_failure';
  // Never excuse a verification failure, including one mixed with an engine crash.
  if (/AssertionError|ERR_ASSERTION|(?:checksum|row count)\s+(?:mismatch|failed|failure)/i.test(output)) return 'fatal_failure';
  const crash = /Bun v1\.2\.23\b/.test(output)
    && /panic\([^)]*\): Segmentation fault/.test(output)
    && /Bun has crashed/.test(output);
  const wasm = /RuntimeError: access to a null reference[^\n]*getWasmTableEntry/.test(output)
    && /(?:pglite|invoke_viii|wasm)/i.test(output);
  return crash || wasm ? 'known_historical_engine_failure' : 'fatal_failure';
}
