import { describe, expect, it } from 'vitest';
import { scenarioSchema } from '../../src/config/scenario-schema.js';
import { createValidScenario } from './scenario-fixture.js';

const DELEGATING_LAUNCHERS = [
  'wsl',
  'docker',
  'podman',
  'npm',
  'pnpm',
  'yarn',
  'corepack',
  'uvx',
  'tsx',
] as const;

const launcherCommands = DELEGATING_LAUNCHERS.flatMap((launcher) => {
  const mixedCase = launcher
    .split('')
    .map((character, index) => (index % 2 === 0 ? character.toUpperCase() : character))
    .join('');
  return [
    [launcher, launcher] as const,
    [`${launcher} with case and .exe`, `${mixedCase}.ExE`] as const,
    [`${launcher} through an absolute POSIX path`, `/opt/halfack/bin/${mixedCase}`] as const,
    [`${launcher} through an absolute Windows path`, `C:\\halfack\\bin\\${mixedCase}.CmD`] as const,
  ];
});

describe('process-boundary launcher policy', () => {
  it.each(launcherCommands)('rejects %s', (_label, command) => {
    const scenario = createValidScenario();
    (scenario['target'] as Record<string, unknown>)['command'] = command;

    const result = scenarioSchema.safeParse(scenario);

    expect(result.success).toBe(false);
    if (!result.success) {
      const commandIssue = result.error.issues.find(
        (issue) => issue.path[0] === 'target' && issue.path[1] === 'command',
      );
      expect(commandIssue?.message).toMatch(/direct executable|launcher|process wrapper/iu);
    }
  });
});
