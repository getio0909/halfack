import { loadScenario } from '../../config/load-scenario.js';
import { UsageError } from '../../domain/errors.js';
import type { CliIo } from '../run.js';

export async function validateCommand(arguments_: readonly string[], io: CliIo): Promise<void> {
  if (arguments_.length !== 1) {
    throw new UsageError("Command 'validate' requires exactly one scenario path.");
  }

  const [scenarioPath] = arguments_;
  if (scenarioPath === undefined) {
    throw new UsageError("Command 'validate' requires exactly one scenario path.");
  }

  const loaded = await loadScenario(scenarioPath);
  io.writeOutput(`Valid scenario '${loaded.scenario.name}'.\n`);
}
