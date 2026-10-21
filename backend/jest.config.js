/**
 * Jest configuration.
 *
 * Lives here rather than in package.json so each non-obvious setting can
 * carry its reason.
 */
module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: "src",
  testRegex: ".*\\.spec\\.ts$",
  transform: {"^.+\\.(t|j)s$": "ts-jest"},
  collectCoverageFrom: ["**/*.(t|j)s"],
  coverageDirectory: "../coverage",
  testEnvironment: "node",

  /**
   * Jest defaults to one worker per core, less one.
   *
   * On a development machine that is nearly every core compiling TypeScript
   * and booting Nest applications at once, each in its own process. Two keeps
   * the machine usable while the battery runs.
   *
   * `--runInBand` (which `test:pg` uses) and an explicit `--maxWorkers` on the
   * command line both take precedence over this.
   */
  maxWorkers: 2,

  /**
   * Jest defaults BOTH tests and hooks to 5 seconds.
   *
   * The disposable-PostgreSQL suites CREATE and DROP a database in
   * beforeAll/afterAll, and DROP DATABASE waits for every connection to close.
   * Under parallel workers that routinely exceeds 5s even when every test in
   * the suite has passed, and the battery then reports a suite failure that is
   * purely its own contention. A battery that is red for reasons nobody acts on
   * is a battery people stop reading.
   *
   * 30s is well above the observed teardown and still far below a genuine hang.
   */
  testTimeout: 30000,
};
