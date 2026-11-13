/**
 * Zero-dependency, high-reliability Test Harness for Ofln-Scout E2E Testing.
 * Provides Jest/Mocha-compatible syntax with native Node.js async execution.
 */

export interface TestResult {
  suite: string;
  name: string;
  passed: boolean;
  durationMs: number;
  error?: Error;
}

export interface SuiteSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  results: TestResult[];
}

type HookFn = () => void | Promise<void>;
type TestFn = () => void | Promise<void>;

interface TestCase {
  name: string;
  fn: TestFn;
  timeoutMs: number;
  skip?: boolean;
}

interface TestSuite {
  name: string;
  beforeAllHooks: HookFn[];
  afterAllHooks: HookFn[];
  beforeEachHooks: HookFn[];
  afterEachHooks: HookFn[];
  tests: TestCase[];
}

const suites: TestSuite[] = [];
let currentSuite: TestSuite | null = null;

export function describe(name: string, fn: () => void): void {
  const suite: TestSuite = {
    name,
    beforeAllHooks: [],
    afterAllHooks: [],
    beforeEachHooks: [],
    afterEachHooks: [],
    tests: [],
  };
  suites.push(suite);
  const prev = currentSuite;
  currentSuite = suite;
  try {
    fn();
  } finally {
    currentSuite = prev;
  }
}

export function it(name: string, fn: TestFn, timeoutMs = 15000): void {
  if (!currentSuite) {
    describe('Default Suite', () => {
      it(name, fn, timeoutMs);
    });
    return;
  }
  currentSuite.tests.push({ name, fn, timeoutMs });
}

it.skip = function (name: string, fn: TestFn, timeoutMs = 15000): void {
  if (!currentSuite) return;
  currentSuite.tests.push({ name, fn, timeoutMs, skip: true });
};

export function beforeAll(fn: HookFn): void {
  if (currentSuite) currentSuite.beforeAllHooks.push(fn);
}

export function afterAll(fn: HookFn): void {
  if (currentSuite) currentSuite.afterAllHooks.push(fn);
}

export function beforeEach(fn: HookFn): void {
  if (currentSuite) currentSuite.beforeEachHooks.push(fn);
}

export function afterEach(fn: HookFn): void {
  if (currentSuite) currentSuite.afterEachHooks.push(fn);
}

export function clearSuites(): void {
  suites.length = 0;
  currentSuite = null;
}

// Deep equality helper
function deepEqual(a: any, b: any): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

export class Expectation {
  constructor(private actual: any, private isNot = false) {}

  get not(): Expectation {
    return new Expectation(this.actual, !this.isNot);
  }

  private assert(condition: boolean, message: string): void {
    const passed = this.isNot ? !condition : condition;
    if (!passed) {
      throw new Error(this.isNot ? `Expected NOT: ${message}` : message);
    }
  }

  toBe(expected: any): void {
    this.assert(
      Object.is(this.actual, expected),
      `Expected ${JSON.stringify(this.actual)} to be ${JSON.stringify(expected)}`
    );
  }

  toEqual(expected: any): void {
    this.assert(
      deepEqual(this.actual, expected),
      `Expected deep equal: got ${JSON.stringify(this.actual)}, expected ${JSON.stringify(expected)}`
    );
  }

  toBeTruthy(): void {
    this.assert(Boolean(this.actual), `Expected ${this.actual} to be truthy`);
  }

  toBeFalsy(): void {
    this.assert(!this.actual, `Expected ${this.actual} to be falsy`);
  }

  toBeNull(): void {
    this.assert(this.actual === null, `Expected ${this.actual} to be null`);
  }

  toBeUndefined(): void {
    this.assert(this.actual === undefined, `Expected ${this.actual} to be undefined`);
  }

  toBeDefined(): void {
    this.assert(this.actual !== undefined, `Expected value to be defined, got undefined`);
  }

  toBeGreaterThan(expected: number): void {
    this.assert(
      typeof this.actual === 'number' && this.actual > expected,
      `Expected ${this.actual} > ${expected}`
    );
  }

  toBeGreaterThanOrEqual(expected: number): void {
    this.assert(
      typeof this.actual === 'number' && this.actual >= expected,
      `Expected ${this.actual} >= ${expected}`
    );
  }

  toBeLessThan(expected: number): void {
    this.assert(
      typeof this.actual === 'number' && this.actual < expected,
      `Expected ${this.actual} < ${expected}`
    );
  }

  toBeLessThanOrEqual(expected: number): void {
    this.assert(
      typeof this.actual === 'number' && this.actual <= expected,
      `Expected ${this.actual} <= ${expected}`
    );
  }

  toBeCloseTo(expected: number, numDigits = 2): void {
    const precision = Math.pow(10, -numDigits) / 2;
    const diff = Math.abs(this.actual - expected);
    this.assert(
      diff < precision,
      `Expected ${this.actual} to be close to ${expected} (diff: ${diff}, tol: ${precision})`
    );
  }

  toContain(expected: any): void {
    if (typeof this.actual === 'string') {
      this.assert(
        this.actual.includes(String(expected)),
        `Expected string "${this.actual}" to contain "${expected}"`
      );
    } else if (Array.isArray(this.actual)) {
      this.assert(
        this.actual.includes(expected) || this.actual.some(item => deepEqual(item, expected)),
        `Expected array to contain ${JSON.stringify(expected)}`
      );
    } else if (typeof this.actual === 'object' && this.actual !== null) {
      this.assert(
        Object.prototype.hasOwnProperty.call(this.actual, expected) ||
          Object.values(this.actual).some(v => deepEqual(v, expected)),
        `Expected object to contain key/value ${JSON.stringify(expected)}`
      );
    } else {
      this.assert(false, `Cannot call toContain on type ${typeof this.actual}`);
    }
  }

  toHaveLength(expected: number): void {
    const len = this.actual?.length;
    this.assert(
      typeof len === 'number' && len === expected,
      `Expected length ${expected}, got ${len}`
    );
  }

  toThrow(expectedErrorPattern?: string | RegExp): void {
    let threw = false;
    let thrownError: any = null;
    if (typeof this.actual !== 'function') {
      throw new Error(`Expected a function to test toThrow, got ${typeof this.actual}`);
    }
    try {
      this.actual();
    } catch (err) {
      threw = true;
      thrownError = err;
    }

    if (expectedErrorPattern) {
      const msg = thrownError instanceof Error ? thrownError.message : String(thrownError);
      const matches =
        typeof expectedErrorPattern === 'string'
          ? msg.includes(expectedErrorPattern)
          : expectedErrorPattern.test(msg);
      this.assert(
        threw && matches,
        `Expected function to throw matching ${expectedErrorPattern}, but got: ${msg}`
      );
    } else {
      this.assert(threw, `Expected function to throw an error, but it did not throw`);
    }
  }
}

export function expect(actual: any): Expectation {
  return new Expectation(actual);
}

export async function runAllSuites(suiteFilter?: string): Promise<SuiteSummary> {
  const summary: SuiteSummary = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
    results: [],
  };

  const startTotal = Date.now();

  for (const suite of suites) {
    if (suiteFilter && !suite.name.toLowerCase().includes(suiteFilter.toLowerCase())) {
      continue;
    }

    console.log(`\n\x1b[36m▶ Suite: ${suite.name}\x1b[0m`);

    // Run beforeAll hooks
    for (const hook of suite.beforeAllHooks) {
      try {
        await hook();
      } catch (err: any) {
        console.error(`  \x1b[31m✖ beforeAll hook failed: ${err.message}\x1b[0m`);
      }
    }

    for (const test of suite.tests) {
      summary.total++;
      if (test.skip) {
        summary.skipped++;
        console.log(`  \x1b[33m- [SKIP] ${test.name}\x1b[0m`);
        summary.results.push({
          suite: suite.name,
          name: test.name,
          passed: true,
          durationMs: 0,
        });
        continue;
      }

      // Run beforeEach hooks
      for (const hook of suite.beforeEachHooks) {
        await hook();
      }

      const testStart = Date.now();
      let passed = false;
      let testError: Error | undefined;

      try {
        // Execute with timeout
        await Promise.race([
          Promise.resolve(test.fn()),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`Test timed out after ${test.timeoutMs}ms`)),
              test.timeoutMs
            )
          ),
        ]);
        passed = true;
        summary.passed++;
        const duration = Date.now() - testStart;
        console.log(`  \x1b[32m✔ [PASS] ${test.name} (${duration}ms)\x1b[0m`);
        summary.results.push({
          suite: suite.name,
          name: test.name,
          passed: true,
          durationMs: duration,
        });
      } catch (err: any) {
        summary.failed++;
        testError = err;
        const duration = Date.now() - testStart;
        console.error(`  \x1b[31m✖ [FAIL] ${test.name} (${duration}ms)\x1b[0m`);
        console.error(`    \x1b[31m${err.stack || err.message}\x1b[0m`);
        summary.results.push({
          suite: suite.name,
          name: test.name,
          passed: false,
          durationMs: duration,
          error: err,
        });
      }

      // Run afterEach hooks
      for (const hook of suite.afterEachHooks) {
        try {
          await hook();
        } catch (err: any) {
          console.error(`  \x1b[31m✖ afterEach hook failed: ${err.message}\x1b[0m`);
        }
      }
    }

    // Run afterAll hooks
    for (const hook of suite.afterAllHooks) {
      try {
        await hook();
      } catch (err: any) {
        console.error(`  \x1b[31m✖ afterAll hook failed: ${err.message}\x1b[0m`);
      }
    }
  }

  summary.durationMs = Date.now() - startTotal;
  return summary;
}
