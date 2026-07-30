import { describe, expect, it } from 'vitest';
import {
  McpInFlightOutcomeUnknownError,
  McpRemoteError,
  McpRequestAbortedError,
  McpTransportError,
} from '../../src/mcp/errors.js';
import { RawMcpClient } from '../../src/mcp/raw-client.js';
import {
  FaultGateError,
  McpFaultGateTransport,
  type DisconnectableMessageTransport,
} from '../../src/experiment/fault-gate.js';
import { TransportClosedError } from '../../src/transport/errors.js';
import type { TransportWriteReceipt } from '../../src/transport/message-transport.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let rejectPromise!: (error: unknown) => void;
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });
  return {
    promise,
    reject: rejectPromise,
    resolve: resolvePromise,
  };
}

interface Receiver {
  readonly reject: (error: Error) => void;
  readonly resolve: (message: Record<string, unknown>) => void;
}

class ControllableTransport implements DisconnectableMessageTransport<string> {
  public readonly sent: Record<string, unknown>[] = [];
  public closeCalls = 0;
  public disconnectCalls = 0;
  public leaveReceiversPending = false;
  public nextReceipt: Deferred<TransportWriteReceipt> | undefined;
  public sendFailure: Error | undefined;
  public sendHook: ((message: Record<string, unknown>) => void) | undefined;
  public terminalFailure: Error | undefined;
  readonly #incoming: Record<string, unknown>[] = [];
  readonly #receivers: Receiver[] = [];
  #closed = false;
  #sequence = 1;
  #terminalPromise: Promise<string> | undefined;

  public send(message: Record<string, unknown>): Promise<TransportWriteReceipt> {
    if (this.#closed) {
      return Promise.reject(this.terminalFailure ?? new TransportClosedError());
    }
    const snapshot = structuredClone(message);
    this.sent.push(snapshot);
    this.sendHook?.(snapshot);
    if (this.sendFailure !== undefined) {
      return Promise.reject(this.sendFailure);
    }
    if (this.nextReceipt !== undefined) {
      const pending = this.nextReceipt;
      this.nextReceipt = undefined;
      return pending.promise;
    }
    const receipt = {
      acceptedByLocalPipe: true,
      byteLength: Buffer.byteLength(JSON.stringify(snapshot)) + 1,
      sequence: this.#sequence,
    } as const;
    this.#sequence += 1;
    return Promise.resolve(receipt);
  }

  public receive(): Promise<Record<string, unknown>> {
    const message = this.#incoming.shift();
    if (message !== undefined) {
      return Promise.resolve(message);
    }
    if (this.#closed) {
      return Promise.reject(this.terminalFailure ?? new TransportClosedError());
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#receivers.push({ reject, resolve });
    });
  }

  public push(message: Record<string, unknown>): void {
    const snapshot = structuredClone(message);
    const receiver = this.#receivers.shift();
    if (receiver === undefined) {
      this.#incoming.push(snapshot);
    } else {
      receiver.resolve(snapshot);
    }
  }

  public close(): Promise<string> {
    this.closeCalls += 1;
    return this.#terminate('closed');
  }

  public disconnect(): Promise<string> {
    this.disconnectCalls += 1;
    return this.#terminate('disconnected');
  }

  #terminate(result: string): Promise<string> {
    this.#terminalPromise ??= Promise.resolve().then(() => {
      this.#closed = true;
      const failure = this.terminalFailure ?? new TransportClosedError();
      if (!this.leaveReceiversPending) {
        for (const receiver of this.#receivers.splice(0)) {
          receiver.reject(failure);
        }
      }
      if (this.terminalFailure !== undefined) {
        throw this.terminalFailure;
      }
      return result;
    });
    return this.#terminalPromise;
  }
}

function successResponse(id: number | string, canary = ''): Record<string, unknown> {
  return {
    id,
    jsonrpc: '2.0',
    result: {
      content: canary === '' ? [] : [{ text: canary, type: 'text' }],
      structuredContent: canary === '' ? { count: 1 } : { canary },
    },
  };
}

function progress(token: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: {
      progress: 1,
      progressToken: token,
    },
  };
}

function createClient(transport: McpFaultGateTransport<string>): RawMcpClient {
  return new RawMcpClient(transport, {
    requestTimeoutMs: 10_000,
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('McpFaultGateTransport response suppression', () => {
  it('passes unrelated messages in order and suppresses only the armed successful response', async () => {
    const inner = new ControllableTransport();
    const transport = new McpFaultGateTransport(inner);
    const lease = transport.armSuccessfulToolResponse('target');
    const first = progress('one');
    const second = successResponse('other');
    const trailing = progress('two');

    inner.push(first);
    inner.push(second);
    inner.push(successResponse('target'));
    inner.push(trailing);

    await expect(transport.receive()).resolves.toEqual(first);
    await expect(transport.receive()).resolves.toEqual(second);
    await expect(transport.receive()).resolves.toEqual(trailing);
    await expect(lease.observation).resolves.toEqual({
      kind: 'suppressed',
      requestId: 'target',
      responseKind: 'tool_success',
    });
  });

  it('compares numeric and string request IDs without coercion', async () => {
    const inner = new ControllableTransport();
    const transport = new McpFaultGateTransport(inner);
    const lease = transport.armSuccessfulToolResponse(1);

    inner.push(successResponse('1'));
    inner.push(successResponse(1));
    inner.push(progress('after'));

    await expect(transport.receive()).resolves.toEqual(successResponse('1'));
    await expect(transport.receive()).resolves.toEqual(progress('after'));
    await expect(lease.observation).resolves.toMatchObject({ kind: 'suppressed' });
  });

  it.each([
    [
      'tool errors',
      {
        id: 'target',
        jsonrpc: '2.0',
        result: {
          content: [{ text: 'canary-tool-error', type: 'text' }],
          isError: true,
        },
      },
      'tool_error',
    ],
    [
      'remote errors',
      {
        error: {
          code: -32_000,
          message: 'canary-remote-error',
        },
        id: 'target',
        jsonrpc: '2.0',
      },
      'remote_error',
    ],
    [
      'invalid tool results',
      {
        id: 'target',
        jsonrpc: '2.0',
        result: {
          content: 'canary-invalid-result',
        },
      },
      'invalid_response',
    ],
  ] as const)('forwards %s and emits only sanitized evidence', async (_label, message, kind) => {
    const inner = new ControllableTransport();
    const transport = new McpFaultGateTransport(inner);
    const lease = transport.armSuccessfulToolResponse('target');

    inner.push(message);

    await expect(transport.receive()).resolves.toEqual(message);
    const observation = await lease.observation;
    expect(observation).toEqual({
      kind: 'forwarded',
      requestId: 'target',
      responseKind: kind,
    });
    expect(JSON.stringify(observation)).not.toContain('canary');
  });

  it('retains no remote payload and exposes the first matching success exactly once', async () => {
    const inner = new ControllableTransport();
    const transport = new McpFaultGateTransport(inner);
    const lease = transport.armSuccessfulToolResponse('target');
    const duplicate = successResponse('target', 'canary-secret-result');

    inner.push(duplicate);
    inner.push(duplicate);
    const receivedDuplicate = transport.receive();

    const observation = await lease.observation;
    expect(JSON.stringify(observation)).not.toContain('canary');
    await expect(receivedDuplicate).resolves.toEqual(duplicate);
  });

  it('rejects overlapping leases and supports idempotent disarm followed by rearm', async () => {
    const inner = new ControllableTransport();
    const transport = new McpFaultGateTransport(inner);
    const first = transport.armSuccessfulToolResponse('first');
    const rejected = first.observation.catch((error: unknown) => error);

    expect(() => transport.armSuccessfulToolResponse('second')).toThrow(
      expect.objectContaining({ reason: 'already_armed' }),
    );
    expect(first.disarm()).toBe(true);
    expect(first.disarm()).toBe(false);
    await expect(rejected).resolves.toMatchObject({ reason: 'disarmed' });

    const second = transport.armSuccessfulToolResponse('second');
    inner.push(successResponse('second'));
    inner.push(progress('after-rearm'));
    const receiving = transport.receive();
    await expect(second.observation).resolves.toMatchObject({
      kind: 'suppressed',
    });
    await expect(receiving).resolves.toEqual(progress('after-rearm'));
  });

  it('integrates with a RawMcpClient whose receive loop was waiting before the gate was armed', async () => {
    const inner = new ControllableTransport();
    const transport = new McpFaultGateTransport(inner);
    const client = createClient(transport);
    const lease = transport.armSuccessfulToolResponse('attempt');
    const handle = client.beginToolCall('orders.create', {}, { requestId: 'attempt' });

    inner.push(successResponse('attempt'));
    await expect(lease.observation).resolves.toMatchObject({ kind: 'suppressed' });
    await handle.cancel();
    await expect(handle.outcome).rejects.toBeInstanceOf(McpRequestAbortedError);

    const next = client.beginToolCall('orders.create', {}, { requestId: 'next' });
    inner.push(successResponse('next'));
    await expect(next.outcome).resolves.toMatchObject({ kind: 'success' });
    await client.close();
  });

  it('settles the suppression lease when the underlying receive fails', async () => {
    const inner = new ControllableTransport();
    const transport = new McpFaultGateTransport(inner);
    const lease = transport.armSuccessfulToolResponse('attempt');
    const receiving = transport.receive();
    inner.terminalFailure = new Error('canary-receive-failure');

    void inner.disconnect().catch(() => undefined);

    await expect(receiving).rejects.toThrow('canary-receive-failure');
    const failure = await lease.observation.catch((error: unknown) => error);
    expect(failure).toMatchObject({ reason: 'transport_terminated' });
    expect(JSON.stringify(failure)).not.toContain('canary');
  });
});

describe('McpFaultGateTransport disconnect-after-write gate', () => {
  it('suppresses a racing response and disconnects before exposing write acceptance', async () => {
    const inner = new ControllableTransport();
    const receipt = deferred<TransportWriteReceipt>();
    inner.nextReceipt = receipt;
    const events: string[] = [];
    inner.sendHook = (message) => {
      events.push('send');
      inner.push(successResponse(message['id'] as string));
      events.push('response');
    };
    const transport = new McpFaultGateTransport(inner);
    const client = createClient(transport);
    events.push('arm');
    const gate = transport.armDisconnectAfterWriteAccepted('attempt');
    events.push('begin');
    const handle = client.beginToolCall('orders.create', {}, { requestId: 'attempt' });
    let outcomeSettled = false;
    void handle.outcome.then(
      () => {
        outcomeSettled = true;
      },
      () => {
        outcomeSettled = true;
      },
    );

    await flushMicrotasks();
    expect(outcomeSettled).toBe(false);
    expect(inner.disconnectCalls).toBe(0);

    events.push('receipt');
    receipt.resolve({
      acceptedByLocalPipe: true,
      byteLength: 42,
      sequence: 7,
    });
    await expect(gate.triggered).resolves.toEqual({
      receipt: {
        acceptedByLocalPipe: true,
        byteLength: 42,
        sequence: 7,
      },
      requestId: 'attempt',
      responseIntercepted: true,
    });
    await expect(gate.closed).resolves.toBe('disconnected');
    await expect(handle.writeAccepted).resolves.toMatchObject({ sequence: 7 });
    await expect(handle.outcome).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof McpTransportError || error instanceof McpInFlightOutcomeUnknownError,
    );
    expect(events).toEqual(['arm', 'begin', 'send', 'response', 'receipt']);
    expect(inner.disconnectCalls).toBe(1);
  });

  it('records interception when write receipt resolves before a same-turn successful response', async () => {
    const inner = new ControllableTransport();
    const receipt = deferred<TransportWriteReceipt>();
    inner.nextReceipt = receipt;
    const transport = new McpFaultGateTransport(inner);
    const client = createClient(transport);
    const gate = transport.armDisconnectAfterWriteAccepted('attempt');
    const handle = client.beginToolCall('orders.create', {}, { requestId: 'attempt' });

    receipt.resolve({
      acceptedByLocalPipe: true,
      byteLength: 42,
      sequence: 7,
    });
    inner.push(successResponse('attempt'));

    await expect(gate.triggered).resolves.toMatchObject({
      requestId: 'attempt',
      responseIntercepted: true,
    });
    await expect(handle.outcome).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof McpTransportError || error instanceof McpInFlightOutcomeUnknownError,
    );
  });

  it('drains a queued progress frame and forwards the matching remote error before disconnecting', async () => {
    const inner = new ControllableTransport();
    const receipt = deferred<TransportWriteReceipt>();
    inner.nextReceipt = receipt;
    const transport = new McpFaultGateTransport(inner);
    const client = createClient(transport);
    const gate = transport.armDisconnectAfterWriteAccepted('attempt');
    const handle = client.beginToolCall('orders.create', {}, { requestId: 'attempt' });
    const remoteError = {
      error: {
        code: -32_000,
        message: 'canary-remote-error',
      },
      id: 'attempt',
      jsonrpc: '2.0',
    };

    inner.push(progress('before-error'));
    inner.push(remoteError);
    receipt.resolve({
      acceptedByLocalPipe: true,
      byteLength: 42,
      sequence: 7,
    });

    await expect(handle.writeAccepted).resolves.toMatchObject({ sequence: 7 });
    await expect(handle.outcome).rejects.toBeInstanceOf(McpRemoteError);
    await expect(gate.triggered).resolves.toMatchObject({
      requestId: 'attempt',
      responseIntercepted: false,
    });
    await expect(gate.closed).resolves.toBe('disconnected');
    expect(client.notificationSnapshot().notifications).toEqual([
      expect.objectContaining({
        method: 'notifications/progress',
        progressToken: 'before-error',
      }),
    ]);
  });

  it('rejects the trigger when receive fails before the scheduled disconnect starts', async () => {
    const inner = new ControllableTransport();
    const receipt = deferred<TransportWriteReceipt>();
    inner.nextReceipt = receipt;
    const transport = new McpFaultGateTransport(inner);
    const gate = transport.armDisconnectAfterWriteAccepted('attempt');
    const sent = transport.send({
      id: 'attempt',
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        arguments: {},
        name: 'orders.create',
      },
    });
    const receiving = transport.receive();

    receipt.resolve({
      acceptedByLocalPipe: true,
      byteLength: 42,
      sequence: 7,
    });
    await expect(sent).resolves.toMatchObject({ sequence: 7 });
    await expect(inner.disconnect()).resolves.toBe('disconnected');

    await expect(receiving).rejects.toBeInstanceOf(TransportClosedError);
    await expect(gate.triggered).rejects.toMatchObject({
      reason: 'disconnect_not_applied',
    });
    await expect(gate.closed).resolves.toBe('disconnected');
  });

  it.each([
    [
      'tool errors',
      {
        id: 'attempt',
        jsonrpc: '2.0',
        result: {
          content: [{ text: 'canary-tool-error', type: 'text' }],
          isError: true,
        },
      },
    ],
    [
      'remote errors',
      {
        error: {
          code: -32_000,
          message: 'canary-remote-error',
        },
        id: 'attempt',
        jsonrpc: '2.0',
      },
    ],
  ] as const)(
    'forwards matching %s instead of disguising them as disconnects',
    async (_label, message) => {
      const inner = new ControllableTransport();
      const receipt = deferred<TransportWriteReceipt>();
      inner.nextReceipt = receipt;
      const transport = new McpFaultGateTransport(inner);
      const gate = transport.armDisconnectAfterWriteAccepted('attempt');
      const sent = transport.send({
        id: 'attempt',
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          arguments: {},
          name: 'orders.create',
        },
      });
      const received = transport.receive();

      inner.push(message);
      await expect(received).resolves.toEqual(message);
      receipt.resolve({
        acceptedByLocalPipe: true,
        byteLength: 42,
        sequence: 7,
      });

      await expect(sent).resolves.toMatchObject({ sequence: 7 });
      await expect(gate.triggered).resolves.toMatchObject({
        responseIntercepted: false,
      });
      await expect(gate.closed).resolves.toBe('disconnected');
    },
  );

  it('disconnects and rejects the trigger when the local write is not accepted', async () => {
    const inner = new ControllableTransport();
    const failure = new Error('canary-write-failure');
    inner.sendFailure = failure;
    const transport = new McpFaultGateTransport(inner);
    const client = createClient(transport);
    const gate = transport.armDisconnectAfterWriteAccepted('attempt');
    const handle = client.beginToolCall('orders.create', {}, { requestId: 'attempt' });

    await expect(gate.triggered).rejects.toMatchObject({
      reason: 'write_not_accepted',
    });
    await expect(gate.closed).resolves.toBe('disconnected');
    await expect(handle.writeAccepted).rejects.toBeInstanceOf(McpTransportError);
    await expect(handle.outcome).rejects.toBeInstanceOf(McpTransportError);
    expect(inner.disconnectCalls).toBe(1);
    expect(JSON.stringify(await gate.triggered.catch((error: unknown) => error))).not.toContain(
      'canary',
    );
  });

  it('keeps the active matcher through a same-turn disconnect race', async () => {
    const inner = new ControllableTransport();
    const transport = new McpFaultGateTransport(inner);
    const lease = transport.armSuccessfulToolResponse('attempt');
    const receiving = transport.receive();

    inner.push(successResponse('attempt'));
    const disconnected = transport.disconnect();
    await flushMicrotasks();

    await expect(lease.observation).resolves.toMatchObject({ kind: 'suppressed' });
    await expect(receiving).rejects.toBeInstanceOf(TransportClosedError);
    await expect(disconnected).resolves.toBe('disconnected');
  });

  it('does not let RawMcpClient.close hide a transport cleanup failure', async () => {
    const inner = new ControllableTransport();
    const closeFailure = new Error('canary-close-failure');
    inner.terminalFailure = closeFailure;
    const transport = new McpFaultGateTransport(inner);
    const client = createClient(transport);

    await expect(client.close()).resolves.toBeUndefined();
    await expect(transport.close()).rejects.toBe(closeFailure);
    await expect(transport.disconnect()).rejects.toMatchObject({
      reason: 'disconnect_not_applied',
    });
    expect(inner.closeCalls).toBe(1);
    expect(inner.disconnectCalls).toBe(0);
  });

  it('wakes a pending receive even when the inner terminal operation leaves it hanging', async () => {
    const inner = new ControllableTransport();
    inner.leaveReceiversPending = true;
    const transport = new McpFaultGateTransport(inner);
    const receiving = transport.receive();

    await expect(transport.close()).resolves.toBe('closed');
    await expect(receiving).rejects.toBeInstanceOf(TransportClosedError);
  });

  it('lets RawMcpClient close after disconnect fails without waking the inner receive', async () => {
    const inner = new ControllableTransport();
    inner.leaveReceiversPending = true;
    inner.terminalFailure = new Error('canary-disconnect-failure');
    const transport = new McpFaultGateTransport(inner);
    const client = createClient(transport);
    const gate = transport.armDisconnectAfterWriteAccepted('attempt');
    const handle = client.beginToolCall('orders.create', {}, { requestId: 'attempt' });

    await expect(gate.triggered).rejects.toMatchObject({
      reason: 'disconnect_not_applied',
    });
    await expect(gate.closed).rejects.toThrow('canary-disconnect-failure');
    await expect(handle.outcome).rejects.toBeInstanceOf(McpTransportError);
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('rejects invalid request IDs before arming any state', () => {
    const transport = new McpFaultGateTransport(new ControllableTransport());

    expect(() => transport.armSuccessfulToolResponse(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      FaultGateError,
    );
    expect(() => transport.armDisconnectAfterWriteAccepted(1.5)).toThrow(FaultGateError);
    expect(() => transport.armSuccessfulToolResponse('valid-after-errors')).not.toThrow();
  });
});
