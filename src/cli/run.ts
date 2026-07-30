import { ExitCode } from '../domain/exit-code.js';
import { UsageError, normalizeError, renderError } from '../domain/errors.js';
import { escapeDiagnosticText } from '../domain/diagnostic.js';
import { VERSION } from '../version.js';
import { validateCommand } from './commands/validate.js';
import { runCommand, type RunCommandOptions } from './commands/run.js';
import { HELP_TEXT } from './help.js';

export interface CliIo {
  readonly writeError: (value: string) => void;
  readonly writeOutput: (value: string) => void;
}

function unknownCommand(command: string): UsageError {
  const escapedCommand = escapeDiagnosticText(command).replaceAll("'", "\\'");
  return new UsageError(`Unknown command '${escapedCommand}'. Run 'halfack --help' for usage.`);
}

export async function runCli(
  arguments_: readonly string[],
  io: CliIo,
  options: RunCommandOptions = {},
): Promise<ExitCode> {
  try {
    const [command] = arguments_;

    if (command === undefined || command === '--help' || command === '-h') {
      io.writeOutput(HELP_TEXT);
      return ExitCode.Success;
    }

    if (command === '--version' || command === '-V') {
      io.writeOutput(`${VERSION}\n`);
      return ExitCode.Success;
    }

    if (command === 'validate') {
      await validateCommand(arguments_.slice(1), io);
      return ExitCode.Success;
    }

    if (command === 'run') {
      return await runCommand(arguments_.slice(1), io, options);
    }

    throw unknownCommand(command);
  } catch (error: unknown) {
    const normalized = normalizeError(error);
    io.writeError(renderError(normalized));
    return normalized.exitCode;
  }
}
