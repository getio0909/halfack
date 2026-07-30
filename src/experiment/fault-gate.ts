import {
  CallToolResultSchema,
  JSONRPCErrorResponseSchema,
  JSONRPCResultResponseSchema,
} from '@modelcontextprotocol/core';
import { TargetError } from '../domain/errors.js';
import type { McpRequestId } from '../mcp/raw-client.js';
import { TransportClosedError } from '../transport/errors.js';
import type { MessageTransport, TransportWriteReceipt } from '../transport/message-transport.js';

export interface DisconnectableMessageTransport<TClose> extends MessageTransport<TClose> {
  disconnect(): Promise<TClose>;
}

export type FaultGateFailureReason =
  | 'already_armed'
  | 'disarmed'
  | 'disconnect_not_applied'
  | 'invalid_request_id'
  | 'transport_terminated'
  | 'write_not_accepted';

export class FaultGateError extends TargetError {
  public constructor(public readonly reason: FaultGateFailureReason) {
    super('The MCP fault gate could not establish the requested fault.');
  }
}

export type ToolResponseKind = 'invalid_response' | 'remote_error' | 'tool_error' | 'tool_success';

export type ToolResponseGateObservation =
  | {
      readonly kind: 'forwarded';
      readonly requestId: McpRequestId;
      readonly responseKind: Exclude<ToolResponseKind, 'tool_success'>;
    }
  | {
      readonly kind: 'suppressed';
      readonly requestId: McpRequestId;
      readonly responseKind: 'tool_success';
    };

export interface ToolResponseGateLease {
  readonly observation: Promise<ToolResponseGateObservation>;
  readonly requestId: McpRequestId;
  disarm(): boolean;
}

export interface DisconnectGateObservation {
  readonly receipt: TransportWriteReceipt;
  readonly requestId: McpRequestId;
  readonly responseIntercepted: boolean;
}

export interface DisconnectGateLease<TClose> {
  readonly closed: Promise<TClose>;
  readonly requestId: McpRequestId;
  readonly triggered: Promise<DisconnectGateObservation>;
  abort(): boolean;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: T) => void;
}

interface SuppressionGate {
  readonly deferred: Deferred<ToolResponseGateObservation>;
  readonly kind: 'suppression';
  readonly requestId: McpRequestId;
  settled: boolean;
}

interface DisconnectGate<TClose> {
  readonly closed: Deferred<TClose>;
  readonly kind: 'disconnect';
  readonly requestId: McpRequestId;
  readonly triggered: Deferred<DisconnectGateObservation>;
  claimed: boolean;
  disconnectConfirmed: boolean;
  disconnectScheduled: boolean;
  receipt: TransportWriteReceipt | undefined;
  responseHandled: boolean;
  responseIntercepted: boolean;
  triggerSettled: boolean;
}

type ActiveGate<TClose> = DisconnectGate<TClose> | SuppressionGate;
type TerminalMode = 'close' | 'disconnect';

export class McpFaultGateTransport<TClose> implements DisconnectableMessageTransport<TClose> {
  readonly #inner: DisconnectableMessageTransport<TClose>;
  readonly #terminalSignal = createDeferred<never>();
  #activeGate: ActiveGate<TClose> | undefined;
  #terminalMode: TerminalMode | undefined;
  #terminalPromise: Promise<TClose> | undefined;

  public constructor(inner: DisconnectableMessageTransport<TClose>) {
    this.#inner = inner;
  }

  public armSuccessfulToolResponse(requestId: McpRequestId): ToolResponseGateLease {
    this.#assertCanArm(requestId);
    const gate: SuppressionGate = {
      deferred: createDeferred<ToolResponseGateObservation>(),
      kind: 'suppression',
      requestId,
      settled: false,
    };
    this.#activeGate = gate;

    return Object.freeze({
      disarm: () => this.#disarmSuppression(gate),
      observation: gate.deferred.promise,
      requestId,
    });
  }

  public armDisconnectAfterWriteAccepted(requestId: McpRequestId): DisconnectGateLease<TClose> {
    this.#assertCanArm(requestId);
    const gate: DisconnectGate<TClose> = {
      claimed: false,
      closed: createDeferred<TClose>(),
      disconnectConfirmed: false,
      disconnectScheduled: false,
      kind: 'disconnect',
      requestId,
      receipt: undefined,
      responseHandled: false,
      responseIntercepted: false,
      triggered: createDeferred<DisconnectGateObservation>(),
      triggerSettled: false,
    };
    this.#activeGate = gate;

    return Object.freeze({
      abort: () => this.#abortDisconnectGate(gate),
      closed: gate.closed.promise,
      requestId,
      triggered: gate.triggered.promise,
    });
  }

  public send(message: Record<string, unknown>): Promise<TransportWriteReceipt> {
    if (this.#terminalPromise !== undefined) {
      return Promise.reject(new TransportClosedError('The fault-gated transport is not writable.'));
    }

    const gate = this.#activeGate;
    const claimsDisconnect =
      gate?.kind === 'disconnect' && !gate.claimed && isToolCallRequestFor(message, gate.requestId);
    if (claimsDisconnect) {
      gate.claimed = true;
    }

    let sent: Promise<TransportWriteReceipt>;
    try {
      sent = this.#inner.send(message);
    } catch (error: unknown) {
      if (claimsDisconnect) {
        this.#rejectDisconnectTrigger(gate);
        void this.#startDisconnect().catch(() => undefined);
      }
      throw error;
    }

    if (!claimsDisconnect) {
      return sent;
    }

    return sent.then(
      (receipt) => {
        const immutableReceipt = freezeReceipt(receipt);
        gate.receipt = immutableReceipt;
        this.#tryResolveDisconnectTrigger(gate);
        if (gate.responseHandled) {
          void this.#startDisconnect().catch(() => undefined);
        } else {
          this.#scheduleDisconnectAfterQueuedResponses(gate);
        }
        return immutableReceipt;
      },
      (error: unknown) => {
        this.#rejectDisconnectTrigger(gate);
        void this.#startDisconnect().catch(() => undefined);
        throw error;
      },
    );
  }

  public async receive(): Promise<Record<string, unknown>> {
    for (;;) {
      if (this.#terminalPromise !== undefined) {
        throw new TransportClosedError('The fault-gated transport is not readable.');
      }

      let message: Record<string, unknown>;
      try {
        message = await Promise.race([this.#inner.receive(), this.#terminalSignal.promise]);
      } catch (error: unknown) {
        this.#handleReceiveFailure();
        throw error;
      }

      const gate = this.#activeGate;
      if (gate === undefined) {
        return message;
      }
      const responseKind = classifyResponse(message, gate.requestId);
      if (responseKind === undefined) {
        return message;
      }

      if (gate.kind === 'suppression') {
        if (responseKind === 'tool_success') {
          this.#settleSuppression(gate, {
            kind: 'suppressed',
            requestId: gate.requestId,
            responseKind,
          });
          continue;
        }
        this.#settleSuppression(gate, {
          kind: 'forwarded',
          requestId: gate.requestId,
          responseKind,
        });
        return message;
      }

      if (!gate.responseHandled) {
        gate.responseHandled = true;
        if (responseKind === 'tool_success') {
          gate.responseIntercepted = true;
          this.#tryResolveDisconnectTrigger(gate);
          if (gate.receipt !== undefined) {
            void this.#startDisconnect().catch(() => undefined);
          }
          continue;
        }
        this.#tryResolveDisconnectTrigger(gate);
        if (gate.receipt !== undefined) {
          void this.#startDisconnect().catch(() => undefined);
        }
      }
      return message;
    }
  }

  public close(): Promise<TClose> {
    if (this.#terminalMode === 'disconnect') {
      const terminal = this.#terminalPromise;
      if (terminal === undefined) {
        return Promise.reject(new FaultGateError('transport_terminated'));
      }
      return terminal;
    }
    if (this.#activeGate?.kind === 'disconnect' && this.#terminalPromise === undefined) {
      return this.#startDisconnect();
    }
    if (this.#terminalPromise !== undefined) {
      return this.#terminalPromise;
    }

    this.#terminalMode = 'close';
    this.#terminalPromise = callTerminalOperation(() => this.#inner.close());
    this.#terminalSignal.reject(
      new TransportClosedError('The fault-gated transport is not readable.'),
    );
    this.#observeTerminal(this.#terminalPromise);
    return this.#terminalPromise;
  }

  public disconnect(): Promise<TClose> {
    if (this.#terminalMode === 'close') {
      return Promise.reject(new FaultGateError('disconnect_not_applied'));
    }
    return this.#startDisconnect();
  }

  #startDisconnect(): Promise<TClose> {
    if (this.#terminalPromise !== undefined) {
      return this.#terminalPromise;
    }

    this.#terminalMode = 'disconnect';
    this.#terminalPromise = callTerminalOperation(() => this.#inner.disconnect());
    this.#terminalSignal.reject(
      new TransportClosedError('The fault-gated transport is not readable.'),
    );
    this.#observeTerminal(this.#terminalPromise);
    return this.#terminalPromise;
  }

  #observeTerminal(terminal: Promise<TClose>): void {
    void terminal.then(
      (value) => {
        this.#settleTerminalGate({ kind: 'success', value });
      },
      (error: unknown) => {
        this.#settleTerminalGate({ error, kind: 'failure' });
      },
    );
  }

  #settleTerminalGate(
    outcome:
      | { readonly kind: 'failure'; readonly error: unknown }
      | { readonly kind: 'success'; readonly value: TClose },
  ): void {
    const gate = this.#activeGate;
    if (gate === undefined) {
      return;
    }
    if (gate.kind === 'suppression') {
      this.#activeGate = undefined;
      if (!gate.settled) {
        gate.settled = true;
        gate.deferred.reject(new FaultGateError('transport_terminated'));
      }
      return;
    }

    gate.responseHandled = true;
    if (outcome.kind === 'success') {
      gate.disconnectConfirmed = true;
      this.#tryResolveDisconnectTrigger(gate);
    } else if (!gate.triggerSettled) {
      gate.triggerSettled = true;
      gate.triggered.reject(new FaultGateError('disconnect_not_applied'));
    }
    this.#activeGate = undefined;
    if (outcome.kind === 'success') {
      gate.closed.resolve(outcome.value);
    } else {
      gate.closed.reject(outcome.error);
    }
  }

  #handleReceiveFailure(): void {
    const gate = this.#activeGate;
    if (gate === undefined) {
      return;
    }
    if (gate.kind === 'suppression') {
      this.#activeGate = undefined;
      if (!gate.settled) {
        gate.settled = true;
        gate.deferred.reject(new FaultGateError('transport_terminated'));
      }
      void this.#startDisconnect().catch(() => undefined);
      return;
    }
    if (this.#terminalMode !== 'disconnect') {
      gate.responseHandled = true;
      if (!gate.triggerSettled) {
        gate.triggerSettled = true;
        gate.triggered.reject(new FaultGateError('disconnect_not_applied'));
      }
      void this.#startDisconnect().catch(() => undefined);
      return;
    }
    gate.responseHandled = true;
    this.#tryResolveDisconnectTrigger(gate);
    void this.#startDisconnect().catch(() => undefined);
  }

  #scheduleDisconnectAfterQueuedResponses(gate: DisconnectGate<TClose>): void {
    if (gate.disconnectScheduled || this.#terminalPromise !== undefined) {
      return;
    }
    gate.disconnectScheduled = true;
    setImmediate(() => {
      gate.disconnectScheduled = false;
      if (this.#activeGate !== gate || this.#terminalPromise !== undefined) {
        return;
      }
      void this.#startDisconnect().catch(() => undefined);
    });
  }

  #tryResolveDisconnectTrigger(gate: DisconnectGate<TClose>): void {
    if (
      gate.triggerSettled ||
      !gate.disconnectConfirmed ||
      !gate.responseHandled ||
      gate.receipt === undefined
    ) {
      return;
    }
    gate.triggerSettled = true;
    gate.triggered.resolve(
      Object.freeze({
        receipt: gate.receipt,
        requestId: gate.requestId,
        responseIntercepted: gate.responseIntercepted,
      }),
    );
  }

  #rejectDisconnectTrigger(gate: DisconnectGate<TClose>): void {
    if (gate.triggerSettled) {
      return;
    }
    gate.triggerSettled = true;
    gate.triggered.reject(new FaultGateError('write_not_accepted'));
  }

  #abortDisconnectGate(gate: DisconnectGate<TClose>): boolean {
    if (this.#activeGate !== gate || this.#terminalPromise !== undefined) {
      return false;
    }
    if (!gate.triggerSettled) {
      gate.triggerSettled = true;
      gate.triggered.reject(new FaultGateError('disarmed'));
    }
    void this.#startDisconnect().catch(() => undefined);
    return true;
  }

  #disarmSuppression(gate: SuppressionGate): boolean {
    if (this.#activeGate !== gate || gate.settled) {
      return false;
    }
    this.#activeGate = undefined;
    gate.settled = true;
    gate.deferred.reject(new FaultGateError('disarmed'));
    return true;
  }

  #settleSuppression(gate: SuppressionGate, observation: ToolResponseGateObservation): void {
    if (this.#activeGate !== gate || gate.settled) {
      return;
    }
    this.#activeGate = undefined;
    gate.settled = true;
    gate.deferred.resolve(Object.freeze(observation));
  }

  #assertCanArm(requestId: McpRequestId): void {
    if (!isRequestId(requestId)) {
      throw new FaultGateError('invalid_request_id');
    }
    if (this.#activeGate !== undefined || this.#terminalPromise !== undefined) {
      throw new FaultGateError('already_armed');
    }
  }
}

function createDeferred<T>(): Deferred<T> {
  let rejectPromise!: (error: unknown) => void;
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });
  void promise.catch(() => undefined);
  return {
    promise,
    reject: rejectPromise,
    resolve: resolvePromise,
  };
}

function classifyResponse(
  message: Record<string, unknown>,
  requestId: McpRequestId,
): ToolResponseKind | undefined {
  if (
    message['id'] !== requestId ||
    (!Object.hasOwn(message, 'result') && !Object.hasOwn(message, 'error'))
  ) {
    return undefined;
  }

  const resultResponse = JSONRPCResultResponseSchema.safeParse(message);
  if (resultResponse.success) {
    const toolResult = CallToolResultSchema.safeParse(resultResponse.data.result);
    if (!toolResult.success) {
      return 'invalid_response';
    }
    return toolResult.data.isError === true ? 'tool_error' : 'tool_success';
  }

  return JSONRPCErrorResponseSchema.safeParse(message).success
    ? 'remote_error'
    : 'invalid_response';
}

function isToolCallRequestFor(message: Record<string, unknown>, requestId: McpRequestId): boolean {
  return (
    message['jsonrpc'] === '2.0' &&
    message['method'] === 'tools/call' &&
    message['id'] === requestId
  );
}

function isRequestId(value: unknown): value is McpRequestId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
}

function callTerminalOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return operation();
  } catch (error: unknown) {
    return Promise.reject(
      error instanceof Error ? error : new Error('The transport termination operation failed.'),
    );
  }
}

function freezeReceipt(receipt: TransportWriteReceipt): TransportWriteReceipt {
  return Object.freeze({
    acceptedByLocalPipe: true,
    byteLength: receipt.byteLength,
    sequence: receipt.sequence,
  });
}
