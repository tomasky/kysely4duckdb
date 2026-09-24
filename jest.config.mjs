/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  transform: {
    '^.+\\.m?[tj]sx?$': ['ts-jest', {
      // kysely >= 0.29 is ESM-only, so the test pipeline has to run as ESM too.
      useESM: true,
      diagnostics: false,
    }],
  },
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  // Each WASM test spins up its own DuckDB worker, which takes a few seconds
  // and stretches further when suites run in parallel.
  testTimeout: 30000,
};
