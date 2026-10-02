import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const runtime = process.env.TEST_RUNTIME ?? 'node';
const binary = process.env.TEST_RUNTIME_BIN ?? (runtime === 'node' ? process.execPath : runtime);
const worker = fileURLToPath(new URL('../scripts/runtime-worker.mjs', import.meta.url));
function command() {
  if (runtime === 'deno') return ['run', '--allow-all', worker];
  if (runtime === 'bun') return [worker];
  if (runtime === 'node') return ['--no-warnings', worker];
  throw new Error('Unsupported TEST_RUNTIME: ' + runtime);
}

export function runWorker(input: unknown, timeout = 180_000, killWhenReady = false): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, command(), { cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', result: any, killed = false, settled = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new Error(`${runtime} worker exceeded ${timeout}ms`)); }, timeout);
    function finish(error?: Error) {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    }
    let pending = '';
    child.stdout.on('data', chunk => {
      stdout += chunk; pending += chunk;
      let newline;
      while ((newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.stage === 'result') result = message.result;
          if (message.stage !== 'result') console.info(`[${runtime}] ${line}`);
          if (killWhenReady && message.stage === 'kill-ready') { killed = true; child.kill('SIGKILL'); }
        } catch { /* Non-protocol output is retained in failures. */ }
      }
    });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => finish(error));
    child.on('close', (code, signal) => {
      if (killWhenReady && killed && signal === 'SIGKILL') { result = { killedAtBarrier: true }; finish(); }
      else if (code !== 0 || result === undefined) finish(new Error(`${runtime} worker failed (${code}/${signal})\n${stdout}\n${stderr}`));
      else finish();
    });
    child.stdin.on('error', error => finish(new Error(`${runtime} worker input failed: ${error.message}`)));
    child.stdin.end(JSON.stringify(input));
  });
}
