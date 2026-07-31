import { TargetError } from '../domain/errors.js';

const MAX_RETAINED_SAMPLES = 256;

export interface ProbeReadOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface ProbeReader {
  readonly read: (options: ProbeReadOptions) => Promise<number>;
}

export interface MonotonicRuntime {
  readonly now: () => number;
  readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export interface SettleOptions {
  readonly intervalMs: number;
  readonly observeUntilDeadline?: boolean;
  readonly requestTimeoutMs: number;
  readonly signal?: AbortSignal;
  readonly stableSamples: number;
  readonly timeoutMs: number;
}

export interface ProbeSampleEvidence {
  readonly completedOffsetMs: number;
  readonly sequence: number;
  readonly startedOffsetMs: number;
  readonly value: number;
}

export interface ProbeEvidence {
  readonly droppedSamples: number;
  readonly elapsedMs: number;
  readonly lastStreak: number;
  readonly lastValue?: number;
  readonly longestStreak: number;
  readonly samples: readonly ProbeSampleEvidence[];
  readonly totalSamples: number;
  readonly transitions: number;
}

export interface SettledProbe {
  readonly evidence: ProbeEvidence;
  readonly kind: 'stable';
  readonly value: number;
}

export class ProbeSettleTimeoutError extends TargetError {
  public readonly evidence: ProbeEvidence;

  public constructor(evidence: ProbeEvidence) {
    super('The probe did not produce stable evidence within its observation boundary.');
    this.evidence = evidence;
  }
}

export class ProbeAbortedError extends TargetError {
  public constructor() {
    super('The probe settle operation was aborted.');
  }
}

interface MutableEvidence {
  droppedSamples: number;
  lastStreak: number;
  lastValue: number | undefined;
  longestStreak: number;
  samples: ProbeSampleEvidence[];
  totalSamples: number;
  transitions: number;
}

class DeadlineReachedError extends Error {}
class ExternalAbortError extends Error {}

const defaultRuntime: MonotonicRuntime = {
  now: () => performance.now(),
  sleep: async (milliseconds, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new ExternalAbortError());
        return;
      }

      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, milliseconds);
      const onAbort = (): void => {
        clearTimeout(timer);
        cleanup();
        reject(new ExternalAbortError());
      };
      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }),
};

export async function settleProbe(
  reader: ProbeReader,
  options: SettleOptions,
  runtime: MonotonicRuntime = defaultRuntime,
): Promise<SettledProbe> {
  validateOptions(options);
  if (isAborted(options.signal)) {
    throw new ProbeAbortedError();
  }

  let lastObservedTime = readInitialTime(runtime);
  const startedAt = lastObservedTime;
  const deadline = startedAt + options.timeoutMs;
  if (!Number.isFinite(deadline)) {
    throw new RangeError('The settle deadline is outside the supported range.');
  }
  const evidence: MutableEvidence = {
    droppedSamples: 0,
    lastStreak: 0,
    lastValue: undefined,
    longestStreak: 0,
    samples: [],
    totalSamples: 0,
    transitions: 0,
  };
  const now = (): number => {
    const value = runtime.now();
    if (!Number.isFinite(value) || value < lastObservedTime) {
      throw new RangeError('The monotonic runtime returned an invalid time.');
    }
    lastObservedTime = value;
    return value;
  };

  for (;;) {
    const probeStartedAt = now();
    const observesFullWindow = options.observeUntilDeadline === true;
    const isFinalConfirmation = observesFullWindow && probeStartedAt >= deadline;
    if (!observesFullWindow && probeStartedAt >= deadline) {
      throw settleTimeout(evidence, now() - startedAt);
    }

    const requestDeadline = probeStartedAt + options.requestTimeoutMs;
    if (!Number.isFinite(requestDeadline)) {
      throw new RangeError('The probe request deadline is outside the supported range.');
    }
    const effectiveRequestDeadline = isFinalConfirmation
      ? requestDeadline
      : Math.min(requestDeadline, deadline);
    const requestTimeoutMs = Math.max(1, Math.ceil(effectiveRequestDeadline - probeStartedAt));

    let value: number;
    try {
      value = await runBeforeDeadline(
        (signal) => reader.read({ signal, timeoutMs: requestTimeoutMs }),
        effectiveRequestDeadline,
        now,
        options.signal,
      );
    } catch (error: unknown) {
      if (error instanceof ExternalAbortError || isAborted(options.signal)) {
        throw new ProbeAbortedError();
      }
      if (error instanceof DeadlineReachedError) {
        if (observesFullWindow && !isFinalConfirmation) {
          continue;
        }
        throw settleTimeout(evidence, now() - startedAt);
      }
      throw error;
    }
    assertProbeValue(value);

    const completedAt = now();
    if (!observesFullWindow && completedAt >= deadline) {
      throw settleTimeout(evidence, completedAt - startedAt);
    }
    recordSample(evidence, {
      completedOffsetMs: completedAt - startedAt,
      sequence: evidence.totalSamples + 1,
      startedOffsetMs: probeStartedAt - startedAt,
      value,
    });

    if (
      evidence.lastStreak >= options.stableSamples &&
      (!observesFullWindow || isFinalConfirmation)
    ) {
      return Object.freeze({
        evidence: freezeEvidence(evidence, completedAt - startedAt),
        kind: 'stable',
        value,
      });
    }
    if (isFinalConfirmation) {
      throw settleTimeout(evidence, completedAt - startedAt);
    }
    if (observesFullWindow && completedAt >= deadline) {
      continue;
    }

    const remainingObservationMs = deadline - completedAt;
    const sleepMs = Math.min(options.intervalMs, remainingObservationMs);
    try {
      await runBeforeDeadline(
        (signal) => runtime.sleep(sleepMs, signal),
        deadline,
        now,
        options.signal,
      );
    } catch (error: unknown) {
      if (error instanceof ExternalAbortError || isAborted(options.signal)) {
        throw new ProbeAbortedError();
      }
      if (error instanceof DeadlineReachedError && observesFullWindow) {
        continue;
      }
      if (error instanceof DeadlineReachedError) {
        throw settleTimeout(evidence, now() - startedAt);
      }
      throw error;
    }
  }
}

function settleTimeout(evidence: MutableEvidence, elapsedMs: number): ProbeSettleTimeoutError {
  return new ProbeSettleTimeoutError(freezeEvidence(evidence, Math.max(0, elapsedMs)));
}

async function runBeforeDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  deadline: number,
  now: () => number,
  externalSignal: AbortSignal | undefined,
): Promise<T> {
  if (isAborted(externalSignal)) {
    throw new ExternalAbortError();
  }

  const remaining = deadline - now();
  if (remaining <= 0) {
    throw new DeadlineReachedError();
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onExternalAbort: (() => void) | undefined;
  let rejectBoundary: ((error: Error) => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
    timer = setTimeout(() => {
      reject(new DeadlineReachedError());
      controller.abort();
    }, Math.ceil(remaining));
    if (externalSignal !== undefined) {
      onExternalAbort = () => {
        reject(new ExternalAbortError());
        controller.abort();
      };
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  });

  if (isAborted(externalSignal)) {
    rejectBoundary?.(new ExternalAbortError());
    controller.abort();
  }

  const result = Promise.resolve().then(async () => operation(controller.signal));
  try {
    return await Promise.race([result, boundary]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (externalSignal !== undefined && onExternalAbort !== undefined) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

function recordSample(evidence: MutableEvidence, sample: ProbeSampleEvidence): void {
  const previousValue = evidence.lastValue;
  evidence.totalSamples += 1;
  if (previousValue === undefined) {
    evidence.lastStreak = 1;
  } else if (previousValue === sample.value) {
    evidence.lastStreak += 1;
  } else {
    evidence.transitions += 1;
    evidence.lastStreak = 1;
  }
  evidence.lastValue = sample.value;
  evidence.longestStreak = Math.max(evidence.longestStreak, evidence.lastStreak);
  evidence.samples.push(Object.freeze(sample));
  if (evidence.samples.length > MAX_RETAINED_SAMPLES) {
    evidence.samples.shift();
    evidence.droppedSamples += 1;
  }
}

function freezeEvidence(evidence: MutableEvidence, elapsedMs: number): ProbeEvidence {
  return Object.freeze({
    droppedSamples: evidence.droppedSamples,
    elapsedMs,
    lastStreak: evidence.lastStreak,
    ...(evidence.lastValue === undefined ? {} : { lastValue: evidence.lastValue }),
    longestStreak: evidence.longestStreak,
    samples: Object.freeze([...evidence.samples]),
    totalSamples: evidence.totalSamples,
    transitions: evidence.transitions,
  });
}

function assertProbeValue(value: number): void {
  if (!Number.isSafeInteger(value) || !Number.isFinite(value) || Object.is(value, -0)) {
    throw new RangeError('The probe reader returned an invalid value.');
  }
}

function readInitialTime(runtime: MonotonicRuntime): number {
  const value = runtime.now();
  if (!Number.isFinite(value)) {
    throw new RangeError('The monotonic runtime returned an invalid time.');
  }
  return value;
}

function validateOptions(options: SettleOptions): void {
  assertPositiveSafeInteger(options.intervalMs, 'intervalMs');
  assertPositiveSafeInteger(options.requestTimeoutMs, 'requestTimeoutMs');
  assertPositiveSafeInteger(options.stableSamples, 'stableSamples');
  assertPositiveSafeInteger(options.timeoutMs, 'timeoutMs');
  if (
    options.observeUntilDeadline !== undefined &&
    typeof options.observeUntilDeadline !== 'boolean'
  ) {
    throw new RangeError('observeUntilDeadline must be a boolean.');
  }
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
