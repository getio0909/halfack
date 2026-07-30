import { stringify } from 'yaml';

export function createValidScenario(): Record<string, unknown> {
  return {
    schema: 'halfack/v1',
    name: 'duplicate-order',
    description: 'Detect duplicate effects after an acknowledged response is lost.',
    target: {
      transport: 'stdio',
      protocol: '2026-07-28',
      command: process.execPath,
      args: ['./server.mjs', '--fixture=https://example.invalid/?a=1&b=2'],
      cwd: './sandbox',
      envAllowlist: ['PATH', 'SystemRoot'],
    },
    persistence: 'external',
    exercise: {
      tool: 'orders.create',
      arguments: {
        clientToken: '${run.id}',
        nested: ['literal', { run: '${run.id}' }],
      },
    },
    reset: {
      tool: 'test.reset',
      arguments: {
        scope: '${run.id}',
      },
    },
    probe: {
      tool: 'orders.count',
      arguments: {
        scope: '${run.id}',
      },
      pointer: '/structuredContent/count',
      settle: {
        timeoutMs: 2_000,
        intervalMs: 50,
        stableSamples: 2,
      },
    },
    oracle: {
      baseline: 0,
      once: 1,
      cancelledEffect: 0,
    },
    experiments: [
      'suppress_completed_response',
      'retry_new_id',
      'restart_after_suppressed_response',
    ],
    safety: {
      disposable: true,
      processBoundary: 'single-process',
    },
    timeouts: {
      requestMs: 3_000,
      shutdownMs: 1_000,
    },
  };
}

export function scenarioYaml(scenario: Record<string, unknown> = createValidScenario()): string {
  return stringify(scenario, { lineWidth: 0 });
}
