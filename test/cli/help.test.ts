import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli/run.js';
import { VERSION } from '../../src/version.js';
import { ExitCode } from '../../src/domain/exit-code.js';

interface CapturedIo {
  readonly io: CliIo;
  readonly stderr: string[];
  readonly stdout: string[];
}

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

describe('runCli', () => {
  it('prints help and succeeds when no arguments are supplied', async () => {
    const captured = captureIo();

    const exitCode = await runCli([], captured.io);

    expect(exitCode).toBe(ExitCode.Success);
    expect(captured.stderr.join('')).toBe('');
    expect(captured.stdout.join('')).toContain('halfack validate <scenario.yml>');
    expect(captured.stdout.join('')).toContain('halfack run <scenario.yml>');
  });

  it('prints the package version to stdout', async () => {
    const captured = captureIo();

    const exitCode = await runCli(['--version'], captured.io);

    expect({
      exitCode,
      stderr: captured.stderr.join(''),
      stdout: captured.stdout.join(''),
    }).toEqual({
      exitCode: ExitCode.Success,
      stderr: '',
      stdout: `${VERSION}\n`,
    });
  });

  it('keeps the exported version synchronized with package.json', async () => {
    const packagePath = path.resolve(import.meta.dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as { version?: unknown };

    expect(VERSION).toBe(packageJson.version);
  });

  it('returns a stable usage error for unknown commands without a stack trace', async () => {
    const captured = captureIo();

    const exitCode = await runCli(['explode'], captured.io);
    const errorOutput = captured.stderr.join('');

    expect({
      exitCode,
      hasStack: errorOutput.includes('at runCli'),
      stderr: errorOutput,
      stdout: captured.stdout.join(''),
    }).toEqual({
      exitCode: ExitCode.Usage,
      hasStack: false,
      stderr: "HALFACK_USAGE: Unknown command 'explode'. Run 'halfack --help' for usage.\n",
      stdout: '',
    });
  });

  it('escapes control characters in unknown command diagnostics', async () => {
    const captured = captureIo();

    const exitCode = await runCli(['\u001b[31mboom'], captured.io);
    const errorOutput = captured.stderr.join('');

    expect(exitCode).toBe(ExitCode.Usage);
    expect(errorOutput).toContain('\\u001b[31mboom');
    expect(errorOutput).not.toContain('\u001b');
    expect(captured.stdout).toEqual([]);
  });

  it('escapes line separators and bidirectional controls in diagnostics', async () => {
    const captured = captureIo();

    await runCli(['before\u0085\u2028\u202eafter'], captured.io);
    const errorOutput = captured.stderr.join('');

    expect(errorOutput).toContain('\\u0085');
    expect(errorOutput).toContain('\\u2028');
    expect(errorOutput).toContain('\\u202e');
    expect(errorOutput).not.toContain('\u0085');
    expect(errorOutput).not.toContain('\u2028');
    expect(errorOutput).not.toContain('\u202e');
  });
});
