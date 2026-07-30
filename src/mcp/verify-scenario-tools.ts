import type { Scenario } from '../config/scenario-schema.js';
import type { McpTool, RawMcpClient } from './raw-client.js';

export function requiredScenarioToolNames(scenario: Scenario): readonly string[] {
  return [...new Set([scenario.exercise.tool, scenario.reset.tool, scenario.probe.tool])];
}

export async function verifyScenarioTools(
  client: RawMcpClient,
  scenario: Scenario,
): Promise<readonly McpTool[]> {
  return client.requireTools(requiredScenarioToolNames(scenario));
}
