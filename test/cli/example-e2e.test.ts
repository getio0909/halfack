import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const cliPath = path.join(projectRoot, 'dist', 'cli', 'main.js');
const trackedExampleDirectory = path.join(projectRoot, 'examples');
const scenarioFilename = 'duplicate-order.halfack.yml';
const commandTimeoutMs = 90_000;
const temporaryDirectories: string[] = [];

const expectedExperiments = [
  'suppress_completed_response',
  'retry_new_id',
  'rpc_id_reuse',
  'restart_after_suppressed_response',
  'parallel_new_ids',
  'cancel_on_progress',
  'disconnect_after_request_write_accepted',
] as const;

interface CliExecution {
  readonly errorCode: string | undefined;
  readonly signal: NodeJS.Signals | null;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface ExampleReport {
  readonly suite?: {
    readonly counts?: {
      readonly inconclusive?: unknown;
      readonly passed?: unknown;
      readonly violations?: unknown;
    };
    readonly halted?: unknown;
    readonly results?: readonly {
      readonly conclusion?: {
        readonly kind?: unknown;
      };
      readonly experiment?: unknown;
    }[];
    readonly scenario?: unknown;
    readonly status?: unknown;
  };
}

function executeBuiltCli(arguments_: readonly string[], cwd: string): CliExecution {
  const result = spawnSync(process.execPath, [cliPath, ...arguments_], {
    cwd,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 4 * 1024 * 1024,
    timeout: commandTimeoutMs,
    windowsHide: true,
  });
  const error = result.error as NodeJS.ErrnoException | undefined;

  return {
    errorCode: error?.code,
    signal: result.signal,
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

async function copyTrackedExample(): Promise<{
  readonly directory: string;
  readonly scenarioPath: string;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfack-example-e2e-'));
  temporaryDirectories.push(directory);
  const exampleDirectory = path.join(directory, 'example');
  await cp(trackedExampleDirectory, exampleDirectory, {
    errorOnExist: true,
    recursive: true,
  });

  return {
    directory: exampleDirectory,
    scenarioPath: path.join(exampleDirectory, scenarioFilename),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe('tracked example through the built CLI', () => {
  it('completes all seven experiments in JSON and human formats without hanging', async () => {
    const example = await copyTrackedExample();
    const jsonExecution = executeBuiltCli(
      ['run', example.scenarioPath, '--format=json'],
      example.directory,
    );

    expect(
      {
        errorCode: jsonExecution.errorCode,
        signal: jsonExecution.signal,
        status: jsonExecution.status,
        stderr: jsonExecution.stderr,
      },
      jsonExecution.stdout,
    ).toEqual({
      errorCode: undefined,
      signal: null,
      status: 0,
      stderr: '',
    });

    const parsed: unknown = JSON.parse(jsonExecution.stdout);
    const report = parsed as ExampleReport;
    const results = report.suite?.results ?? [];

    expect({
      allPassed: results.every((result) => result.conclusion?.kind === 'pass'),
      counts: report.suite?.counts,
      experiments: results.map((result) => result.experiment),
      halted: report.suite?.halted,
      resultCount: results.length,
      scenario: report.suite?.scenario,
      status: report.suite?.status,
    }).toEqual({
      allPassed: true,
      counts: {
        inconclusive: 0,
        passed: 7,
        violations: 0,
      },
      experiments: expectedExperiments,
      halted: false,
      resultCount: 7,
      scenario: 'duplicate-order',
      status: 'pass',
    });

    const humanExecution = executeBuiltCli(
      ['run', example.scenarioPath, '--format=human'],
      example.directory,
    );
    const humanLines = humanExecution.stdout.split(/\r?\n/u);

    expect(
      {
        errorCode: humanExecution.errorCode,
        hasEveryExperiment: expectedExperiments.every((experiment) =>
          humanLines.some((line) => line.includes(`[PASS] ${experiment} `)),
        ),
        hasStatus: humanLines.includes('Status: PASS'),
        hasSummary: humanLines.includes('Summary: 7 passed, 0 violations, 0 inconclusive'),
        passLineCount: humanLines.filter((line) => line.startsWith('  [PASS] ')).length,
        signal: humanExecution.signal,
        status: humanExecution.status,
        stderr: humanExecution.stderr,
      },
      humanExecution.stdout,
    ).toEqual({
      errorCode: undefined,
      hasEveryExperiment: true,
      hasStatus: true,
      hasSummary: true,
      passLineCount: 7,
      signal: null,
      status: 0,
      stderr: '',
    });
  }, 200_000);
});
