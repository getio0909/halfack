import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scenarioSchema } from '../../src/config/scenario-schema.js';
import {
  runScenarioExperiments,
  type ExperimentRunnerDependencies,
} from '../../src/experiment/runner.js';
import { StdioExperimentSessionFactory } from '../../src/experiment/session.js';

const fixturePath = fileURLToPath(
  new URL('../fixtures/mcp-delayed-duplicate-target.mjs', import.meta.url),
);

describe('real stdio late-effect regression', () => {
  it('rejects a delayed duplicate inside the observation window and resets external state', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'halfack-late-effect-'));
    const statePath = path.join(directory, 'state.json');
    const runId = 'late-effect-scope';

    try {
      const scenario = createScenario(directory, statePath);
      const dependencies: ExperimentRunnerDependencies = {
        createRunId: () => runId,
        sessions: new StdioExperimentSessionFactory(),
      };

      const result = await runScenarioExperiments(scenario, dependencies);

      expect(result.status, JSON.stringify(result, undefined, 2)).toBe('violation');
      expect(result.counts).toEqual({
        inconclusive: 0,
        passed: 0,
        violations: 1,
      });
      expect(result.results[0]?.conclusion).toEqual({
        expected: 1,
        kind: 'violation',
        observed: 2,
        phase: 'final_effect',
      });
      expect(result.results[0]?.cleanup.kind).toBe('clean');
      await expect(readScopeCount(statePath, runId)).resolves.toBe(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 15_000);
});

function createScenario(directory: string, statePath: string) {
  const parsedScenario = scenarioSchema.parse({
    exercise: {
      arguments: {
        clientToken: '${run.id}',
      },
      tool: 'orders.create',
    },
    experiments: ['retry_new_id'],
    name: 'delayed-duplicate-regression',
    oracle: {
      baseline: 0,
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
      requestMs: 2_000,
      shutdownMs: 500,
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

async function readScopeCount(statePath: string, scope: string): Promise<number> {
  const parsed: unknown = JSON.parse(await readFile(statePath, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('The delayed-duplicate state file is invalid.');
  }
  const count = (parsed as Record<string, unknown>)[scope];
  if (!Number.isSafeInteger(count) || typeof count !== 'number' || count < 0) {
    throw new TypeError('The delayed-duplicate scope counter is invalid.');
  }
  return count;
}
