import { describe, expect, it } from 'vitest';
import type {
  CleanupEvidence,
  ExperimentConclusion,
  ExperimentResult,
  ExperimentSuiteResult,
  SafeProcessEvidence,
} from '../../src/experiment/types.js';
import {
  REPORT_SCHEMA,
  createReport,
  renderHumanReport,
  renderJsonReport,
} from '../../src/report/report.js';

const CONFIRMED_PROCESS = Object.freeze({
  closeObserved: true,
  code: 0,
  directProcessTermination: 'confirmed',
  exitObserved: true,
  processBoundary: 'declared-single-process',
  signal: null,
  stderrTotalBytes: 0,
  stderrTruncated: false,
  stdioDetached: false,
  termination: 'natural',
}) satisfies SafeProcessEvidence;

function result(
  input: Pick<ExperimentResult, 'experiment' | 'fault' | 'runId'> & {
    readonly cleanup: CleanupEvidence;
    readonly conclusion: ExperimentConclusion;
  },
): ExperimentResult {
  return {
    attempts: [],
    cleanup: input.cleanup,
    conclusion: input.conclusion,
    experiment: input.experiment,
    fault: input.fault,
    runId: input.runId,
  };
}

function suiteFixture(): ExperimentSuiteResult {
  return {
    counts: {
      inconclusive: 1,
      passed: 2,
      violations: 1,
    },
    halted: true,
    results: [
      result({
        cleanup: {
          kind: 'clean',
          process: CONFIRMED_PROCESS,
        },
        conclusion: {
          expected: 1,
          kind: 'pass',
          observed: 1,
        },
        experiment: 'suppress_completed_response',
        fault: {
          kind: 'suppress_completed_response',
          seedId: 'pass-seed',
        },
        runId: 'run-pass',
      }),
      result({
        cleanup: {
          kind: 'not_needed',
        },
        conclusion: {
          expected: 1,
          kind: 'violation',
          observed: 2,
          phase: 'final_effect',
        },
        experiment: 'retry_new_id',
        fault: {
          firstId: 'violation-seed',
          kind: 'retry_new_id',
          retryId: 'violation-retry',
        },
        runId: 'run-violation',
      }),
      result({
        cleanup: {
          kind: 'not_needed',
        },
        conclusion: {
          kind: 'inconclusive',
          phase: 'fault',
          reason: 'fault_not_proven',
        },
        experiment: 'cancel_on_progress',
        fault: {
          kind: 'not_proven',
          reason: 'missing_progress',
        },
        runId: 'run-inconclusive',
      }),
      result({
        cleanup: {
          kind: 'failed',
          phase: 'reset',
        },
        conclusion: {
          expected: 1,
          kind: 'pass',
          observed: 1,
        },
        experiment: 'parallel_new_ids',
        fault: {
          ids: ['parallel-a', 'parallel-b'],
          kind: 'parallel_new_ids',
        },
        runId: 'run-cleanup-failed',
      }),
    ],
    scenario: 'reporting-demo',
    status: 'violation',
  };
}

function resultLine(rendered: string, experiment: ExperimentResult['experiment']): string {
  const line = rendered.split('\n').find((candidate) => candidate.includes(experiment));
  expect(line, `missing human report line for ${experiment}`).toBeDefined();
  return line ?? '';
}

describe('report envelope', () => {
  it('creates a stable versioned envelope around the complete suite result', () => {
    const suite = suiteFixture();
    const generatedAt = new Date('2026-07-30T12:34:56.789Z');

    const report = createReport(suite, generatedAt);

    expect(REPORT_SCHEMA).toBe('halfack/report/v1');
    expect(report).toEqual({
      generatedAt: '2026-07-30T12:34:56.789Z',
      schema: 'halfack/report/v1',
      suite,
      tool: {
        name: 'halfack',
        version: '0.1.0',
      },
    });
  });

  it('rejects an invalid generation date instead of emitting an invalid timestamp', () => {
    expect(() => createReport(suiteFixture(), new Date(Number.NaN))).toThrow(
      /invalid.*date|date.*invalid/iu,
    );
  });
});

describe('human report rendering', () => {
  it('renders every conclusion and a cleanup failure as distinct readable outcomes', () => {
    const rendered = renderHumanReport(
      createReport(suiteFixture(), new Date('2026-07-30T12:34:56.789Z')),
    );

    expect(resultLine(rendered, 'suppress_completed_response')).toMatch(/\bPASS\b/u);
    expect(resultLine(rendered, 'retry_new_id')).toMatch(
      /\bVIOLATION\b.*expected[=: ]+1.*observed[=: ]+2/iu,
    );
    expect(resultLine(rendered, 'cancel_on_progress')).toMatch(
      /\bINCONCLUSIVE\b.*phase[=: ]+fault.*reason[=: ]+fault_not_proven/iu,
    );
    expect(resultLine(rendered, 'parallel_new_ids')).toMatch(
      /\bPASS\b.*\bCLEANUP FAILED\b.*reset/iu,
    );
  });

  it('escapes untrusted control characters instead of allowing terminal or line injection', () => {
    const base = suiteFixture();
    const first = base.results[0];
    if (first === undefined) {
      throw new Error('suite fixture unexpectedly has no results');
    }
    const unsafeSuite: ExperimentSuiteResult = {
      ...base,
      results: [
        {
          ...first,
          runId: 'run\u001b[31m\r\nforged\u0000',
        },
        ...base.results.slice(1),
      ],
      scenario: 'scenario\u001b[2J\r\nforged\u0000',
    };

    const rendered = renderHumanReport(
      createReport(unsafeSuite, new Date('2026-07-30T12:34:56.789Z')),
    );

    expect(rendered).not.toContain('\u001b');
    expect(rendered).not.toContain('\r');
    expect(rendered).not.toContain('\u0000');
    expect(rendered).not.toContain('scenario\u001b[2J\r\nforged\u0000');
    expect(rendered).not.toContain('run\u001b[31m\r\nforged\u0000');
    expect(rendered).toContain('scenario\\u001b[2J\\r\\nforged\\u0000');
    expect(rendered).toContain('run\\u001b[31m\\r\\nforged\\u0000');
  });
});

describe('JSON report rendering', () => {
  it('emits parseable JSON with exactly one trailing newline', () => {
    const report = createReport(suiteFixture(), new Date('2026-07-30T12:34:56.789Z'));

    const rendered = renderJsonReport(report);

    expect(rendered.endsWith('\n')).toBe(true);
    expect(rendered.endsWith('\n\n')).toBe(false);
    expect(JSON.parse(rendered) as unknown).toEqual(report);
  });

  it('projects only v1 fields and snapshots them before rendering', () => {
    const base = suiteFixture();
    const first = base.results[0];
    if (first === undefined) {
      throw new Error('suite fixture unexpectedly has no results');
    }
    const taintedFirst = Object.assign({}, first, {
      rawResponse: { authorization: 'Bearer canary-secret' },
      stderr: 'canary-secret',
    });
    const mutableResults = [taintedFirst, ...base.results.slice(1)];
    const mutableSuite = Object.assign({}, base, {
      authorization: 'Bearer canary-secret',
      results: mutableResults,
    });
    const report = createReport(mutableSuite, new Date('2026-07-30T12:34:56.789Z'));

    Reflect.set(mutableSuite, 'scenario', 'mutated-after-snapshot');
    mutableResults.splice(0);
    const rendered = renderJsonReport(report);

    expect(rendered).not.toContain('canary-secret');
    expect(rendered).not.toContain('mutated-after-snapshot');
    expect(report.suite.results).toHaveLength(4);
    expect(Object.isFrozen(report.suite.results)).toBe(true);
    expect(Object.keys(report).sort()).toEqual(['generatedAt', 'schema', 'suite', 'tool']);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0, 2 ** 53])(
    'rejects the lossy JSON number %s',
    (invalidNumber) => {
      const base = suiteFixture();
      const invalidSuite: ExperimentSuiteResult = {
        ...base,
        counts: {
          ...base.counts,
          passed: invalidNumber,
        },
      };

      expect(() => createReport(invalidSuite, new Date('2026-07-30T12:34:56.789Z'))).toThrow(
        /reported safely|invalid/iu,
      );
    },
  );

  it('rejects inconsistent summary counts and status instead of publishing false evidence', () => {
    const base = suiteFixture();
    const inconsistentCounts: ExperimentSuiteResult = {
      ...base,
      counts: {
        ...base.counts,
        passed: base.counts.passed + 1,
      },
    };
    const inconsistentStatus: ExperimentSuiteResult = {
      ...base,
      status: 'pass',
    };

    expect(() => createReport(inconsistentCounts, new Date('2026-07-30T12:34:56.789Z'))).toThrow(
      /reported safely|consistent/iu,
    );
    expect(() => createReport(inconsistentStatus, new Date('2026-07-30T12:34:56.789Z'))).toThrow(
      /reported safely|consistent/iu,
    );
  });
});
