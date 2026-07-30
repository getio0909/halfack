import { afterEach, describe, expect, it } from 'vitest';
import { scenarioSchema } from '../../src/config/scenario-schema.js';
import { RawMcpClient } from '../../src/mcp/raw-client.js';
import {
  requiredScenarioToolNames,
  verifyScenarioTools,
} from '../../src/mcp/verify-scenario-tools.js';
import { createValidScenario } from '../config/scenario-fixture.js';
import { FakeMessageTransport } from './fake-transport.js';

const clients: RawMcpClient[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
});

describe('scenario tool verification', () => {
  it('deduplicates roles that use the same tool name', () => {
    const input = createValidScenario();
    (input['reset'] as Record<string, unknown>)['tool'] = 'orders.create';
    const scenario = scenarioSchema.parse(input);

    expect(requiredScenarioToolNames(scenario)).toEqual(['orders.create', 'orders.count']);
  });

  it('verifies exercise, reset, and probe tools against the server catalog', async () => {
    const scenario = scenarioSchema.parse(createValidScenario());
    const transport = new FakeMessageTransport();
    const client = new RawMcpClient(transport, { requestTimeoutMs: 1_000 });
    clients.push(client);

    const verified = verifyScenarioTools(client, scenario);
    const request = await transport.nextSent();
    transport.pushIncoming({
      id: request['id'],
      jsonrpc: '2.0',
      result: {
        tools: requiredScenarioToolNames(scenario).map((name) => ({
          inputSchema: { type: 'object' },
          name,
        })),
      },
    });

    await expect(verified).resolves.toMatchObject([
      { name: scenario.exercise.tool },
      { name: scenario.reset.tool },
      { name: scenario.probe.tool },
    ]);
  });
});
