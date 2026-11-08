/**
 * Jest config for the Vectros TypeScript examples.
 *
 * `--runInBand` (set by run.sh) keeps specs sequential so they don't race on
 * shared tenant state. The timeout is generous: against the live API, cold-start
 * indexing and text extraction can take ~60-90s.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testTimeout: 180_000,
  testMatch: ['<rootDir>/tests/**/*.spec.ts'],
  // Marks this as the shipped examples: runs.spec.ts makes real, billed agent runs, so here it is skipped unless VECTROS_SMOKE_RUNS=1.
  globals: { VECTROS_SMOKE_RUNS_OPT_IN: true },
  bail: false,
  verbose: true,
};
