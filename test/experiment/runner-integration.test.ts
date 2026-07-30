import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EXPERIMENT_NAMES, scenarioSchema } from '../../src/config/scenario-schema.js';
import { expandRun } from '../../src/experiment/arguments.js';
import {
  runScenarioExperiments,
  type ExperimentRunnerDependencies,
} from '../../src/experiment/runner.js';
import { StdioExperimentSessionFactory } from '../../src/experiment/session.js';

const fixturePath = fileURLToPath(
  new URL('../fixtures/mcp-idempotency-target.mjs', import.meta.url),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe('real stdio experiment runner', () => {
  it('proves all seven experiment paths against an external idempotent MCP target', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'halfack-runner-'));
    temporaryDirectories.push(directory);
    const statePath = path.join(directory, 'state.json');
    const scenario = createScenario(directory, statePath);
    const dependencies: ExperimentRunnerDependencies = {
      createRunId: (_scenario, experiment, ordinal) => `real-${String(ordinal)}-${experiment}`,
      sessions: new StdioExperimentSessionFactory(),
    };

    const result = await runScenarioExperiments(scenario, dependencies);

    expect(result.status, JSON.stringify(result, undefined, 2)).toBe('pass');
    expect(result.halted).toBe(false);
    expect(result.counts).toEqual({
      inconclusive: 0,
      passed: 7,
      violations: 0,
    });
    expect(
      result.results.every(
        (experiment) =>
          experiment.conclusion.kind === 'pass' && experiment.cleanup.kind === 'clean',
      ),
    ).toBe(true);
    const cancellation = result.results.find(
      (experiment) => experiment.experiment === 'cancel_on_progress',
    );
    expect(cancellation?.conclusion).toEqual({
      expected: 0,
      kind: 'pass',
      observed: 0,
    });
    expect(cancellation?.final?.value).toBe(0);
    if (cancellation?.fault.kind !== 'cancel_on_progress') {
      throw new Error('The cancellation experiment did not retain its fault evidence.');
    }
    expect(cancellation.fault.cancellationWrite.byteLength).toBeGreaterThan(0);
    expect(cancellation.fault.cancellationWrite.sequence).toBeGreaterThan(0);
  }, 120_000);

  it('commits the delayed effect when only another request is cancelled', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'halfack-runner-control-'));
    temporaryDirectories.push(directory);
    const statePath = path.join(directory, 'state.json');
    const scenario = createScenario(directory, statePath);
    const run = expandRun(scenario, 'real-uncancelled-control');
    const session = await new StdioExperimentSessionFactory().open({ run, scenario });
    let matchingProgressSeen = false;
    const unsubscribe = session.subscribe((notification) => {
      if (
        notification.method === 'notifications/progress' &&
        notification.progressToken === 'uncancelled-progress'
      ) {
        matchingProgressSeen = true;
      }
    });

    try {
      await expect(
        session.call(run.reset, { timeoutMs: scenario.timeouts.requestMs }),
      ).resolves.toMatchObject({ kind: 'success' });
      const handle = session.begin(run.exercise, {
        progressToken: 'uncancelled-progress',
        requestId: 'uncancelled-request',
        timeoutMs: scenario.timeouts.requestMs,
      });

      await expect(handle.writeAccepted).resolves.toMatchObject({
        acceptedByLocalPipe: true,
      });

      const unrelatedHandle = session.begin(
        {
          arguments: { clientToken: 'real-unrelated-control' },
          tool: run.exercise.tool,
        },
        {
          progressToken: 'unrelated-progress',
          requestId: 'unrelated-request',
          timeoutMs: scenario.timeouts.requestMs,
        },
      );
      const unrelatedOutcome = unrelatedHandle.outcome.then(
        () => 'resolved' as const,
        () => 'cancelled' as const,
      );
      await expect(unrelatedHandle.writeAccepted).resolves.toMatchObject({
        acceptedByLocalPipe: true,
      });
      await expect(unrelatedHandle.cancel()).resolves.toMatchObject({
        acceptedByLocalPipe: true,
      });
      await expect(unrelatedOutcome).resolves.toBe('cancelled');

      await expect(handle.outcome).resolves.toMatchObject({ kind: 'success' });
      expect(matchingProgressSeen).toBe(true);
      await expect(session.settle()).resolves.toMatchObject({ value: 1 });
    } finally {
      unsubscribe();
      await session.close();
    }
  }, 10_000);
});

function createScenario(directory: string, statePath: string) {
  const parsedScenario = scenarioSchema.parse({
    exercise: {
      arguments: {
        clientToken: '${run.id}',
      },
      tool: 'orders.create',
    },
    experiments: [...EXPERIMENT_NAMES],
    name: 'real-idempotent-target',
    oracle: {
      baseline: 0,
      cancelledEffect: 0,
      once: 1,
    },
    persistence: 'external',
    probe: {
      arguments: {
        scope: '${run.id}',
      },
      pointer: '/structuredContent/count',
      settle: {
        intervalMs: 100,
        stableSamples: 2,
        timeoutMs: 1_200,
      },
      tool: 'orders.count',
    },
    reset: {
      arguments: {
        scope: '${run.id}',
      },
      tool: 'test.reset',
    },
    safety: {
      disposable: true,
      processBoundary: 'single-process',
    },
    schema: 'halfack/v1',
    target: {
      args: [fixturePath, statePath],
      command: process.execPath,
      cwd: '.',
      envAllowlist: ['PATH', 'SystemRoot'],
      protocol: '2026-07-28',
      transport: 'stdio',
    },
    timeouts: {
      requestMs: 5_000,
      shutdownMs: 1_000,
    },
  });

  return {
    ...parsedScenario,
    target: {
      ...parsedScenario.target,
      cwd: directory,
    },
  };
}
