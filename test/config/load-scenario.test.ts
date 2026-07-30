import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadScenario } from '../../src/config/load-scenario.js';
import { ConfigError } from '../../src/domain/errors.js';
import { createValidScenario, scenarioYaml } from './scenario-fixture.js';

const temporaryDirectories: string[] = [];

async function createScenarioFile(
  content: string | Uint8Array = scenarioYaml(),
): Promise<{ readonly directory: string; readonly filePath: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfack-test-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'scenario.yml');
  await writeFile(filePath, content);
  return { directory, filePath };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe('loadScenario', () => {
  it('loads, resolves, defaults, and deeply freezes a valid scenario', async () => {
    const scenario = createValidScenario();
    delete scenario['description'];
    delete scenario['timeouts'];
    const target = scenario['target'] as Record<string, unknown>;
    delete target['args'];
    delete target['envAllowlist'];
    const probe = scenario['probe'] as Record<string, unknown>;
    delete probe['settle'];
    const { directory, filePath } = await createScenarioFile(scenarioYaml(scenario));
    await mkdir(path.join(directory, 'sandbox'));
    const expectedCwd = await realpath(path.join(directory, 'sandbox'));

    const loaded = await loadScenario(filePath);

    expect(loaded).toMatchObject({
      directory: path.resolve(directory),
      scenario: {
        name: 'duplicate-order',
        target: {
          args: [],
          cwd: expectedCwd,
          envAllowlist: [],
        },
        probe: {
          settle: {
            intervalMs: 100,
            stableSamples: 2,
            timeoutMs: 2_000,
          },
        },
        timeouts: {
          requestMs: 3_000,
          shutdownMs: 1_000,
        },
      },
      sourcePath: path.resolve(filePath),
    });
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.scenario)).toBe(true);
    expect(Object.isFrozen(loaded.scenario.exercise.arguments)).toBe(true);
  });

  it.each([
    ['duplicate mapping keys', `${scenarioYaml()}\nname: second-name\n`, /duplicate|unique/i],
    [
      'multiple YAML documents',
      `${scenarioYaml()}\n---\nname: second-document\n`,
      /multiple|document/i,
    ],
    ['YAML aliases', `${scenarioYaml()}\nanchored: &value 1\naliased: *value\n`, /alias/i],
  ])('rejects %s before schema validation', async (_name, source, message) => {
    const { filePath } = await createScenarioFile(source);

    await expect(loadScenario(filePath)).rejects.toThrow(message);
  });

  it('rejects invalid UTF-8 without replacement decoding', async () => {
    const { filePath } = await createScenarioFile(Uint8Array.from([0xc3, 0x28]));

    await expect(loadScenario(filePath)).rejects.toThrow(/UTF-8/i);
  });

  it('rejects scenarios larger than the configured resource limit', async () => {
    const { filePath } = await createScenarioFile(`#${'x'.repeat(256 * 1024)}\n`);

    await expect(loadScenario(filePath)).rejects.toThrow(/256 KiB/i);
  });

  it('rejects input trees beyond the configured nesting limit', async () => {
    const scenario = createValidScenario();
    const arguments_ = (scenario['exercise'] as { arguments: Record<string, unknown> }).arguments;
    let cursor = arguments_;
    for (let depth = 0; depth < 40; depth += 1) {
      const nested: Record<string, unknown> = {};
      cursor['nested'] = nested;
      cursor = nested;
    }
    const { filePath } = await createScenarioFile(scenarioYaml(scenario));

    await expect(loadScenario(filePath)).rejects.toThrow(/nesting depth/i);
  });

  it('rejects forbidden object keys before they reach runtime code', async () => {
    const source = `${scenarioYaml()}"__proto__": poisoned\n`;
    const { filePath } = await createScenarioFile(source);

    await expect(loadScenario(filePath)).rejects.toThrow(/__proto__/);
  });

  it('escapes ancestor keys when reporting a forbidden nested key', async () => {
    const scenario = createValidScenario();
    const nested: Record<string, unknown> = {};
    Object.defineProperty(nested, '__proto__', {
      enumerable: true,
      value: 'poisoned',
    });
    scenario['\u001b[31mparent'] = nested;
    const { filePath } = await createScenarioFile(scenarioYaml(scenario));

    let caught: unknown;
    try {
      await loadScenario(filePath);
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toContain('\\u001b');
    expect((caught as Error).message).not.toContain('\u001b');
  });

  it('uses path-aware schema errors without echoing secret values', async () => {
    const scenario = createValidScenario();
    const target = scenario['target'] as Record<string, unknown>;
    target['apiToken'] = 'canary-secret-value';
    const { filePath } = await createScenarioFile(scenarioYaml(scenario));

    let caught: unknown;
    try {
      await loadScenario(filePath);
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toMatch(/\/target.*apiToken/);
    expect((caught as Error).message).not.toContain('canary-secret-value');
  });

  it('escapes control characters in diagnostic paths', async () => {
    const scenario = createValidScenario();
    const target = scenario['target'] as Record<string, unknown>;
    target['\u001b[31mapiToken'] = 'canary-secret-value';
    const { filePath } = await createScenarioFile(scenarioYaml(scenario));

    let caught: unknown;
    try {
      await loadScenario(filePath);
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toContain('\\u001b');
    expect((caught as Error).message).not.toContain('\u001b');
    expect((caught as Error).message).not.toContain('canary-secret-value');
  });

  it('escapes bidirectional controls in diagnostic paths', async () => {
    const scenario = createValidScenario();
    const target = scenario['target'] as Record<string, unknown>;
    target['\u202eapiToken'] = 'canary-secret-value';
    const { filePath } = await createScenarioFile(scenarioYaml(scenario));

    let caught: unknown;
    try {
      await loadScenario(filePath);
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toContain('\\u202e');
    expect((caught as Error).message).not.toContain('\u202e');
  });

  it('normalizes missing-file failures to a public configuration error', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'halfack-test-'));
    temporaryDirectories.push(directory);

    await expect(loadScenario(path.join(directory, 'missing.yml'))).rejects.toMatchObject({
      publicCode: 'HALFACK_CONFIG',
    });
  });
});
