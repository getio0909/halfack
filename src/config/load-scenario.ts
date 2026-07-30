import { constants } from 'node:fs';
import { access, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { LineCounter, parseDocument, type YAMLParseError } from 'yaml';
import { formatDiagnosticPath } from '../domain/diagnostic.js';
import { ConfigError } from '../domain/errors.js';
import { formatScenarioIssues } from './format-issues.js';
import { scenarioSchema, type Scenario } from './scenario-schema.js';
import { isProcessWrapper } from './security-policy.js';

export const MAX_SCENARIO_BYTES = 256 * 1024;

const MAX_SCENARIO_DEPTH = 32;
const MAX_SCENARIO_NODES = 10_000;
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const NON_BLOCKING_OPEN_FLAG = readNumericConstant('O_NONBLOCK');

export interface LoadedScenario {
  readonly directory: string;
  readonly scenario: Scenario;
  readonly sourcePath: string;
}

type DeepReadonly<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Entry)[]
    ? readonly DeepReadonly<Entry>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export async function loadScenario(filePath: string): Promise<LoadedScenario> {
  const sourcePath = path.resolve(filePath);
  const bytes = await readScenarioBytes(sourcePath);
  const source = decodeScenario(bytes);
  const document = parseScenarioDocument(source);
  const value = convertDocument(document);
  assertSafeValueTree(value);

  const result = scenarioSchema.safeParse(value);
  if (!result.success) {
    throw new ConfigError(formatScenarioIssues(result.error.issues));
  }

  const directory = path.dirname(sourcePath);
  const target = await resolveTargetPaths(directory, result.data.target);
  if (requiresDirectProcess(result.data.experiments) && isProcessWrapper(target.command)) {
    throw new ConfigError(
      'Scenario is invalid: /target/command: Process-boundary experiments require a direct executable, not a process wrapper.',
    );
  }
  const scenario: Scenario = {
    ...result.data,
    target,
  };

  deepFreeze(scenario);
  return Object.freeze({
    directory,
    scenario,
    sourcePath,
  });
}

async function resolveTargetPaths(
  directory: string,
  target: Scenario['target'],
): Promise<Scenario['target']> {
  const resolvedCwd = path.resolve(directory, target.cwd);
  let realDirectory: string;
  let realCwd: string;
  try {
    [realDirectory, realCwd] = await Promise.all([realpath(directory), realpath(resolvedCwd)]);
  } catch (error: unknown) {
    throw new ConfigError(
      'Scenario is invalid: /target/cwd: Working directory must exist and be accessible.',
      { cause: error },
    );
  }

  let cwdStats;
  try {
    cwdStats = await stat(realCwd);
  } catch (error: unknown) {
    throw new ConfigError(
      'Scenario is invalid: /target/cwd: Working directory could not be inspected.',
      { cause: error },
    );
  }
  if (!cwdStats.isDirectory()) {
    throw new ConfigError(
      'Scenario is invalid: /target/cwd: Working directory must identify a directory.',
    );
  }
  if (!isWithinDirectory(realDirectory, realCwd)) {
    throw new ConfigError(
      'Scenario is invalid: /target/cwd: Working directory resolves outside the scenario directory.',
    );
  }

  const commandIsAbsolute =
    path.posix.isAbsolute(target.command) || path.win32.isAbsolute(target.command);
  let resolvedCommand = target.command;
  if (commandIsAbsolute) {
    let commandStats;
    try {
      resolvedCommand = await realpath(target.command);
      commandStats = await stat(resolvedCommand);
    } catch (error: unknown) {
      throw new ConfigError(
        'Scenario is invalid: /target/command: Absolute command must identify an accessible executable file.',
        { cause: error },
      );
    }
    if (!commandStats.isFile()) {
      throw new ConfigError(
        'Scenario is invalid: /target/command: Absolute command must identify a file.',
      );
    }
    if (process.platform !== 'win32') {
      try {
        await access(resolvedCommand, constants.X_OK);
      } catch (error: unknown) {
        throw new ConfigError(
          'Scenario is invalid: /target/command: Absolute command must be executable.',
          { cause: error },
        );
      }
    }
  }

  return {
    ...target,
    command: resolvedCommand,
    cwd: realCwd,
  };
}

function requiresDirectProcess(experiments: Scenario['experiments']): boolean {
  return experiments.some(
    (experiment) =>
      experiment === 'rpc_id_reuse' ||
      experiment === 'restart_after_suppressed_response' ||
      experiment === 'disconnect_after_request_write_accepted',
  );
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function readScenarioBytes(sourcePath: string): Promise<Buffer> {
  let fileHandle;
  try {
    fileHandle = await open(sourcePath, constants.O_RDONLY | NON_BLOCKING_OPEN_FLAG);
    const stats = await fileHandle.stat();
    if (!stats.isFile()) {
      throw new ConfigError('Scenario path must identify a regular file.');
    }
    if (stats.size > MAX_SCENARIO_BYTES) {
      throw scenarioSizeError();
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_SCENARIO_BYTES) {
      const remainingCapacity = MAX_SCENARIO_BYTES + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remainingCapacity));
      const { bytesRead } = await fileHandle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        return Buffer.concat(chunks, totalBytes);
      }

      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
      if (totalBytes > MAX_SCENARIO_BYTES) {
        throw scenarioSizeError();
      }
    }

    throw scenarioSizeError();
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      throw error;
    }
    throw new ConfigError('Could not read the scenario file.', {
      cause: error,
    });
  } finally {
    await fileHandle?.close();
  }
}

function readNumericConstant(name: string): number {
  const value: unknown = Reflect.get(constants, name);
  return typeof value === 'number' ? value : 0;
}

function scenarioSizeError(): ConfigError {
  return new ConfigError('Scenario file exceeds the 256 KiB limit.');
}

function decodeScenario(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error: unknown) {
    throw new ConfigError('Scenario file must contain valid UTF-8.', {
      cause: error,
    });
  }
}

function parseScenarioDocument(source: string) {
  const lineCounter = new LineCounter();
  let document;
  try {
    document = parseDocument(source, {
      lineCounter,
      prettyErrors: false,
      schema: 'core',
      strict: true,
      stringKeys: true,
      uniqueKeys: true,
      version: '1.2',
    });
  } catch (error: unknown) {
    throw new ConfigError('Scenario YAML could not be parsed.', {
      cause: error,
    });
  }

  const parseError = document.errors[0];
  if (parseError !== undefined) {
    throw yamlIssueError('invalid', parseError);
  }

  const warning = document.warnings[0];
  if (warning !== undefined) {
    throw yamlIssueError('unsupported', warning);
  }

  return document;
}

function yamlIssueError(category: 'invalid' | 'unsupported', issue: YAMLParseError): ConfigError {
  const position = issue.linePos?.[0];
  const location =
    position === undefined
      ? ''
      : ` at line ${String(position.line)}, column ${String(position.col)}`;
  const code = issue.code;
  return new ConfigError(`Scenario YAML is ${category}${location} (${code}).`, { cause: issue });
}

function convertDocument(document: ReturnType<typeof parseDocument>): unknown {
  try {
    return document.toJS({
      mapAsMap: false,
      maxAliasCount: 0,
    }) as unknown;
  } catch (error: unknown) {
    const message =
      error instanceof Error && /alias/iu.test(error.message)
        ? 'Scenario YAML aliases are not allowed.'
        : 'Scenario YAML could not be converted safely.';
    throw new ConfigError(message, { cause: error });
  }
}

function assertSafeValueTree(value: unknown): void {
  const state = { nodes: 0 };
  visitSafeValue(value, [], 0, state);
}

function visitSafeValue(
  value: unknown,
  valuePath: readonly (number | string)[],
  depth: number,
  state: { nodes: number },
): void {
  state.nodes += 1;
  if (state.nodes > MAX_SCENARIO_NODES) {
    throw new ConfigError(`Scenario contains more than ${String(MAX_SCENARIO_NODES)} values.`);
  }
  if (depth > MAX_SCENARIO_DEPTH) {
    throw new ConfigError(
      `Scenario exceeds the maximum nesting depth of ${String(MAX_SCENARIO_DEPTH)}.`,
    );
  }

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      visitSafeValue(entry, [...valuePath, index], depth + 1, state);
    }
    return;
  }

  if (value === null || typeof value !== 'object') {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_OBJECT_KEYS.has(key)) {
      throw new ConfigError(
        `Scenario contains forbidden key '${key}' at ${formatDiagnosticPath([...valuePath, key])}.`,
      );
    }
    visitSafeValue(entry, [...valuePath, key], depth + 1, state);
  }
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}
