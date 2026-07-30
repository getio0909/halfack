import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli/run.js';
import { ExitCode } from '../../src/domain/exit-code.js';
import { createValidScenario, scenarioYaml } from '../config/scenario-fixture.js';

const temporaryDirectories: string[] = [];

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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe('halfack validate', () => {
  it('validates without ever spawning the configured command', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'halfack-cli-'));
    temporaryDirectories.push(directory);
    const markerPath = path.join(directory, 'spawned.txt');
    const scriptPath = path.join(directory, 'target.mjs');
    const scenarioPath = path.join(directory, 'scenario.yml');
    await writeFile(
      scriptPath,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(
        markerPath,
      )}, 'spawned');`,
    );
    const scenario = createValidScenario();
    const target = scenario['target'] as Record<string, unknown>;
    target['command'] = process.execPath;
    target['args'] = [scriptPath];
    target['cwd'] = '.';
    await writeFile(scenarioPath, scenarioYaml(scenario));
    const captured = captureIo();

    const exitCode = await runCli(['validate', scenarioPath], captured.io);

    expect({
      exitCode,
      spawned: await fileExists(markerPath),
      stderr: captured.stderr.join(''),
      stdout: captured.stdout.join(''),
    }).toEqual({
      exitCode: ExitCode.Success,
      spawned: false,
      stderr: '',
      stdout: "Valid scenario 'duplicate-order'.\n",
    });
  });

  it.each([
    [[], "Command 'validate' requires exactly one scenario path."],
    [['one.yml', 'two.yml'], "Command 'validate' requires exactly one scenario path."],
  ])('rejects invalid argument counts', async (paths, message) => {
    const captured = captureIo();

    const exitCode = await runCli(['validate', ...paths], captured.io);

    expect({
      exitCode,
      stderr: captured.stderr.join(''),
      stdout: captured.stdout.join(''),
    }).toEqual({
      exitCode: ExitCode.Usage,
      stderr: `HALFACK_USAGE: ${message}\n`,
      stdout: '',
    });
  });

  it('returns a configuration exit code and does not leak invalid values', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'halfack-cli-'));
    temporaryDirectories.push(directory);
    const scenarioPath = path.join(directory, 'scenario.yml');
    const scenario = createValidScenario();
    (scenario['target'] as Record<string, unknown>)['apiToken'] = 'canary-secret-value';
    await writeFile(scenarioPath, scenarioYaml(scenario));
    const captured = captureIo();

    const exitCode = await runCli(['validate', scenarioPath], captured.io);
    const errorOutput = captured.stderr.join('');

    expect(exitCode).toBe(ExitCode.Configuration);
    expect(errorOutput).toContain('HALFACK_CONFIG:');
    expect(errorOutput).not.toContain('canary-secret-value');
    expect(errorOutput).not.toContain(' at ');
    expect(captured.stdout).toEqual([]);
  });
});
