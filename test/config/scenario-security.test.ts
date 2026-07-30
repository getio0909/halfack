import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadScenario } from '../../src/config/load-scenario.js';
import { createValidScenario, scenarioYaml } from './scenario-fixture.js';

const temporaryDirectories: string[] = [];

async function writeScenario(
  mutate: (scenario: Record<string, unknown>, directory: string) => Promise<void> | void,
): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfack-policy-'));
  temporaryDirectories.push(directory);
  await mkdir(path.join(directory, 'sandbox'));
  const scenario = createValidScenario();
  await mutate(scenario, directory);
  const filePath = path.join(directory, 'scenario.yml');
  await writeFile(filePath, scenarioYaml(scenario));
  return filePath;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe('scenario security policy', () => {
  it.each([
    [
      'non-stdio transport',
      (scenario: Record<string, unknown>) => {
        (scenario['target'] as Record<string, unknown>)['transport'] = 'http';
      },
      /target\/transport/,
    ],
    [
      'composite command strings',
      (scenario: Record<string, unknown>) => {
        (scenario['target'] as Record<string, unknown>)['command'] = 'node server.mjs';
      },
      /target\/command/,
    ],
    [
      'working-directory traversal',
      (scenario: Record<string, unknown>) => {
        (scenario['target'] as Record<string, unknown>)['cwd'] = '../outside';
      },
      /target\/cwd/,
    ],
    [
      'drive-relative working directories',
      (scenario: Record<string, unknown>) => {
        (scenario['target'] as Record<string, unknown>)['cwd'] = 'C:outside';
      },
      /target\/cwd/,
    ],
    [
      'environment injection variables',
      (scenario: Record<string, unknown>) => {
        (scenario['target'] as Record<string, unknown>)['envAllowlist'] = ['PATH', 'NODE_OPTIONS'];
      },
      /NODE_OPTIONS/,
    ],
    [
      'secret-like environment variables',
      (scenario: Record<string, unknown>) => {
        (scenario['target'] as Record<string, unknown>)['envAllowlist'] = ['GITHUB_TOKEN'];
      },
      /GITHUB_TOKEN/,
    ],
    [
      'case-insensitive duplicate environment variables',
      (scenario: Record<string, unknown>) => {
        (scenario['target'] as Record<string, unknown>)['envAllowlist'] = ['Path', 'PATH'];
      },
      /duplicate/i,
    ],
    [
      'a non-disposable target',
      (scenario: Record<string, unknown>) => {
        (scenario['safety'] as Record<string, unknown>)['disposable'] = false;
      },
      /safety\/disposable/,
    ],
    [
      'a target that may leave descendant processes behind',
      (scenario: Record<string, unknown>) => {
        (scenario['safety'] as Record<string, unknown>)['processBoundary'] = 'process-tree';
      },
      /safety\/processBoundary/,
    ],
    [
      'restart experiments with process-local persistence',
      (scenario: Record<string, unknown>) => {
        scenario['persistence'] = 'process';
      },
      /persistence/,
    ],
    [
      'restart experiments launched through a process wrapper',
      (scenario: Record<string, unknown>) => {
        (scenario['target'] as Record<string, unknown>)['command'] = 'pwsh';
      },
      /target\/command/,
    ],
    [
      'disconnect experiments with process-local persistence',
      (scenario: Record<string, unknown>) => {
        scenario['experiments'] = ['disconnect_after_request_write_accepted'];
        scenario['persistence'] = 'process';
      },
      /persistence/,
    ],
    [
      'disconnect experiments launched through a process wrapper',
      (scenario: Record<string, unknown>) => {
        scenario['experiments'] = ['disconnect_after_request_write_accepted'];
        (scenario['target'] as Record<string, unknown>)['command'] = 'pwsh';
      },
      /target\/command/,
    ],
    [
      'RPC-ID reuse experiments with process-local persistence',
      (scenario: Record<string, unknown>) => {
        scenario['experiments'] = ['rpc_id_reuse'];
        scenario['persistence'] = 'process';
      },
      /persistence/,
    ],
    [
      'RPC-ID reuse experiments launched through a process wrapper',
      (scenario: Record<string, unknown>) => {
        scenario['experiments'] = ['rpc_id_reuse'];
        (scenario['target'] as Record<string, unknown>)['command'] = 'pwsh';
      },
      /target\/command/,
    ],
    [
      'invalid probe pointers',
      (scenario: Record<string, unknown>) => {
        (scenario['probe'] as Record<string, unknown>)['pointer'] = '/content/count';
      },
      /probe\/pointer/,
    ],
    [
      'equal oracle baseline and once values',
      (scenario: Record<string, unknown>) => {
        (scenario['oracle'] as Record<string, unknown>)['once'] = 0;
      },
      /oracle/,
    ],
    [
      'fractional oracle values',
      (scenario: Record<string, unknown>) => {
        (scenario['oracle'] as Record<string, unknown>)['once'] = 1.5;
      },
      /oracle\/once/,
    ],
    [
      'unsafe oracle integers',
      (scenario: Record<string, unknown>) => {
        (scenario['oracle'] as Record<string, unknown>)['once'] = Number.MAX_SAFE_INTEGER + 1;
      },
      /oracle\/once/,
    ],
    [
      'negative zero oracle values',
      (scenario: Record<string, unknown>) => {
        (scenario['oracle'] as Record<string, unknown>)['baseline'] = -0;
      },
      /oracle\/baseline/,
    ],
    [
      'cancel experiments without a cancelled effect oracle',
      (scenario: Record<string, unknown>) => {
        scenario['experiments'] = ['cancel_on_progress'];
        delete (scenario['oracle'] as Record<string, unknown>)['cancelledEffect'];
      },
      /oracle\/cancelledEffect/,
    ],
    [
      'settle intervals that cannot sample before timeout',
      (scenario: Record<string, unknown>) => {
        const probe = scenario['probe'] as {
          settle: Record<string, unknown>;
        };
        probe.settle['intervalMs'] = 2_000;
      },
      /probe\/settle\/intervalMs/,
    ],
    [
      'stable sample windows that cannot fit before timeout',
      (scenario: Record<string, unknown>) => {
        const probe = scenario['probe'] as {
          settle: Record<string, unknown>;
        };
        probe.settle['intervalMs'] = 1_000;
        probe.settle['stableSamples'] = 4;
      },
      /probe\/settle\/stableSamples/,
    ],
    [
      'duplicate experiments',
      (scenario: Record<string, unknown>) => {
        scenario['experiments'] = ['suppress_completed_response', 'suppress_completed_response'];
      },
      /experiments/,
    ],
    [
      'a missing reset operation even for disposable targets',
      (scenario: Record<string, unknown>) => {
        delete scenario['reset'];
      },
      /reset/,
    ],
    [
      'unknown placeholders in tool arguments',
      (scenario: Record<string, unknown>) => {
        (
          scenario['exercise'] as {
            arguments: Record<string, unknown>;
          }
        ).arguments['token'] = '${env.API_TOKEN}';
      },
      /placeholder/i,
    ],
    [
      'placeholders outside tool arguments',
      (scenario: Record<string, unknown>) => {
        (scenario['exercise'] as Record<string, unknown>)['tool'] = 'orders.${run.id}';
      },
      /exercise\/tool/,
    ],
  ])('rejects %s', async (_name, mutate, expectedMessage) => {
    const filePath = await writeScenario(mutate);

    await expect(loadScenario(filePath)).rejects.toThrow(expectedMessage);
  });

  it('accepts shell metacharacters and URLs as literal target arguments', async () => {
    const filePath = await writeScenario((scenario) => {
      (scenario['target'] as Record<string, unknown>)['args'] = [
        'https://example.invalid/?a=1&b=2',
        'literal;&|$()',
      ];
    });

    const loaded = await loadScenario(filePath);

    expect(loaded.scenario.target.args).toEqual([
      'https://example.invalid/?a=1&b=2',
      'literal;&|$()',
    ]);
  });

  it('does not echo unsupported placeholder contents', async () => {
    const filePath = await writeScenario((scenario) => {
      (
        scenario['exercise'] as {
          arguments: Record<string, unknown>;
        }
      ).arguments['token'] = '${canary-secret-value}';
    });

    let caught: unknown;
    try {
      await loadScenario(filePath);
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('Unsupported placeholder');
    expect((caught as Error).message).not.toContain('canary-secret-value');
  });

  it.each(['PGPASSWORD', 'GITHUB_PAT', 'DATABASE_URL'])(
    'rejects the common credential variable %s',
    async (environmentName) => {
      const filePath = await writeScenario((scenario) => {
        (scenario['target'] as Record<string, unknown>)['envAllowlist'] = [environmentName];
      });

      await expect(loadScenario(filePath)).rejects.toThrow(environmentName);
    },
  );

  it.each([
    'CLASSPATH',
    'GIT_ASKPASS',
    'GIT_EXTERNAL_DIFF',
    'GIT_SEQUENCE_EDITOR',
    'GIT_SSH',
    'GIT_SSH_COMMAND',
    'LD_AUDIT',
    'PERL5LIB',
    'RUBYLIB',
    'SSH_ASKPASS',
  ])('rejects the execution-altering variable %s', async (environmentName) => {
    const filePath = await writeScenario((scenario) => {
      (scenario['target'] as Record<string, unknown>)['envAllowlist'] = [environmentName];
    });

    await expect(loadScenario(filePath)).rejects.toThrow(environmentName);
  });

  it('accepts only documented low-risk host environment variables', async () => {
    const safeNames = [
      'CI',
      'COLORTERM',
      'FORCE_COLOR',
      'LANG',
      'LC_ALL',
      'LC_CTYPE',
      'NODE_ENV',
      'NO_COLOR',
      'PATH',
      'SystemRoot',
      'TEMP',
      'TERM',
      'TMP',
      'TMPDIR',
      'TZ',
      'WINDIR',
    ];
    const filePath = await writeScenario((scenario) => {
      (scenario['target'] as Record<string, unknown>)['envAllowlist'] = safeNames;
    });

    const loaded = await loadScenario(filePath);

    expect(loaded.scenario.target.envAllowlist).toEqual(safeNames);
  });

  it('rejects an absolute executable path with appended arguments', async () => {
    const filePath = await writeScenario((scenario) => {
      (scenario['target'] as Record<string, unknown>)['command'] = `${process.execPath} --version`;
    });

    await expect(loadScenario(filePath)).rejects.toThrow(/target\/command/);
  });

  it('rejects a working directory that escapes through a filesystem link', async () => {
    const scenarioDirectory = await mkdtemp(path.join(tmpdir(), 'halfack-policy-'));
    const outsideDirectory = await mkdtemp(path.join(tmpdir(), 'halfack-outside-'));
    temporaryDirectories.push(scenarioDirectory, outsideDirectory);
    const linkPath = path.join(scenarioDirectory, 'escape');
    await symlink(outsideDirectory, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    const scenario = createValidScenario();
    (scenario['target'] as Record<string, unknown>)['cwd'] = './escape';
    const filePath = path.join(scenarioDirectory, 'scenario.yml');
    await writeFile(filePath, scenarioYaml(scenario));

    await expect(loadScenario(filePath)).rejects.toThrow(/target\/cwd/);
  });

  it('accepts an absolute executable path containing spaces', async () => {
    const filePath = await writeScenario(async (scenario, directory) => {
      const executablePath = path.join(directory, 'runtime with spaces.exe');
      await writeFile(executablePath, '', { mode: 0o700 });
      (scenario['target'] as Record<string, unknown>)['command'] = executablePath;
    });

    const loaded = await loadScenario(filePath);

    expect(loaded.scenario.target.command).toContain('runtime with spaces.exe');
  });
});
