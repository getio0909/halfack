import { ConfigError } from '../domain/errors.js';

const RUN_ID_PLACEHOLDER = '${run.id}';
const MAX_ARGUMENT_DEPTH = 32;
const MAX_ARGUMENT_NODES = 10_000;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export class ArgumentExpansionError extends ConfigError {
  public constructor() {
    super('Scenario tool arguments could not be expanded safely.');
  }
}

export interface ExpandedInvocation {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly tool: string;
}

export interface ExpandedRun {
  readonly exercise: ExpandedInvocation;
  readonly probe: ExpandedInvocation;
  readonly reset: ExpandedInvocation;
  readonly runId: string;
}

interface InvocationInput {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly tool: string;
}

interface InvocationSet {
  readonly exercise: InvocationInput;
  readonly probe: InvocationInput;
  readonly reset: InvocationInput;
}

interface ExpansionState {
  nodes: number;
  readonly runId: string;
  readonly seen: Set<object>;
}

export function expandRunArguments(
  arguments_: Readonly<Record<string, unknown>>,
  runId: string,
): Readonly<Record<string, unknown>> {
  assertRunId(runId);
  const expanded = expandValue(arguments_, 0, {
    nodes: 0,
    runId,
    seen: new Set<object>(),
  });
  if (expanded === null || typeof expanded !== 'object' || Array.isArray(expanded)) {
    throw new ArgumentExpansionError();
  }
  return expanded as Readonly<Record<string, unknown>>;
}

export function expandRun(scenario: InvocationSet, runId: string): ExpandedRun {
  assertRunId(runId);
  return Object.freeze({
    exercise: expandInvocation(scenario.exercise, runId),
    probe: expandInvocation(scenario.probe, runId),
    reset: expandInvocation(scenario.reset, runId),
    runId,
  });
}

function expandInvocation(
  invocation: {
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly tool: string;
  },
  runId: string,
): ExpandedInvocation {
  return Object.freeze({
    arguments: expandRunArguments(invocation.arguments, runId),
    tool: invocation.tool,
  });
}

function expandValue(value: unknown, depth: number, state: ExpansionState): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_ARGUMENT_NODES || depth > MAX_ARGUMENT_DEPTH) {
    throw new ArgumentExpansionError();
  }

  if (typeof value === 'string') {
    return value.replaceAll(RUN_ID_PLACEHOLDER, state.runId);
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value !== 'object') {
    throw new ArgumentExpansionError();
  }
  if (state.seen.has(value)) {
    throw new ArgumentExpansionError();
  }
  state.seen.add(value);

  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((entry) => expandValue(entry, depth + 1, state)));
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ArgumentExpansionError();
    }

    const expanded: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new ArgumentExpansionError();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new ArgumentExpansionError();
      }
      Object.defineProperty(expanded, key, {
        configurable: false,
        enumerable: true,
        value: expandValue(descriptor.value, depth + 1, state),
        writable: false,
      });
    }
    return Object.freeze(expanded);
  } catch (error: unknown) {
    if (error instanceof ArgumentExpansionError) {
      throw error;
    }
    throw new ArgumentExpansionError();
  } finally {
    state.seen.delete(value);
  }
}

function assertRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId)) {
    throw new ArgumentExpansionError();
  }
}
