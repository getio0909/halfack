import type { Writable } from 'node:stream';
import {
  TransportCapacityError,
  TransportClosedError,
  TransportWriteError,
  type TransportError,
} from './errors.js';
import type { TransportWriteReceipt } from './message-transport.js';

interface PendingWrite {
  readonly byteLength: number;
  readonly frame: Buffer;
  readonly reject: (error: TransportError) => void;
  readonly resolve: (receipt: TransportWriteReceipt) => void;
  readonly sequence: number;
}

interface ActiveWrite {
  callbackFinished: boolean;
  drainFinished: boolean;
  drainListener: () => void;
  readonly pending: PendingWrite;
  settled: boolean;
}

export interface SerializedWriterOptions {
  readonly maxFrameBytes: number;
  readonly maxQueuedBytes: number;
  readonly maxQueuedMessages: number;
}

export class SerializedNdjsonWriter {
  readonly #options: SerializedWriterOptions;
  readonly #pending: PendingWrite[] = [];
  readonly #writable: Writable;
  #active: ActiveWrite | undefined;
  #accepting = true;
  #finishPromise: Promise<void> | undefined;
  #finishReject: ((error: TransportError) => void) | undefined;
  #finishResolve: (() => void) | undefined;
  #nextSequence = 1;
  #queuedBytes = 0;
  #terminalError: TransportError | undefined;

  public constructor(writable: Writable, options: SerializedWriterOptions) {
    assertPositiveLimit(options.maxFrameBytes, 'maxFrameBytes');
    assertPositiveLimit(options.maxQueuedBytes, 'maxQueuedBytes');
    assertPositiveLimit(options.maxQueuedMessages, 'maxQueuedMessages');
    this.#writable = writable;
    this.#options = options;
    writable.on('error', this.#handleStreamError);
    writable.on('close', this.#handleStreamClose);
  }

  public send(message: unknown): Promise<TransportWriteReceipt> {
    if (!this.#accepting) {
      return Promise.reject(
        this.#terminalError ?? new TransportClosedError('The target input is closing.'),
      );
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      return Promise.reject(
        new TransportWriteError('Outbound MCP frame must contain a JSON object.'),
      );
    }

    let serialized: unknown;
    try {
      serialized = JSON.stringify(message);
    } catch (error: unknown) {
      return Promise.reject(
        new TransportWriteError('Outbound MCP frame is not JSON serializable.', {
          cause: error,
        }),
      );
    }
    if (typeof serialized !== 'string' || !serialized.startsWith('{')) {
      return Promise.reject(
        new TransportWriteError('Outbound MCP frame must serialize to a JSON object.'),
      );
    }

    const payload = Buffer.from(serialized, 'utf8');
    if (payload.byteLength > this.#options.maxFrameBytes) {
      return Promise.reject(
        new TransportCapacityError(
          `Outbound MCP frame exceeds the ${String(this.#options.maxFrameBytes)} bytes limit.`,
        ),
      );
    }
    const frame = Buffer.concat([payload, Buffer.from('\n')], payload.byteLength + 1);
    if (
      this.#pending.length + (this.#active === undefined ? 0 : 1) + 1 >
        this.#options.maxQueuedMessages ||
      this.#queuedBytes + frame.byteLength > this.#options.maxQueuedBytes
    ) {
      return Promise.reject(
        new TransportCapacityError('Outbound MCP frames exceeded the bounded write queue.'),
      );
    }

    return new Promise<TransportWriteReceipt>((resolve, reject) => {
      const pending: PendingWrite = {
        byteLength: frame.byteLength,
        frame,
        reject,
        resolve,
        sequence: this.#nextSequence,
      };
      this.#nextSequence += 1;
      this.#pending.push(pending);
      this.#queuedBytes += frame.byteLength;
      this.#pump();
    });
  }

  public finish(): Promise<void> {
    if (this.#finishPromise !== undefined) {
      return this.#finishPromise;
    }
    this.#accepting = false;
    if (this.#terminalError !== undefined) {
      this.#finishPromise = Promise.reject(this.#terminalError);
      return this.#finishPromise;
    }
    if (this.#active === undefined && this.#pending.length === 0) {
      this.#finishPromise = Promise.resolve();
      return this.#finishPromise;
    }

    this.#finishPromise = new Promise<void>((resolve, reject) => {
      this.#finishResolve = resolve;
      this.#finishReject = reject;
    });
    return this.#finishPromise;
  }

  public abort(error: TransportError): void {
    this.#fail(error);
  }

  public dispose(): void {
    this.#writable.off('error', this.#handleStreamError);
    this.#writable.off('close', this.#handleStreamClose);
  }

  readonly #handleStreamError = (error: Error): void => {
    this.#fail(
      new TransportWriteError('The target input stream failed during a local write.', {
        cause: error,
      }),
    );
  };

  readonly #handleStreamClose = (): void => {
    if (this.#accepting || this.#active !== undefined || this.#pending.length !== 0) {
      this.#fail(new TransportClosedError('The target input stream closed unexpectedly.'));
    }
  };

  #pump(): void {
    if (this.#active !== undefined || this.#terminalError !== undefined) {
      return;
    }

    const pending = this.#pending.shift();
    if (pending === undefined) {
      this.#resolveFinishIfIdle();
      return;
    }

    const active: ActiveWrite = {
      callbackFinished: false,
      drainFinished: false,
      drainListener: () => {
        active.drainFinished = true;
        this.#completeIfReady(active);
      },
      pending,
      settled: false,
    };
    this.#active = active;
    this.#writable.once('drain', active.drainListener);

    try {
      const acceptedWithoutBackpressure = this.#writable.write(
        pending.frame,
        (error: Error | null | undefined) => {
          if (active.settled) {
            return;
          }
          if (error !== undefined && error !== null) {
            this.#fail(
              new TransportWriteError('The target input stream rejected a local write.', {
                cause: error,
              }),
            );
            return;
          }
          active.callbackFinished = true;
          this.#completeIfReady(active);
        },
      );

      if (acceptedWithoutBackpressure) {
        active.drainFinished = true;
        this.#writable.off('drain', active.drainListener);
        this.#completeIfReady(active);
      }
    } catch (error: unknown) {
      this.#fail(
        new TransportWriteError('The target input stream rejected a local write.', {
          cause: error,
        }),
      );
    }
  }

  #completeIfReady(active: ActiveWrite): void {
    if (
      active.settled ||
      !active.callbackFinished ||
      !active.drainFinished ||
      this.#active !== active
    ) {
      return;
    }

    active.settled = true;
    this.#active = undefined;
    this.#queuedBytes -= active.pending.byteLength;
    active.pending.resolve({
      acceptedByLocalPipe: true,
      byteLength: active.pending.byteLength,
      sequence: active.pending.sequence,
    });
    this.#pump();
  }

  #fail(error: TransportError): void {
    if (this.#terminalError !== undefined) {
      return;
    }
    this.#terminalError = error;
    this.#accepting = false;

    const active = this.#active;
    if (active !== undefined) {
      active.settled = true;
      this.#writable.off('drain', active.drainListener);
      active.pending.reject(error);
      this.#active = undefined;
    }
    for (const pending of this.#pending.splice(0)) {
      pending.reject(error);
    }
    this.#queuedBytes = 0;
    this.#finishReject?.(error);
    this.#finishReject = undefined;
    this.#finishResolve = undefined;
  }

  #resolveFinishIfIdle(): void {
    if (this.#active !== undefined || this.#pending.length !== 0) {
      return;
    }
    this.#finishResolve?.();
    this.#finishResolve = undefined;
    this.#finishReject = undefined;
  }
}

function assertPositiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}
