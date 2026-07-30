import { TransportClosedError, type TransportError } from '../../src/transport/errors.js';
import type {
  MessageTransport,
  TransportWriteReceipt,
} from '../../src/transport/message-transport.js';

interface Receiver {
  readonly reject: (error: TransportError) => void;
  readonly resolve: (message: Record<string, unknown>) => void;
}

export class FakeMessageTransport implements MessageTransport<void> {
  readonly #incoming: Record<string, unknown>[] = [];
  readonly #receivers: Receiver[] = [];
  readonly #sent: Record<string, unknown>[] = [];
  readonly #sentWaiters: ((message: Record<string, unknown>) => void)[] = [];
  #closeCalls = 0;
  #closePromise: Promise<void> | undefined;
  #closed = false;
  #failure: TransportError | undefined;
  #holdNextSend = false;
  #nextSequence = 1;
  #nextSynchronousSendFailure: TransportError | undefined;

  public send(message: Record<string, unknown>): Promise<TransportWriteReceipt> {
    if (this.#closed || this.#failure !== undefined) {
      return Promise.reject(this.#failure ?? new TransportClosedError());
    }
    if (this.#nextSynchronousSendFailure !== undefined) {
      const error = this.#nextSynchronousSendFailure;
      this.#nextSynchronousSendFailure = undefined;
      throw error;
    }

    const snapshot = structuredClone(message);
    const sentWaiter = this.#sentWaiters.shift();
    if (sentWaiter === undefined) {
      this.#sent.push(snapshot);
    } else {
      sentWaiter(snapshot);
    }
    const byteLength = Buffer.byteLength(JSON.stringify(snapshot)) + 1;
    const receipt: TransportWriteReceipt = {
      acceptedByLocalPipe: true,
      byteLength,
      sequence: this.#nextSequence,
    };
    this.#nextSequence += 1;
    if (this.#holdNextSend) {
      this.#holdNextSend = false;
      return new Promise<TransportWriteReceipt>(() => undefined);
    }
    return Promise.resolve(receipt);
  }

  public receive(): Promise<Record<string, unknown>> {
    const message = this.#incoming.shift();
    if (message !== undefined) {
      return Promise.resolve(message);
    }
    if (this.#closed || this.#failure !== undefined) {
      return Promise.reject(this.#failure ?? new TransportClosedError());
    }

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#receivers.push({ reject, resolve });
    });
  }

  public pushIncoming(message: Record<string, unknown>): void {
    if (this.#closed || this.#failure !== undefined) {
      throw new Error('Fake transport is closed.');
    }
    const snapshot = structuredClone(message);
    const receiver = this.#receivers.shift();
    if (receiver === undefined) {
      this.#incoming.push(snapshot);
    } else {
      receiver.resolve(snapshot);
    }
  }

  public failIncoming(error: TransportError): void {
    if (this.#closed || this.#failure !== undefined) {
      return;
    }
    this.#failure = error;
    for (const receiver of this.#receivers.splice(0)) {
      receiver.reject(error);
    }
  }

  public throwOnNextSend(error: TransportError): void {
    this.#nextSynchronousSendFailure = error;
  }

  public holdNextSend(): void {
    this.#holdNextSend = true;
  }

  public nextSent(): Promise<Record<string, unknown>> {
    const message = this.#sent.shift();
    if (message !== undefined) {
      return Promise.resolve(message);
    }
    return new Promise<Record<string, unknown>>((resolve) => {
      this.#sentWaiters.push(resolve);
    });
  }

  public close(): Promise<void> {
    this.#closeCalls += 1;
    this.#closePromise ??= Promise.resolve().then(() => {
      if (this.#closed) {
        return;
      }
      this.#closed = true;
      const error = new TransportClosedError();
      for (const receiver of this.#receivers.splice(0)) {
        receiver.reject(error);
      }
    });
    return this.#closePromise;
  }

  public get closed(): boolean {
    return this.#closed;
  }

  public get closeCalls(): number {
    return this.#closeCalls;
  }

  public get sentCount(): number {
    return this.#sent.length;
  }
}
