/**
 * ---------------------------------------------------------------------------
 * JEST CONFIGURATION
 * ---------------------------------------------------------------------------
 * This project is native ESM (`"type": "module"` in package.json), which
 * changes two things about running Jest:
 *
 *   1. `transform: {}` — DO NOT strip this. It disables babel-jest entirely,
 *      so Node loads the source as real ES modules. Without it Jest tries to
 *      transpile ESM to CommonJS and every `import.meta` in the codebase
 *      breaks.
 *
 *   2. Jest's ESM support is behind a V8 flag, so the npm scripts invoke
 *      `node --experimental-vm-modules node_modules/jest/bin/jest.js` rather
 *      than the `jest` binary. That form works identically on Windows, macOS
 *      and Linux — `NODE_OPTIONS=... jest` does not work on Windows cmd.
 *
 * TWO PROJECTS, because they have very different costs:
 *
 *   unit        — pure functions, no database. Milliseconds.
 *   integration — real MongoDB + supertest against the Express app. Seconds.
 *
 * `npm run test:unit` gives fast feedback while working; `npm test` runs both.
 * ---------------------------------------------------------------------------
 */

export default {
  testEnvironment: 'node',

  /** See the note above — removing this breaks ESM loading. */
  transform: {},

  projects: [
    {
      displayName: 'unit',
      testEnvironment: 'node',
      transform: {},
      testMatch: ['<rootDir>/tests/unit/**/*.test.js'],
      setupFiles: ['<rootDir>/tests/setup-env.js'],
    },
    {
      displayName: 'integration',
      testEnvironment: 'node',
      transform: {},
      testMatch: ['<rootDir>/tests/integration/**/*.test.js'],
      setupFiles: ['<rootDir>/tests/setup-env.js'],
      /**
       * Integration tests clear collections between tests, so two files
       * sharing a database would wipe each other's fixtures. Isolation comes
       * from a PER-WORKER database name (see tests/setup-env.js) rather than
       * from `maxWorkers` here — that option is global and is ignored inside a
       * project entry, which is exactly the trap this comment exists to flag.
       */
    },
  ],

  /** Mongoose takes several seconds to import on Windows; 30s is not generous. */
  testTimeout: 30_000,

  collectCoverageFrom: [
    'src/**/*.js',
    // Excluded deliberately: these are wiring and configuration, exercised by
    // the integration tests booting the app rather than asserted directly.
    '!src/server.js',
    '!src/seeds/**',
    '!src/config/swagger.js',
  ],

  coverageDirectory: 'coverage',
  coverageReporters: ['text-summary', 'lcov'],

  verbose: false,
  clearMocks: true,
};
