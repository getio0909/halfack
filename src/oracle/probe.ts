import { TargetError } from '../domain/errors.js';
import type { McpRequestOptions, ToolCallOutcome } from '../mcp/raw-client.js';
import {
  JsonPointerError,
  parseStructuredContentPointer,
  resolveStructuredContentPointer,
  type JsonPointerFailureReason,
} from './json-pointer.js';
import type { ProbeReader } from './settle.js';

export interface ToolCaller {
  readonly callTool: (
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    options: McpRequestOptions,
  ) => Promise<ToolCallOutcome>;
}

export interface ProbeInvocation {
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly tool: string;
}

export type ProbeInvocationFailureReason = 'request_failed' | 'tool_error';
export type ProbeValueFailureReason =
  'fractional' | 'negative_zero' | 'non_finite' | 'not_number' | 'unsafe_integer';

export class ProbeInvocationError extends TargetError {
  public constructor(public readonly reason: ProbeInvocationFailureReason) {
    super('The probe tool call did not produce a usable result.');
  }
}

export class ProbePointerError extends TargetError {
  public constructor(public readonly reason: JsonPointerFailureReason | 'invalid_pointer') {
    super('The probe result did not satisfy its pointer contract.');
  }
}

export class ProbeValueError extends TargetError {
  public constructor(public readonly reason: ProbeValueFailureReason) {
    super('The probe result was not a supported counter value.');
  }
}

export interface OracleValues {
  readonly baseline: number;
  readonly cancelledEffect?: number;
  readonly once: number;
}

export type OracleMatch = 'baseline' | 'cancelled_effect' | 'once';

export interface OracleMatchResult {
  readonly matches: readonly OracleMatch[];
  readonly value: number;
}

export function createMcpProbeReader(
  caller: ToolCaller,
  invocation: ProbeInvocation,
  pointer: string,
): ProbeReader {
  try {
    parseStructuredContentPointer(pointer);
  } catch (error: unknown) {
    if (error instanceof JsonPointerError) {
      throw new ProbePointerError('invalid_pointer');
    }
    throw error;
  }

  const reader: ProbeReader = {
    read: async ({ signal, timeoutMs }) => {
      let outcome: ToolCallOutcome;
      try {
        outcome = await caller.callTool(invocation.tool, invocation.arguments, {
          signal,
          timeoutMs,
        });
      } catch {
        throw new ProbeInvocationError('request_failed');
      }

      if (outcome.kind === 'tool_error') {
        throw new ProbeInvocationError('tool_error');
      }

      let value: unknown;
      try {
        value = resolveStructuredContentPointer(outcome.result, pointer);
      } catch (error: unknown) {
        if (error instanceof JsonPointerError) {
          throw new ProbePointerError(error.reason);
        }
        throw error;
      }
      return parseProbeValue(value);
    },
  };
  return Object.freeze(reader);
}

export function matchOracleValue(value: number, oracle: OracleValues): OracleMatchResult {
  const matches: OracleMatch[] = [];
  if (value === oracle.baseline) {
    matches.push('baseline');
  }
  if (value === oracle.once) {
    matches.push('once');
  }
  if (oracle.cancelledEffect !== undefined && value === oracle.cancelledEffect) {
    matches.push('cancelled_effect');
  }

  return Object.freeze({
    matches: Object.freeze(matches),
    value,
  });
}

function parseProbeValue(value: unknown): number {
  if (typeof value !== 'number') {
    throw new ProbeValueError('not_number');
  }
  if (!Number.isFinite(value)) {
    throw new ProbeValueError('non_finite');
  }
  if (!Number.isInteger(value)) {
    throw new ProbeValueError('fractional');
  }
  if (!Number.isSafeInteger(value)) {
    throw new ProbeValueError('unsafe_integer');
  }
  if (Object.is(value, -0)) {
    throw new ProbeValueError('negative_zero');
  }
  return value;
}
