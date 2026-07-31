import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ProbeAbortedError,
  ProbeSettleTimeoutError,
  settleProbe,
  type MonotonicRuntime,
  type ProbeReader,
  type SettleOptions,
} from '../../src/oracle/settle.js';

class ManualRuntime implements MonotonicRuntime {
  public readonly sleeps: number[] = [];
  #now = 0;

  public advance(milliseconds: number): void {
    this.#now += milliseconds;
  }

  public now(): number {
    return this.#now;
  }

  public sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      return Promise.reject(new Error('manual sleep aborted'));
    }
    this.sleeps.push(milliseconds);
    this.advance(milliseconds);
    return Promise.resolve();
  }
}

interface ScriptedReader {
  readonly budgets: number[];
  readonly reader: ProbeReader;
}

function createScriptedReader(
  runtime: ManualRuntime,
  values: readonly (Error | number)[],
  durations: readonly number[] = [],
): ScriptedReader {
  const budgets: number[] = [];
  let index = 0;
  return {
    budgets,
    reader: {
      read: ({ timeoutMs }) => {
        budgets.push(timeoutMs);
        runtime.advance(durations[index] ?? 0);
        const value = values[index];
        index += 1;
        if (value instanceof Error) {
          return Promise.reject(value);
        }
        if (value === undefined) {
          return Promise.reject(new Error('script exhausted'));
        }
        return Promise.resolve(value);
      },
    },
  };
}

const DEFAULT_OPTIONS: SettleOptions = {
  intervalMs: 10,
  requestTimeoutMs: 80,
  stableSamples: 2,
  timeoutMs: 100,
};

afterEach(() => {
  vi.useRealTimers();
});

describe('settleProbe', () => {
  it('accepts the first safe sample immediately when stableSamples is one', async () => {
    const runtime = new ManualRuntime();
    const { reader } = createScriptedReader(runtime, [7]);

    const result = await settleProbe(reader, { ...DEFAULT_OPTIONS, stableSamples: 1 }, runtime);

    expect(result).toMatchObject({
      kind: 'stable',
      value: 7,
      evidence: {
        droppedSamples: 0,
        elapsedMs: 0,
        lastStreak: 1,
        longestStreak: 1,
        totalSamples: 1,
        transitions: 0,
      },
    });
    expect(result.evidence.samples).toEqual([
      {
        completedOffsetMs: 0,
        sequence: 1,
        startedOffsetMs: 0,
        value: 7,
      },
    ]);
    expect(runtime.sleeps).toEqual([]);
  });

  it('requires consecutive equal values and resets the streak after transitions', async () => {
    const runtime = new ManualRuntime();
    const { reader } = createScriptedReader(runtime, [0, 1, 0, 1, 1]);

    const result = await settleProbe(reader, DEFAULT_OPTIONS, runtime);

    expect(result.value).toBe(1);
    expect(result.evidence).toMatchObject({
      elapsedMs: 40,
      lastStreak: 2,
      longestStreak: 2,
      totalSamples: 5,
      transitions: 3,
    });
    expect(runtime.sleeps).toEqual([10, 10, 10, 10]);
  });

  it('observes the complete deadline after an early stable streak when requested', async () => {
    const runtime = new ManualRuntime();
    const { reader } = createScriptedReader(runtime, [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1]);

    const result = await settleProbe(
      reader,
      {
        ...DEFAULT_OPTIONS,
        observeUntilDeadline: true,
      },
      runtime,
    );

    expect(result.value).toBe(1);
    expect(result.evidence).toMatchObject({
      elapsedMs: 100,
      lastStreak: 3,
      lastValue: 1,
      longestStreak: 8,
      totalSamples: 11,
      transitions: 1,
    });
    expect(result.evidence.samples.at(-1)).toMatchObject({
      completedOffsetMs: 100,
      sequence: 11,
      startedOffsetMs: 100,
      value: 1,
    });
    expect(runtime.sleeps).toEqual(Array.from({ length: 10 }, () => 10));
  });

  it('rejects an early stable value when a late transition leaves the final streak unstable', async () => {
    const runtime = new ManualRuntime();
    const { reader } = createScriptedReader(runtime, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);

    const pending = settleProbe(
      reader,
      {
        ...DEFAULT_OPTIONS,
        observeUntilDeadline: true,
      },
      runtime,
    );

    await expect(pending).rejects.toMatchObject({
      evidence: {
        elapsedMs: 100,
        lastStreak: 1,
        lastValue: 1,
        longestStreak: 10,
        totalSamples: 11,
        transitions: 1,
      },
    });
    await expect(pending).rejects.toBeInstanceOf(ProbeSettleTimeoutError);
  });

  it('settles an unexpected value instead of waiting only for an oracle expectation', async () => {
    const runtime = new ManualRuntime();
    const { reader } = createScriptedReader(runtime, [2, 2]);

    await expect(settleProbe(reader, DEFAULT_OPTIONS, runtime)).resolves.toMatchObject({
      kind: 'stable',
      value: 2,
    });
  });

  it('caps each probe request by the remaining settle deadline', async () => {
    const runtime = new ManualRuntime();
    const { budgets, reader } = createScriptedReader(runtime, [3, 3], [40, 1]);

    await settleProbe(reader, DEFAULT_OPTIONS, runtime);

    expect(budgets).toEqual([80, 50]);
  });

  it('does not accept a sample completed exactly at the half-open deadline', async () => {
    const runtime = new ManualRuntime();
    const { reader } = createScriptedReader(runtime, [1], [100]);

    await expect(
      settleProbe(reader, { ...DEFAULT_OPTIONS, stableSamples: 1 }, runtime),
    ).rejects.toBeInstanceOf(ProbeSettleTimeoutError);
  });

  it('times out and aborts an in-flight probe that ignores its request budget', async () => {
    vi.useFakeTimers();
    let readCalls = 0;
    let sawAbort = false;
    const reader: ProbeReader = {
      read: ({ signal }) => {
        readCalls += 1;
        signal.addEventListener(
          'abort',
          () => {
            sawAbort = true;
          },
          { once: true },
        );
        return new Promise<number>(() => undefined);
      },
    };
    const pending = settleProbe(reader, {
      ...DEFAULT_OPTIONS,
      requestTimeoutMs: 1_000,
    });
    const assertion = expect(pending).rejects.toBeInstanceOf(ProbeSettleTimeoutError);

    await vi.advanceTimersByTimeAsync(100);
    await assertion;

    expect(readCalls).toBe(1);
    expect(sawAbort).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not accept earlier stability when the final observation never completes', async () => {
    vi.useFakeTimers();
    let readCalls = 0;
    const reader: ProbeReader = {
      read: () => {
        readCalls += 1;
        return readCalls <= 2 ? Promise.resolve(1) : new Promise<number>(() => undefined);
      },
    };
    const pending = settleProbe(reader, {
      ...DEFAULT_OPTIONS,
      observeUntilDeadline: true,
    });
    const assertion = expect(pending).rejects.toBeInstanceOf(ProbeSettleTimeoutError);

    await vi.advanceTimersByTimeAsync(DEFAULT_OPTIONS.timeoutMs + DEFAULT_OPTIONS.requestTimeoutMs);
    await assertion;

    expect(readCalls).toBe(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retries a full-window boundary that fires before the monotonic deadline is observable', async () => {
    vi.useFakeTimers();
    let clock = 0;
    let readCalls = 0;
    const runtime: MonotonicRuntime = {
      now: () => clock,
      sleep: () => Promise.reject(new Error('sleep must not be reached')),
    };
    const reader: ProbeReader = {
      read: ({ signal }) => {
        readCalls += 1;
        if (readCalls === 3) {
          return Promise.resolve(1);
        }
        signal.addEventListener(
          'abort',
          () => {
            clock = readCalls === 1 ? 99 : 100;
          },
          { once: true },
        );
        return new Promise<number>(() => undefined);
      },
    };
    const pending = settleProbe(
      reader,
      {
        ...DEFAULT_OPTIONS,
        observeUntilDeadline: true,
        requestTimeoutMs: 1_000,
        stableSamples: 1,
      },
      runtime,
    );

    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toMatchObject({
      kind: 'stable',
      value: 1,
    });
    expect(readCalls).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not let an earlier slow probe justify a later hung observation', async () => {
    vi.useFakeTimers();
    let readCalls = 0;
    const reader: ProbeReader = {
      read: () => {
        readCalls += 1;
        if (readCalls === 1) {
          return new Promise<number>((resolve) => {
            setTimeout(() => resolve(1), 400);
          });
        }
        return readCalls === 2 ? Promise.resolve(1) : new Promise<number>(() => undefined);
      },
    };
    const pending = settleProbe(reader, {
      intervalMs: 100,
      observeUntilDeadline: true,
      requestTimeoutMs: 1_000,
      stableSamples: 2,
      timeoutMs: 1_000,
    });
    const assertion = expect(pending).rejects.toBeInstanceOf(ProbeSettleTimeoutError);

    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;

    expect(readCalls).toBe(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('distinguishes external abort from the internal settle deadline', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reader: ProbeReader = {
      read: () => new Promise<number>(() => undefined),
    };
    const pending = settleProbe(reader, {
      ...DEFAULT_OPTIONS,
      requestTimeoutMs: 1_000,
      signal: controller.signal,
    });
    const assertion = expect(pending).rejects.toBeInstanceOf(ProbeAbortedError);

    controller.abort();
    await assertion;

    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails fast on a probe error without sleeping or issuing another sample', async () => {
    const runtime = new ManualRuntime();
    const expected = new Error('probe failed');
    const { budgets, reader } = createScriptedReader(runtime, [expected, 1]);

    await expect(settleProbe(reader, DEFAULT_OPTIONS, runtime)).rejects.toBe(expected);
    expect(budgets).toEqual([80]);
    expect(runtime.sleeps).toEqual([]);
  });

  it('retains only the newest 256 observations while preserving aggregate evidence', async () => {
    const runtime = new ManualRuntime();
    const values = Array.from({ length: 300 }, (_, index) => index % 2);
    values.push(values.at(-1) ?? 0);
    const { reader } = createScriptedReader(runtime, values);

    const result = await settleProbe(
      reader,
      {
        intervalMs: 10,
        requestTimeoutMs: 100,
        stableSamples: 2,
        timeoutMs: 4_000,
      },
      runtime,
    );

    expect(result.evidence).toMatchObject({
      droppedSamples: 45,
      longestStreak: 2,
      totalSamples: 301,
      transitions: 299,
    });
    expect(result.evidence.samples).toHaveLength(256);
    expect(result.evidence.samples.at(0)?.sequence).toBe(46);
    expect(result.evidence.samples.at(-1)?.sequence).toBe(301);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.evidence)).toBe(true);
    expect(Object.isFrozen(result.evidence.samples)).toBe(true);
  });
});
