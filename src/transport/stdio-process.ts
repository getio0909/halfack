import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { TargetError } from '../domain/errors.js';
import { NdjsonDecoder, DEFAULT_MAX_FRAME_BYTES } from './ndjson-decoder.js';
import { NdjsonProtocolError, TransportClosedError, TransportError } from './errors.js';
import { BoundedMessageQueue } from './message-queue.js';
import type { MessageTransport, TransportWriteReceipt } from './message-transport.js';
import { SerializedNdjsonWriter } from './serialized-writer.js';

const DEFAULT_MAX_QUEUED_MESSAGES = 256;
const DEFAULT_MAX_QUEUED_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PENDING_RECEIVES = 256;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_MAX_OUTBOUND_QUEUED_MESSAGES = 128;
const DEFAULT_MAX_OUTBOUND_QUEUED_BYTES = 8 * 1024 * 1024;
const DEFAULT_SPAWN_EVENT_TIMEOUT_MS = 10_000;
const FINAL_STREAM_RELEASE_MS = 100;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_()]*$/u;

export interface StdioTransportLimits {
  readonly maxFrameBytes: number;
  readonly maxOutboundFrameBytes: number;
  readonly maxOutboundQueuedBytes: number;
  readonly maxOutboundQueuedMessages: number;
  readonly maxQueuedBytes: number;
  readonly maxQueuedMessages: number;
  readonly maxPendingReceives: number;
  readonly maxStderrBytes: number;
}

export interface StdioProcessOptions {
  readonly args?: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly envAllowlist?: readonly string[];
  readonly limits?: Partial<StdioTransportLimits>;
  readonly shutdownMs: number;
  readonly signal?: AbortSignal;
  readonly spawnEventTimeoutMs?: number;
}

export interface CapturedStderr {
  readonly text: string;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

export type ProcessTermination = 'disconnect' | 'kill' | 'natural' | 'stdin-eof' | 'terminate';

export interface ProcessCloseSummary {
  readonly closeObserved: boolean;
  readonly code: number | null;
  readonly directProcessTermination: 'confirmed' | 'unconfirmed';
  readonly exitObserved: boolean;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: CapturedStderr;
  readonly stdioDetached: boolean;
  readonly stdoutEnded: boolean;
  readonly termination: ProcessTermination;
}

export class TargetProcessStartError extends TargetError {
  public constructor(
    public readonly directProcessTermination: 'confirmed' | 'not_started' | 'unconfirmed',
  ) {
    super('Unable to start target process.');
  }
}

class SpawnWaitError extends Error {
  public constructor(public readonly reason: 'indeterminate' | 'not_started') {
    super('The target process spawn boundary could not be established.');
  }
}

interface MutableProcessState {
  closeObserved: boolean;
  code: number | null;
  exitObserved: boolean;
  signal: NodeJS.Signals | null;
}

export class StdioProcessTransport implements MessageTransport<ProcessCloseSummary> {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #decoder: NdjsonDecoder;
  readonly #processClosed: Promise<ProcessCloseSummary>;
  readonly #processState: MutableProcessState = {
    closeObserved: false,
    code: null,
    exitObserved: false,
    signal: null,
  };
  readonly #queue: BoundedMessageQueue;
  readonly #shutdownMs: number;
  readonly #stderr: BoundedByteTail;
  readonly #writer: SerializedNdjsonWriter;
  #closePromise: Promise<ProcessCloseSummary> | undefined;
  #failure: TransportError | undefined;
  #processCloseResult: ProcessCloseSummary | undefined;
  #resolveProcessClosed: ((summary: ProcessCloseSummary) => void) | undefined;
  #spawned = false;
  #stdioDetached = false;
  #stdoutEnded = false;
  #stdoutFinalized = false;
  #termination: ProcessTermination = 'natural';

  private constructor(
    child: ChildProcessWithoutNullStreams,
    options: StdioProcessOptions,
    limits: StdioTransportLimits,
  ) {
    this.#child = child;
    this.#shutdownMs = options.shutdownMs;
    this.#decoder = new NdjsonDecoder({ maxFrameBytes: limits.maxFrameBytes });
    this.#queue = new BoundedMessageQueue({
      maxBytes: limits.maxQueuedBytes,
      maxMessages: limits.maxQueuedMessages,
      maxPendingReceives: limits.maxPendingReceives,
    });
    this.#stderr = new BoundedByteTail(limits.maxStderrBytes);
    this.#writer = new SerializedNdjsonWriter(child.stdin, {
      maxFrameBytes: limits.maxOutboundFrameBytes,
      maxQueuedBytes: limits.maxOutboundQueuedBytes,
      maxQueuedMessages: limits.maxOutboundQueuedMessages,
    });
    this.#processClosed = new Promise<ProcessCloseSummary>((resolve) => {
      this.#resolveProcessClosed = resolve;
    });
    this.#attachListeners();
  }

  public static async start(options: StdioProcessOptions): Promise<StdioProcessTransport> {
    validateProcessOptions(options);
    const limits = normalizeLimits(options.limits);
    const environment = buildAllowedEnvironment(
      options.envAllowlist ?? [],
      process.env,
      process.platform,
    );

    if (options.signal?.aborted === true) {
      throw new TargetProcessStartError('not_started');
    }

    const spawnController = new AbortController();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(options.command, [...(options.args ?? [])], {
        cwd: options.cwd,
        env: environment,
        killSignal: 'SIGKILL',
        shell: false,
        signal: spawnController.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      throw new TargetProcessStartError('not_started');
    }

    const transport = new StdioProcessTransport(child, options, limits);
    try {
      await waitForSpawn(
        child,
        options.spawnEventTimeoutMs ?? DEFAULT_SPAWN_EVENT_TIMEOUT_MS,
        options.signal,
      );
      transport.#spawned = true;
      if (transport.#stdoutFinalized && transport.#processCloseResult === undefined) {
        transport.#startCleanup();
      }
      return transport;
    } catch (error: unknown) {
      spawnController.abort();
      const summary = await transport.#abandonStartup();
      if (error instanceof SpawnWaitError && error.reason === 'not_started') {
        throw new TargetProcessStartError('not_started');
      }
      throw new TargetProcessStartError(summary.directProcessTermination);
    }
  }

  public send(message: Record<string, unknown>): Promise<TransportWriteReceipt> {
    if (!this.#spawned || this.#closePromise !== undefined || this.#failure !== undefined) {
      return Promise.reject(
        this.#failure ?? new TransportClosedError('The target transport is not writable.'),
      );
    }
    return this.#writer.send(message);
  }

  public receive(): Promise<Record<string, unknown>> {
    return this.#queue.receive();
  }

  public close(): Promise<ProcessCloseSummary> {
    this.#closePromise ??= this.#closeInternal();
    return this.#closePromise;
  }

  public disconnect(): Promise<ProcessCloseSummary> {
    if (
      this.#closePromise !== undefined ||
      this.#failure !== undefined ||
      this.#processCloseResult !== undefined ||
      this.#processState.exitObserved ||
      this.#stdoutFinalized
    ) {
      throw new TransportClosedError(
        'The target transport had already started terminating before disconnection.',
      );
    }
    const disconnected = this.#abortLocalIo(
      new TransportClosedError('The target transport was intentionally disconnected.'),
    );
    if (!disconnected) {
      throw new TransportClosedError('The target transport could not be disconnected.');
    }
    this.#termination = 'disconnect';
    this.#startCleanup();
    return this.close();
  }

  readonly #handleStdoutData = (chunk: Buffer): void => {
    if (this.#failure !== undefined || this.#stdoutFinalized) {
      return;
    }
    try {
      this.#decoder.pushEach(chunk, (frame) => {
        this.#queue.push(frame.message, frame.byteLength);
      });
    } catch (error: unknown) {
      if (error instanceof TransportError) {
        this.#fail(error);
      } else {
        this.#fail(
          new NdjsonProtocolError('Target stdout failed protocol decoding.', {
            cause: error,
          }),
        );
      }
    }
  };

  readonly #handleStdoutEnd = (): void => {
    this.#stdoutEnded = true;
    this.#finalizeStdout();
  };

  readonly #handleStdoutClose = (): void => {
    this.#finalizeStdout();
  };

  readonly #handleStdoutError = (error: Error): void => {
    this.#fail(
      new TransportError('The target stdout stream failed.', {
        cause: error,
      }),
    );
  };

  readonly #handleStderrData = (chunk: Buffer): void => {
    this.#stderr.append(chunk);
  };

  readonly #handleStderrError = (error: Error): void => {
    this.#fail(
      new TransportError('The target stderr stream failed.', {
        cause: error,
      }),
    );
  };

  readonly #handleChildError = (error: Error): void => {
    if (!this.#spawned) {
      return;
    }
    this.#fail(
      new TransportError('The target process failed after it started.', {
        cause: error,
      }),
    );
  };

  readonly #handleChildExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.#processState.code = code;
    this.#processState.signal = signal;
    this.#processState.exitObserved = true;
  };

  readonly #handleChildClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.#processState.code = code;
    this.#processState.signal = signal;
    this.#processState.closeObserved = true;
    this.#finalizeStdout();
    this.#settleProcessClose();
  };

  #attachListeners(): void {
    this.#child.stdout.on('data', this.#handleStdoutData);
    this.#child.stdout.once('end', this.#handleStdoutEnd);
    this.#child.stdout.once('close', this.#handleStdoutClose);
    this.#child.stdout.once('error', this.#handleStdoutError);
    this.#child.stderr.on('data', this.#handleStderrData);
    this.#child.stderr.once('error', this.#handleStderrError);
    this.#child.on('error', this.#handleChildError);
    this.#child.once('exit', this.#handleChildExit);
    this.#child.once('close', this.#handleChildClose);
  }

  async #closeInternal(): Promise<ProcessCloseSummary> {
    const writerFinished = this.#writer.finish().then(
      () => true,
      () => false,
    );
    const writerDrained = await settleWithin(writerFinished, this.#shutdownMs);
    if (writerDrained === undefined) {
      this.#writer.abort(
        new TransportClosedError('The target input did not drain before shutdown.'),
      );
      this.#child.stdin.destroy();
    }

    if (this.#processCloseResult !== undefined) {
      return this.#processCloseResult;
    }

    if (!this.#processState.exitObserved) {
      if (this.#termination === 'natural') {
        this.#termination = 'stdin-eof';
      }
      if (writerDrained === true && !this.#child.stdin.destroyed) {
        this.#child.stdin.end();
      } else {
        this.#child.stdin.destroy();
      }
    }

    let summary = await settleWithin(this.#processClosed, this.#shutdownMs);
    if (summary !== undefined) {
      return summary;
    }

    if (!this.#processState.exitObserved) {
      if (this.#signalDirectChild('SIGTERM')) {
        this.#termination = 'terminate';
      }
      summary = await settleWithin(this.#processClosed, this.#shutdownMs);
      if (summary !== undefined) {
        return summary;
      }
    }

    if (!this.#processState.exitObserved) {
      if (this.#signalDirectChild('SIGKILL')) {
        this.#termination = 'kill';
      }
      summary = await settleWithin(this.#processClosed, this.#shutdownMs);
      if (summary !== undefined) {
        return summary;
      }
    }

    this.#stdioDetached = true;
    this.#releaseLocalStreams();
    summary = await settleWithin(this.#processClosed, FINAL_STREAM_RELEASE_MS);
    if (summary !== undefined) {
      this.#child.unref();
      return summary;
    }

    this.#finalizeStdout();
    const finalSummary = this.#settleProcessClose();
    this.#child.unref();
    return finalSummary;
  }

  #signalDirectChild(signal: NodeJS.Signals): boolean {
    if (this.#processCloseResult !== undefined) {
      return false;
    }
    try {
      return this.#child.kill(signal);
    } catch (error: unknown) {
      this.#fail(
        new TransportError('Unable to terminate the target process.', {
          cause: error,
        }),
      );
      return false;
    }
  }

  #finalizeStdout(): void {
    if (this.#stdoutFinalized) {
      return;
    }
    this.#stdoutFinalized = true;

    try {
      this.#decoder.finish();
      if (this.#failure === undefined) {
        this.#queue.end();
        this.#startCleanup();
      }
    } catch (error: unknown) {
      if (error instanceof TransportError) {
        this.#fail(error);
      } else {
        this.#fail(
          new NdjsonProtocolError('Target stdout ended in an invalid state.', {
            cause: error,
          }),
        );
      }
    }
  }

  #fail(error: TransportError): void {
    if (!this.#abortLocalIo(error)) {
      return;
    }

    this.#startCleanup();
  }

  #abortLocalIo(error: TransportError): boolean {
    if (this.#failure !== undefined) {
      return false;
    }
    this.#failure = error;
    this.#queue.fail(error);
    this.#writer.abort(error);
    this.#child.stdout.pause();
    this.#child.stdout.destroy();
    this.#child.stdin.destroy();
    return true;
  }

  #releaseLocalStreams(): void {
    this.#child.stdin.destroy();
    this.#child.stdout.destroy();
    this.#child.stderr.destroy();
  }

  async #abandonStartup(): Promise<ProcessCloseSummary> {
    this.#termination = 'kill';
    this.#abortLocalIo(new TransportClosedError('The target process startup was abandoned.'));
    this.#signalDirectChild('SIGKILL');
    let summary = await settleWithin(this.#processClosed, this.#shutdownMs);
    if (summary !== undefined) {
      return summary;
    }
    this.#stdioDetached = true;
    this.#releaseLocalStreams();
    summary = await settleWithin(this.#processClosed, FINAL_STREAM_RELEASE_MS);
    if (summary !== undefined) {
      this.#child.unref();
      return summary;
    }
    const finalSummary = this.#settleProcessClose();
    this.#child.unref();
    return finalSummary;
  }

  #settleProcessClose(): ProcessCloseSummary {
    if (this.#processCloseResult !== undefined) {
      return this.#processCloseResult;
    }
    const directProcessTermination =
      this.#processState.closeObserved && this.#processState.exitObserved && !this.#stdioDetached
        ? 'confirmed'
        : 'unconfirmed';
    const summary: ProcessCloseSummary = {
      closeObserved: this.#processState.closeObserved,
      code: this.#processState.code,
      directProcessTermination,
      exitObserved: this.#processState.exitObserved,
      signal: this.#processState.signal,
      stderr: this.#stderr.snapshot(),
      stdioDetached: this.#stdioDetached,
      stdoutEnded: this.#stdoutEnded,
      termination: this.#termination,
    };
    this.#processCloseResult = summary;
    this.#resolveProcessClosed?.(summary);
    this.#resolveProcessClosed = undefined;
    this.#writer.dispose();
    return summary;
  }

  #startCleanup(): void {
    if (!this.#spawned) {
      return;
    }
    void this.close().catch(() => undefined);
  }
}

export function buildAllowedEnvironment(
  allowlist: readonly string[],
  source: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = {};
  const seen = new Set<string>();
  const sourceEntries = Object.entries(source);

  for (const requestedName of allowlist) {
    if (!ENVIRONMENT_NAME.test(requestedName)) {
      throw new TargetError('Target environment allowlist is invalid.');
    }
    const canonicalName = platform === 'win32' ? requestedName.toUpperCase() : requestedName;
    if (seen.has(canonicalName)) {
      throw new TargetError('Target environment allowlist contains a duplicate name.');
    }
    seen.add(canonicalName);

    const sourceEntry =
      platform === 'win32'
        ? sourceEntries.find(([name]) => name.toUpperCase() === canonicalName)
        : sourceEntries.find(([name]) => name === requestedName);
    const value = sourceEntry?.[1];
    if (value !== undefined) {
      childEnvironment[requestedName] = value;
    }
  }

  return childEnvironment;
}

function validateProcessOptions(options: StdioProcessOptions): void {
  const spawnEventTimeoutMs = options.spawnEventTimeoutMs ?? DEFAULT_SPAWN_EVENT_TIMEOUT_MS;
  if (
    options.command.length === 0 ||
    options.command.includes('\0') ||
    options.cwd.length === 0 ||
    options.cwd.includes('\0') ||
    !Number.isSafeInteger(options.shutdownMs) ||
    options.shutdownMs < 1 ||
    !Number.isSafeInteger(spawnEventTimeoutMs) ||
    spawnEventTimeoutMs < 1
  ) {
    throw new TargetError('Target process options are invalid.');
  }
  for (const argument of options.args ?? []) {
    if (argument.includes('\0')) {
      throw new TargetError('Target process options are invalid.');
    }
  }
}

function normalizeLimits(overrides: Partial<StdioTransportLimits> = {}): StdioTransportLimits {
  const limits: StdioTransportLimits = {
    maxFrameBytes: overrides.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
    maxOutboundFrameBytes: overrides.maxOutboundFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
    maxOutboundQueuedBytes: overrides.maxOutboundQueuedBytes ?? DEFAULT_MAX_OUTBOUND_QUEUED_BYTES,
    maxOutboundQueuedMessages:
      overrides.maxOutboundQueuedMessages ?? DEFAULT_MAX_OUTBOUND_QUEUED_MESSAGES,
    maxQueuedBytes: overrides.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES,
    maxQueuedMessages: overrides.maxQueuedMessages ?? DEFAULT_MAX_QUEUED_MESSAGES,
    maxPendingReceives: overrides.maxPendingReceives ?? DEFAULT_MAX_PENDING_RECEIVES,
    maxStderrBytes: overrides.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
  };

  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TargetError(`Target transport limit ${name} is invalid.`);
    }
  }
  return limits;
}

function waitForSpawn(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const handleSpawn = (): void => {
      settle(() => {
        resolve();
      });
    };
    const handleError = (): void => {
      settle(() => {
        reject(new SpawnWaitError(child.pid === undefined ? 'not_started' : 'indeterminate'));
      });
    };
    const handleAbort = (): void => {
      settle(() => {
        reject(new SpawnWaitError(child.pid === undefined ? 'not_started' : 'indeterminate'));
      });
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off('spawn', handleSpawn);
      child.off('error', handleError);
      signal?.removeEventListener('abort', handleAbort);
    };
    const settle = (complete: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      complete();
    };
    const timer = setTimeout(() => {
      settle(() => {
        reject(new SpawnWaitError('indeterminate'));
      });
    }, timeoutMs);
    child.once('spawn', handleSpawn);
    child.once('error', handleError);
    signal?.addEventListener('abort', handleAbort, { once: true });
    if (signal?.aborted === true) {
      handleAbort();
    }
  });
}

function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    }, timeoutMs);
    void promise.then((value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
    });
  });
}

class BoundedByteTail {
  readonly #buffer: Buffer;
  readonly #maxBytes: number;
  #length = 0;
  #totalBytes = 0;
  #writeOffset = 0;

  public constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
    this.#buffer = Buffer.allocUnsafe(maxBytes);
  }

  public append(chunk: Uint8Array): void {
    this.#totalBytes = Math.min(Number.MAX_SAFE_INTEGER, this.#totalBytes + chunk.byteLength);
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (bytes.byteLength >= this.#maxBytes) {
      bytes.copy(this.#buffer, 0, bytes.byteLength - this.#maxBytes);
      this.#length = this.#maxBytes;
      this.#writeOffset = 0;
      return;
    }

    const firstCopyBytes = Math.min(bytes.byteLength, this.#maxBytes - this.#writeOffset);
    bytes.copy(this.#buffer, this.#writeOffset, 0, firstCopyBytes);
    if (firstCopyBytes < bytes.byteLength) {
      bytes.copy(this.#buffer, 0, firstCopyBytes);
    }
    this.#writeOffset = (this.#writeOffset + bytes.byteLength) % this.#maxBytes;
    this.#length = Math.min(this.#maxBytes, this.#length + bytes.byteLength);
  }

  public snapshot(): CapturedStderr {
    const tail =
      this.#length < this.#maxBytes
        ? this.#buffer.subarray(0, this.#length)
        : Buffer.concat([
            this.#buffer.subarray(this.#writeOffset),
            this.#buffer.subarray(0, this.#writeOffset),
          ]);
    return {
      text: new TextDecoder('utf-8').decode(tail),
      totalBytes: this.#totalBytes,
      truncated: this.#totalBytes > this.#length,
    };
  }
}
