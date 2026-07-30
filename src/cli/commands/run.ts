import { loadScenario } from '../../config/load-scenario.js';
import type { Scenario } from '../../config/scenario-schema.js';
import { ExitCode } from '../../domain/exit-code.js';
import { UsageError } from '../../domain/errors.js';
import {
  createDefaultExperimentRunnerDependencies,
  runScenarioExperiments,
} from '../../experiment/runner.js';
import type { ExperimentSuiteResult } from '../../experiment/types.js';
import { createReport, renderHumanReport, renderJsonReport } from '../../report/report.js';
import { reserveExclusiveOutput, type ExclusiveOutput } from '../exclusive-output.js';
import type { CliIo } from '../run.js';

const MAX_OUTPUT_PATH_LENGTH = 4_096;

export const RUN_HELP_TEXT = `Usage:
  halfack run <scenario.yml> [--format human|json] [--output <path>]

Options:
  --format <format>    Report format: human (default) or json
  --output <path>      Create a new report file instead of writing to stdout
`;

export interface RunScenarioOptions {
  readonly signal?: AbortSignal;
}

export type RunScenario = (
  scenario: Scenario,
  options?: RunScenarioOptions,
) => Promise<ExperimentSuiteResult>;

export interface RunCommandDependencies {
  readonly now: () => Date;
  readonly runScenario: RunScenario;
}

export interface RunCommandOptions {
  readonly dependencies?: Partial<RunCommandDependencies>;
  readonly signal?: AbortSignal;
}

interface ParsedRunArguments {
  readonly format: 'human' | 'json';
  readonly outputPath?: string;
  readonly scenarioPath: string;
}

const DEFAULT_DEPENDENCIES: RunCommandDependencies = Object.freeze({
  now: () => new Date(),
  runScenario: (scenario: Scenario, options: RunScenarioOptions = {}) =>
    runScenarioExperiments(
      scenario,
      createDefaultExperimentRunnerDependencies(),
      options.signal === undefined ? {} : { signal: options.signal },
    ),
});

export async function runCommand(
  arguments_: readonly string[],
  io: CliIo,
  options: RunCommandOptions = {},
): Promise<ExitCode> {
  if (arguments_.length === 1 && (arguments_[0] === '--help' || arguments_[0] === '-h')) {
    io.writeOutput(RUN_HELP_TEXT);
    return ExitCode.Success;
  }

  const parsed = parseRunArguments(arguments_);
  const dependencies: RunCommandDependencies = {
    now: options.dependencies?.now ?? DEFAULT_DEPENDENCIES.now,
    runScenario: options.dependencies?.runScenario ?? DEFAULT_DEPENDENCIES.runScenario,
  };
  let output: ExclusiveOutput | undefined;
  if (parsed.outputPath !== undefined) {
    output = await reserveExclusiveOutput(parsed.outputPath);
  }

  try {
    const loaded = await loadScenario(parsed.scenarioPath);
    const suite = await dependencies.runScenario(
      loaded.scenario,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    const report = createReport(suite, dependencies.now());
    const rendered =
      parsed.format === 'json' ? renderJsonReport(report) : renderHumanReport(report);

    if (output === undefined) {
      io.writeOutput(rendered);
    } else {
      await output.commit(rendered);
    }

    if (options.signal?.aborted === true) {
      return ExitCode.Interrupted;
    }
    switch (suite.status) {
      case 'pass':
        return ExitCode.Success;
      case 'violation':
        return ExitCode.ContractViolation;
      case 'inconclusive':
        return ExitCode.Target;
    }
    throw new Error('The experiment suite returned an unsupported status.');
  } finally {
    await output?.discard();
  }
}

function parseRunArguments(arguments_: readonly string[]): ParsedRunArguments {
  let format: 'human' | 'json' = 'human';
  let formatSeen = false;
  let outputPath: string | undefined;
  let outputSeen = false;
  let optionsEnabled = true;
  const positional: string[] = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) {
      continue;
    }
    if (optionsEnabled && argument === '--') {
      optionsEnabled = false;
      continue;
    }
    if (optionsEnabled && (argument === '--format' || argument.startsWith('--format='))) {
      if (formatSeen) {
        throw new UsageError("Command 'run' accepts the format option only once.");
      }
      const value =
        argument === '--format'
          ? readOptionValue(arguments_, ++index, 'format')
          : argument.slice(9);
      if (value !== 'human' && value !== 'json') {
        throw new UsageError("Command 'run' format must be 'human' or 'json'.");
      }
      format = value;
      formatSeen = true;
      continue;
    }
    if (optionsEnabled && (argument === '--output' || argument.startsWith('--output='))) {
      if (outputSeen) {
        throw new UsageError("Command 'run' accepts the output option only once.");
      }
      const value =
        argument === '--output'
          ? readOptionValue(arguments_, ++index, 'output')
          : argument.slice(9);
      validateOutputPath(value);
      outputPath = value;
      outputSeen = true;
      continue;
    }
    if (optionsEnabled && argument.startsWith('-')) {
      throw new UsageError(`Command 'run' received an unknown option.`);
    }
    positional.push(argument);
  }

  if (positional.length === 0) {
    throw new UsageError("Command 'run' requires a scenario path.");
  }
  if (positional.length !== 1) {
    throw new UsageError("Command 'run' requires exactly one scenario path.");
  }
  const scenarioPath = positional[0];
  if (scenarioPath === undefined) {
    throw new UsageError("Command 'run' requires a scenario path.");
  }
  return {
    format,
    ...(outputPath === undefined ? {} : { outputPath }),
    scenarioPath,
  };
}

function readOptionValue(
  arguments_: readonly string[],
  index: number,
  optionName: 'format' | 'output',
): string {
  const value = arguments_[index];
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`Command 'run' ${optionName} option requires a value.`);
  }
  return value;
}

function validateOutputPath(value: string): void {
  if (value.length === 0 || value.length > MAX_OUTPUT_PATH_LENGTH || value.includes('\0')) {
    throw new UsageError("Command 'run' output path is invalid.");
  }
}
