import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Scenario } from '../../src/config/scenario-schema.js';
import { ExitCode } from '../../src/domain/exit-code.js';
import { TargetError } from '../../src/domain/errors.js';
import type {
  ExperimentConclusion,
  ExperimentResult,
  ExperimentSuiteResult,
  InconclusiveReason,
  SafeProcessEvidence,
} from '../../src/experiment/types.js';
import { runCli, type CliIo } from '../../src/cli/run.js';
import { VERSION } from '../../src/version.js';
import { createValidScenario, scenarioYaml } from '../config/scenario-fixture.js';

const FIXED_NOW = new Date('2026-07-30T20:00:00.000Z');
const temporaryDirectories: string[] = [];
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

interface CapturedIo {
  readonly io: CliIo;
  readonly stderr: string[];
  readonly stdout: string[];
}

interface RunScenarioOptions {
  readonly signal?: AbortSignal;
}

type RunScenario = (
  scenario: Scenario,
  options?: RunScenarioOptions,
) => Promise<ExperimentSuiteResult>;

interface CliDependenciesUnderTest {
  readonly now: () => Date;
  readonly runScenario: RunScenario;
}

interface RunCliOptionsUnderTest {
  readonly dependencies?: Partial<CliDependenciesUnderTest>;
  readonly signal?: AbortSignal;
}

type RunCliUnderTest = (
  arguments_: readonly string[],
  io: CliIo,
  options?: RunCliOptionsUnderTest,
) => Promise<ExitCode | number>;

interface RunnerCall {
  readonly scenarioName: string;
  readonly signal: AbortSignal | undefined;
}

const runCliUnderTest: RunCliUnderTest = runCli;

function captureIo(): CapturedIo {
  const stderr: string[] = [];
  const stdout: string[] = [];

  return {
    io: {
      writeError: (value) => {
        stderr.push(value);
      },
      writeOutput: (value) => {
        stdout.push(value);
      },
    },
    stderr,
    stdout,
  };
}

async function createScenarioPath(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfack-run-cli-'));
  temporaryDirectories.push(directory);
  await mkdir(path.join(directory, 'sandbox'));

  const scenario = createValidScenario();
  const target = scenario['target'] as Record<string, unknown>;
  target['args'] = ['--this-command-must-not-run'];
  target['command'] = process.execPath;
  target['cwd'] = './sandbox';

  const scenarioPath = path.join(directory, 'scenario.yml');
  await writeFile(scenarioPath, scenarioYaml(scenario));
  return scenarioPath;
}

function createResult(
  conclusion: ExperimentConclusion,
  runId = 'duplicate-order-run-1',
): ExperimentResult {
  const concluded = conclusion.kind !== 'inconclusive';
  return {
    attempts: [],
    cleanup: concluded
      ? {
          kind: 'clean',
          process: CONFIRMED_PROCESS,
        }
      : { kind: 'not_needed' },
    conclusion,
    experiment: 'retry_new_id',
    fault: concluded
      ? {
          firstId: `${runId}:seed`,
          kind: 'retry_new_id',
          retryId: `${runId}:retry`,
        }
      : {
          kind: 'not_proven',
          reason: 'unexpected_outcome',
        },
    runId,
  };
}

function createSuite(
  status: ExperimentSuiteResult['status'],
  options: {
    readonly halted?: boolean;
    readonly inconclusiveReason?: InconclusiveReason;
  } = {},
): ExperimentSuiteResult {
  const conclusion: ExperimentConclusion =
    status === 'pass'
      ? {
          expected: 1,
          kind: 'pass',
          observed: 1,
        }
      : status === 'violation'
        ? {
            expected: 1,
            kind: 'violation',
            observed: 2,
            phase: 'final_effect',
          }
        : {
            kind: 'inconclusive',
            phase: 'fault',
            reason: options.inconclusiveReason ?? 'probe_failed',
          };

  return {
    counts: {
      inconclusive: status === 'inconclusive' ? 1 : 0,
      passed: status === 'pass' ? 1 : 0,
      violations: status === 'violation' ? 1 : 0,
    },
    halted: options.halted ?? false,
    results: [createResult(conclusion)],
    scenario: 'duplicate-order',
    status,
  };
}

function fakeRunner(result: ExperimentSuiteResult, calls: RunnerCall[] = []): RunScenario {
  return (scenario, options = {}) => {
    calls.push({
      scenarioName: scenario.name,
      signal: options.signal,
    });
    return Promise.resolve(result);
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe('halfack run', () => {
  it('loads a scenario, runs it without spawning the configured target, and renders human output', async () => {
    const scenarioPath = await createScenarioPath();
    const captured = captureIo();
    const calls: RunnerCall[] = [];

    const exitCode = await runCliUnderTest(['run', scenarioPath], captured.io, {
      dependencies: {
        runScenario: fakeRunner(createSuite('pass'), calls),
      },
    });
    const output = captured.stdout.join('');

    expect({
      calls,
      exitCode,
      hasPass: output.includes('PASS'),
      hasScenario: output.includes('duplicate-order'),
      stderr: captured.stderr.join(''),
    }).toEqual({
      calls: [
        {
          scenarioName: 'duplicate-order',
          signal: undefined,
        },
      ],
      exitCode: ExitCode.Success,
      hasPass: true,
      hasScenario: true,
      stderr: '',
    });
  });

  it('accepts equals-form options and writes the stable JSON report to stdout', async () => {
    const scenarioPath = await createScenarioPath();
    const captured = captureIo();
    const suite = createSuite('pass');

    const exitCode = await runCliUnderTest(['run', scenarioPath, '--format=json'], captured.io, {
      dependencies: {
        now: () => FIXED_NOW,
        runScenario: fakeRunner(suite),
      },
    });
    const output = captured.stdout.join('');

    expect({
      exitCode,
      hasSingleTrailingNewline: output.endsWith('\n') && !output.endsWith('\n\n'),
      report: JSON.parse(output) as unknown,
      stderr: captured.stderr.join(''),
    }).toEqual({
      exitCode: ExitCode.Success,
      hasSingleTrailingNewline: true,
      report: {
        generatedAt: FIXED_NOW.toISOString(),
        schema: 'halfack/report/v1',
        suite,
        tool: {
          name: 'halfack',
          version: VERSION,
        },
      },
      stderr: '',
    });
  });

  it.each([
    ['pass', ExitCode.Success],
    ['violation', ExitCode.ContractViolation],
    ['inconclusive', 4],
  ] as const)('maps a %s suite to stable exit code %i', async (status, expectedExitCode) => {
    const scenarioPath = await createScenarioPath();
    const captured = captureIo();

    const exitCode = await runCliUnderTest(['run', scenarioPath, '--format', 'json'], captured.io, {
      dependencies: {
        now: () => FIXED_NOW,
        runScenario: fakeRunner(createSuite(status)),
      },
    });

    expect({
      exitCode,
      stderr: captured.stderr.join(''),
      status: (JSON.parse(captured.stdout.join('')) as { status?: unknown }).status,
    }).toEqual({
      exitCode: expectedExitCode,
      stderr: '',
      status: undefined,
    });
    expect(
      (JSON.parse(captured.stdout.join('')) as { suite?: { status?: unknown } }).suite?.status,
    ).toBe(status);
  });

  it('returns 130 for an aborted experiment suite and forwards the abort signal', async () => {
    const scenarioPath = await createScenarioPath();
    const captured = captureIo();
    const controller = new AbortController();
    const calls: RunnerCall[] = [];
    const runScenario: RunScenario = (scenario, options = {}) => {
      calls.push({
        scenarioName: scenario.name,
        signal: options.signal,
      });
      controller.abort();
      return Promise.resolve(
        createSuite('inconclusive', {
          halted: true,
          inconclusiveReason: 'aborted',
        }),
      );
    };

    const exitCode = await runCliUnderTest(['run', scenarioPath, '--format=json'], captured.io, {
      dependencies: {
        now: () => FIXED_NOW,
        runScenario,
      },
      signal: controller.signal,
    });

    expect({
      calls,
      exitCode,
      reportStatus: (JSON.parse(captured.stdout.join('')) as { suite?: { status?: unknown } }).suite
        ?.status,
      stderr: captured.stderr.join(''),
    }).toEqual({
      calls: [
        {
          scenarioName: 'duplicate-order',
          signal: controller.signal,
        },
      ],
      exitCode: 130,
      reportStatus: 'inconclusive',
      stderr: '',
    });
  });

  it('supports separated output options and creates the report file exclusively', async () => {
    const scenarioPath = await createScenarioPath();
    const outputPath = path.join(path.dirname(scenarioPath), 'result.json');
    const captured = captureIo();
    const suite = createSuite('violation');

    const exitCode = await runCliUnderTest(
      ['run', scenarioPath, '--format', 'json', '--output', outputPath],
      captured.io,
      {
        dependencies: {
          now: () => FIXED_NOW,
          runScenario: fakeRunner(suite),
        },
      },
    );
    const reportText = await readFile(outputPath, 'utf8');

    expect({
      exitCode,
      report: JSON.parse(reportText) as unknown,
      stderr: captured.stderr.join(''),
    }).toEqual({
      exitCode: ExitCode.ContractViolation,
      report: {
        generatedAt: FIXED_NOW.toISOString(),
        schema: 'halfack/report/v1',
        suite,
        tool: {
          name: 'halfack',
          version: VERSION,
        },
      },
      stderr: '',
    });
  });

  it('accepts an equals-form output path', async () => {
    const scenarioPath = await createScenarioPath();
    const outputPath = path.join(path.dirname(scenarioPath), 'result.txt');
    const captured = captureIo();

    const exitCode = await runCliUnderTest(
      ['run', scenarioPath, '--output=' + outputPath],
      captured.io,
      {
        dependencies: {
          runScenario: fakeRunner(createSuite('pass')),
        },
      },
    );

    expect({
      created: await pathExists(outputPath),
      exitCode,
      hasPass: (await readFile(outputPath, 'utf8')).includes('PASS'),
      stderr: captured.stderr.join(''),
    }).toEqual({
      created: true,
      exitCode: ExitCode.Success,
      hasPass: true,
      stderr: '',
    });
  });

  it('never overwrites an existing output file or starts the experiment', async () => {
    const scenarioPath = await createScenarioPath();
    const outputPath = path.join(path.dirname(scenarioPath), 'existing.json');
    const sentinel = 'keep-this-content';
    await writeFile(outputPath, sentinel, { flag: 'wx' });
    const captured = captureIo();
    const calls: RunnerCall[] = [];

    const exitCode = await runCliUnderTest(
      ['run', scenarioPath, '--format=json', '--output=' + outputPath],
      captured.io,
      {
        dependencies: {
          now: () => FIXED_NOW,
          runScenario: fakeRunner(createSuite('pass'), calls),
        },
      },
    );

    const stderr = captured.stderr.join('');
    expect({
      calls,
      exitCode,
      file: await readFile(outputPath, 'utf8'),
      stdout: captured.stdout.join(''),
    }).toEqual({
      calls: [],
      exitCode: ExitCode.Usage,
      file: sentinel,
      stdout: '',
    });
    expect(stderr).toMatch(/^HALFACK_USAGE: .+\n$/u);
    expect(stderr.toLowerCase()).toContain('exist');
    expect(stderr).not.toContain("Unknown command 'run'");
  });

  it.each([
    [[], 'scenario path'],
    [['one.yml', 'two.yml'], 'one scenario path'],
    [['scenario.yml', '--format'], 'format'],
    [['scenario.yml', '--format=xml'], 'format'],
    [['scenario.yml', '--output'], 'output'],
    [['scenario.yml', '--unknown'], 'option'],
    [['scenario.yml', '--format=json', '--format=human'], 'format'],
  ])('rejects invalid arguments before running: %j', async (runArguments, messageFragment) => {
    const captured = captureIo();
    const calls: RunnerCall[] = [];

    const exitCode = await runCliUnderTest(['run', ...runArguments], captured.io, {
      dependencies: {
        runScenario: fakeRunner(createSuite('pass'), calls),
      },
    });
    const stderr = captured.stderr.join('');

    expect({
      calls,
      exitCode,
      mentionsReason: stderr.toLowerCase().includes(messageFragment),
      stderrShape: /^HALFACK_USAGE: .+\n$/u.test(stderr),
      stdout: captured.stdout.join(''),
    }).toEqual({
      calls: [],
      exitCode: ExitCode.Usage,
      mentionsReason: true,
      stderrShape: true,
      stdout: '',
    });
  });

  it('routes target failures only to stderr without emitting a partial report', async () => {
    const scenarioPath = await createScenarioPath();
    const captured = captureIo();
    const runScenario: RunScenario = () => {
      throw new TargetError('The MCP target exited before initialization.');
    };

    const exitCode = await runCliUnderTest(['run', scenarioPath], captured.io, {
      dependencies: {
        runScenario,
      },
    });

    expect({
      exitCode,
      stderr: captured.stderr.join(''),
      stdout: captured.stdout.join(''),
    }).toEqual({
      exitCode: ExitCode.Target,
      stderr: 'HALFACK_TARGET: The MCP target exited before initialization.\n',
      stdout: '',
    });
  });
});
