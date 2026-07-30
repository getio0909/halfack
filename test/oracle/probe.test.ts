import { describe, expect, it } from 'vitest';
import type { ToolCallOutcome } from '../../src/mcp/raw-client.js';
import {
  ProbeInvocationError,
  ProbePointerError,
  ProbeValueError,
  createMcpProbeReader,
  matchOracleValue,
  type ToolCaller,
} from '../../src/oracle/probe.js';

function callerReturning(outcome: ToolCallOutcome): ToolCaller {
  return {
    callTool: () => Promise.resolve(outcome),
  };
}

function successWith(structuredContent: unknown): ToolCallOutcome {
  return {
    kind: 'success',
    result: {
      content: [],
      structuredContent,
    },
  };
}

describe('createMcpProbeReader', () => {
  it('reads a finite safe integer and forwards the request budget and signal', async () => {
    const calls: {
      readonly arguments_: Readonly<Record<string, unknown>>;
      readonly name: string;
      readonly signal: AbortSignal | undefined;
      readonly timeoutMs: number | undefined;
    }[] = [];
    const caller: ToolCaller = {
      callTool: (name, arguments_, options) => {
        calls.push({
          arguments_,
          name,
          signal: options.signal,
          timeoutMs: options.timeoutMs,
        });
        return Promise.resolve(successWith({ count: 5 }));
      },
    };
    const invocation = {
      arguments: { scope: 'run-1' },
      tool: 'orders.count',
    };
    const controller = new AbortController();
    const reader = createMcpProbeReader(caller, invocation, '/structuredContent/count');

    await expect(reader.read({ signal: controller.signal, timeoutMs: 321 })).resolves.toBe(5);
    expect(calls).toEqual([
      {
        arguments_: invocation.arguments,
        name: 'orders.count',
        signal: controller.signal,
        timeoutMs: 321,
      },
    ]);
  });

  it.each([
    ['zero', 0],
    ['the positive safe boundary', Number.MAX_SAFE_INTEGER],
    ['the negative safe boundary', Number.MIN_SAFE_INTEGER],
  ])('accepts %s', async (_label, value) => {
    const reader = createMcpProbeReader(
      callerReturning(successWith({ count: value })),
      { arguments: {}, tool: 'probe' },
      '/structuredContent/count',
    );

    await expect(
      reader.read({ signal: new AbortController().signal, timeoutMs: 100 }),
    ).resolves.toBe(value);
  });

  it.each([
    ['a string', '1', 'not_number'],
    ['null', null, 'not_number'],
    ['an object', { value: 1 }, 'not_number'],
    ['NaN', Number.NaN, 'non_finite'],
    ['positive infinity', Number.POSITIVE_INFINITY, 'non_finite'],
    ['a fraction', 1.5, 'fractional'],
    ['an unsafe positive integer', Number.MAX_SAFE_INTEGER + 1, 'unsafe_integer'],
    ['negative zero', -0, 'negative_zero'],
  ] as const)('rejects %s without retaining the value', async (_label, value, reason) => {
    const reader = createMcpProbeReader(
      callerReturning(successWith({ count: value })),
      { arguments: {}, tool: 'probe' },
      '/structuredContent/count',
    );

    const caught = await reader
      .read({ signal: new AbortController().signal, timeoutMs: 100 })
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ProbeValueError);
    expect(caught).toMatchObject({ reason });
    expect(caught).not.toHaveProperty('value');
  });

  it('fails fast on a tool-level error without retaining tool content', async () => {
    const reader = createMcpProbeReader(
      callerReturning({
        kind: 'tool_error',
        result: {
          content: [{ text: 'canary-tool-content', type: 'text' }],
          isError: true,
        },
      }),
      { arguments: {}, tool: 'probe' },
      '/structuredContent/count',
    );

    const caught = await reader
      .read({ signal: new AbortController().signal, timeoutMs: 100 })
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ProbeInvocationError);
    expect(caught).toMatchObject({ reason: 'tool_error' });
    expect((caught as Error).message).not.toContain('canary');
    expect(JSON.stringify(caught)).not.toContain('canary');
  });

  it('normalizes rejected calls without exposing remote diagnostics', async () => {
    const caller: ToolCaller = {
      callTool: () => Promise.reject(new Error('canary-remote-diagnostic')),
    };
    const reader = createMcpProbeReader(
      caller,
      { arguments: { secret: 'canary-argument' }, tool: 'probe' },
      '/structuredContent/count',
    );

    const caught = await reader
      .read({ signal: new AbortController().signal, timeoutMs: 100 })
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ProbeInvocationError);
    expect(caught).toMatchObject({ reason: 'request_failed' });
    expect((caught as Error).message).not.toContain('canary');
    expect(JSON.stringify(caught)).not.toContain('canary');
  });

  it('classifies pointer failures without exposing structured content', async () => {
    const reader = createMcpProbeReader(
      callerReturning(successWith({ visible: 'canary-structured-content' })),
      { arguments: {}, tool: 'probe' },
      '/structuredContent/missing',
    );

    const caught = await reader
      .read({ signal: new AbortController().signal, timeoutMs: 100 })
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(ProbePointerError);
    expect(caught).toMatchObject({ reason: 'missing_member' });
    expect((caught as Error).message).not.toContain('canary');
    expect(JSON.stringify(caught)).not.toContain('canary');
  });

  it('rejects a pointer outside structuredContent before calling the target', () => {
    let calls = 0;
    const caller: ToolCaller = {
      callTool: () => {
        calls += 1;
        return Promise.resolve(successWith({ count: 1 }));
      },
    };

    expect(() =>
      createMcpProbeReader(caller, { arguments: {}, tool: 'probe' }, '/content/count'),
    ).toThrow(ProbePointerError);
    expect(calls).toBe(0);
  });
});

describe('matchOracleValue', () => {
  it('returns every matching role without imposing a global precedence', () => {
    expect(
      matchOracleValue(0, {
        baseline: 0,
        cancelledEffect: 0,
        once: 1,
      }),
    ).toEqual({
      matches: ['baseline', 'cancelled_effect'],
      value: 0,
    });
    expect(
      matchOracleValue(1, {
        baseline: 0,
        cancelledEffect: 1,
        once: 1,
      }),
    ).toEqual({
      matches: ['once', 'cancelled_effect'],
      value: 1,
    });
  });

  it('returns an empty match set for a stable unexpected value', () => {
    expect(
      matchOracleValue(2, {
        baseline: 0,
        once: 1,
      }),
    ).toEqual({
      matches: [],
      value: 2,
    });
  });
});
