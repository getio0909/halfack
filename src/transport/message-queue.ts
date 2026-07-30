import { TransportCapacityError, TransportClosedError, type TransportError } from './errors.js';

interface QueueItem {
  readonly byteLength: number;
  readonly message: Record<string, unknown>;
}

interface QueueWaiter {
  readonly reject: (error: TransportError) => void;
  readonly resolve: (message: Record<string, unknown>) => void;
}

export interface MessageQueueLimits {
  readonly maxBytes: number;
  readonly maxMessages: number;
  readonly maxPendingReceives: number;
}

export class BoundedMessageQueue {
  readonly #items: QueueItem[] = [];
  readonly #limits: MessageQueueLimits;
  readonly #waiters: QueueWaiter[] = [];
  #queuedBytes = 0;
  #terminalError: TransportError | undefined;

  public constructor(limits: MessageQueueLimits) {
    assertPositiveLimit(limits.maxBytes, 'maxBytes');
    assertPositiveLimit(limits.maxMessages, 'maxMessages');
    assertPositiveLimit(limits.maxPendingReceives, 'maxPendingReceives');
    this.#limits = limits;
  }

  public push(message: Record<string, unknown>, byteLength: number): void {
    if (this.#terminalError !== undefined) {
      throw this.#terminalError;
    }
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      throw new RangeError('Queued message byteLength must be a non-negative safe integer.');
    }

    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve(message);
      return;
    }

    if (
      this.#items.length + 1 > this.#limits.maxMessages ||
      this.#queuedBytes + byteLength > this.#limits.maxBytes
    ) {
      throw new TransportCapacityError('Target output exceeded the bounded receive queue.');
    }

    this.#items.push({ byteLength, message });
    this.#queuedBytes += byteLength;
  }

  public receive(): Promise<Record<string, unknown>> {
    const item = this.#items.shift();
    if (item !== undefined) {
      this.#queuedBytes -= item.byteLength;
      return Promise.resolve(item.message);
    }
    if (this.#terminalError !== undefined) {
      return Promise.reject(this.#terminalError);
    }
    if (this.#waiters.length >= this.#limits.maxPendingReceives) {
      return Promise.reject(
        new TransportCapacityError('Too many receive calls are waiting for target output.'),
      );
    }

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#waiters.push({ reject, resolve });
    });
  }

  public end(error = new TransportClosedError()): void {
    this.#setTerminal(error, false);
  }

  public fail(error: TransportError): void {
    this.#setTerminal(error, true);
  }

  #setTerminal(error: TransportError, discardQueuedMessages: boolean): void {
    if (this.#terminalError !== undefined) {
      return;
    }
    this.#terminalError = error;

    if (discardQueuedMessages) {
      this.#items.length = 0;
      this.#queuedBytes = 0;
    }

    if (this.#items.length === 0) {
      for (const waiter of this.#waiters.splice(0)) {
        waiter.reject(error);
      }
    }
  }
}

function assertPositiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}
