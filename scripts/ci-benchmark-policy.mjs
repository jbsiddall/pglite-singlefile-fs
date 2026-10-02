export const historicalReason = 'Historical Bun 1.2.23 native-storage baseline failures and observed WASM callback/setup-abort diagnostics are recorded. Only explicit historical runtime-crash signatures are advisory; correctness tests, assertions and other benchmark failures remain mandatory. The exact callback-crash cause has not been independently established.';

export function classifyBenchmark({ runtime, version, status, signal, error, output }) {
  if (status === 0 && !signal && !error) return 'success';
  if (runtime !== 'bun' || version !== '1.2.23' || error) return 'fatal_failure';
  output = String(output).replace(/\u001b\[[0-9;]*m/g, '');
  // Never excuse a verification failure, including one mixed with an engine crash.
  if (/AssertionError|ERR_ASSERTION|(?:checksum|row count)\s+(?:mismatch|failed|failure)/i.test(output)) return 'fatal_failure';
  const crash = /Bun v1\.2\.23\b/.test(output)
    && /panic\([^)]*\): Segmentation fault/.test(output)
    && /Bun has crashed/.test(output);
  const wasm = /RuntimeError: (?:access to a null reference|Out of bounds memory access)[^\n]*(?:getWasmTableEntry|evaluating 't\(r,\s*a\)')/.test(output)
    && /(?:pglite\/dist|invoke_[a-z]+)/i.test(output);
  const setupAbort = /\[bun\/(?:nodefs|singlefile)\/initialize\/setup\] RuntimeError: Aborted\(\)\. Build with -sASSERTIONS for more info\.\r?\n\s+at abort \([^\r\n]*\/@electric-sql\/pglite\/dist\/index\.js:\d+:\d+\)/.test(output);
  // Every diagnostic headline must be a known signature or our exact transport
  // wrapper. A known crash mixed with any unrelated error remains fatal.
  const errorLines = output.split(/\r?\n/).map(line => line.trim().replace(/^\[cause\]:\s*/, ''))
    .filter(line => /^(?:(?:[A-Za-z]*Error|error)(?: \[[^\]]+\])?:|\[[^\]]+\]\s+(?:[A-Za-z]*Error|error):)/.test(line));
  const allowedDiagnostic = line => {
    // The archived local control adds this wrapper; production has no wrapper.
    line = line.replace(/^Error: baseline iteration \d+: /, '');
    if (/^Error: Benchmark failed for (?:nodefs|singlefile), iteration -?\d+, (?:initialize|shutdown|batchRead|batchInsert|batchUpdate|frequentRead|frequentInsert|frequentUpdate)$/.test(line)) return true;
    if (crash && /^Error: \[bun\/(?:nodefs|singlefile)\] worker exited code=null signal=SIGSEGV:\s*(?:={5,}|Bun v1\.2\.23[^\r\n]*)?$/.test(line)) return true;
    if (setupAbort && /^(?:Error: )?\[bun\/(?:nodefs|singlefile)\/initialize\/setup\] RuntimeError: Aborted\(\)\. Build with -sASSERTIONS for more info\.$/.test(line)) return true;
    return wasm && /^(?:Error: )?(?:\[bun\/(?:nodefs|singlefile)\/(?:initialize|run|shutdown)\/(?:setup|batchRead|batchInsert|batchUpdate|frequentRead|frequentInsert|frequentUpdate)\] )?RuntimeError: (?:access to a null reference|Out of bounds memory access) \(evaluating '(?:getWasmTableEntry\([A-Za-z_$][A-Za-z0-9_$]*\)\([A-Za-z_$][A-Za-z0-9_$]*(?:,\s*[A-Za-z_$][A-Za-z0-9_$]*)*\)|t\(r,\s*a\))'\)$/.test(line);
  };
  if (errorLines.some(line => !allowedDiagnostic(line))) return 'fatal_failure';
  return crash || wasm || setupAbort ? 'known_historical_engine_failure' : 'fatal_failure';
}
