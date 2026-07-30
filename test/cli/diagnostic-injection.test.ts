import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli/run.js';
import { ExitCode } from '../../src/domain/exit-code.js';
import { createValidScenario, scenarioYaml } from '../config/scenario-fixture.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe('CLI configuration diagnostics', () => {
  it.each(['run', 'validate'] as const)(
    '%s emits one escaped line for an environment-name injection attempt',
    async (command) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'halfack-diagnostic-injection-'));
      temporaryDirectories.push(directory);
      await mkdir(path.join(directory, 'sandbox'));
      const scenario = createValidScenario();
      const injectedName = 'PATH\u001b[31m\nHALFACK_INTERNAL: forged';
      (scenario['target'] as Record<string, unknown>)['envAllowlist'] = [injectedName];
      const scenarioPath = path.join(directory, 'scenario.yml');
      await writeFile(scenarioPath, scenarioYaml(scenario));
      const captured = captureIo();

      const exitCode = await runCli([command, scenarioPath], captured.io);
      const stderr = captured.stderr.join('');

      expect({
        containsEscapedEscape: stderr.includes('\\u001b'),
        containsEscapedNewline: stderr.includes('\\nHALFACK_INTERNAL: forged'),
        containsRawEscape: stderr.includes('\u001b'),
        exitCode,
        stderrCalls: captured.stderr.length,
        stderrIsOnePhysicalLine: /^HALFACK_CONFIG: [^\r\n]+\n$/u.test(stderr),
        stdout: captured.stdout.join(''),
      }).toEqual({
        containsEscapedEscape: true,
        containsEscapedNewline: true,
        containsRawEscape: false,
        exitCode: ExitCode.Configuration,
        stderrCalls: 1,
        stderrIsOnePhysicalLine: true,
        stdout: '',
      });
    },
  );
});

function captureIo(): {
  readonly io: CliIo;
  readonly stderr: string[];
  readonly stdout: string[];
} {
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
