import { defineConfig } from 'vitest/config';

const benchmarking = process.argv.includes('bench');

export default defineConfig({
  test: {
    include: benchmarking ? [] : ['tests/**/*.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 180_000,
    hookTimeout: 180_000,
    reporters: ['default', ['html', { outputDir: benchmarking ? 'reports/benchmarks' : 'reports/tests', singleFile: true }], 'json'],
    outputFile: { json: benchmarking ? 'reports/benchmarks/vitest.json' : 'reports/tests/results.json' },
    benchmark: {
      include: ['benchmarks/**/*.bench.ts'],
      retainSamples: true,
    },
  },
});
