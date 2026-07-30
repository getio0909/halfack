import { afterEach, describe, expect, it } from 'vitest';
import { MCP_PROTOCOL_VERSION } from '../../src/config/scenario-schema.js';
import {
  McpCapabilityError,
  McpClientClosedError,
  McpInFlightOutcomeUnknownError,
  McpProtocolError,
  McpRemoteError,
  McpRequestAbortedError,
  McpRequestTimeoutError,
  McpTransportError,
} from '../../src/mcp/errors.js';
import { RawMcpClient } from '../../src/mcp/raw-client.js';
import { TransportError } from '../../src/transport/errors.js';
import type {
  MessageTransport,
  TransportWriteReceipt,
} from '../../src/transport/message-transport.js';
import { FakeMessageTransport } from './fake-transport.js';

type RequestId = number | string;

const clients: RawMcpClient[] = [];

function createClient(
  transport = new FakeMessageTransport(),
  overrides: Partial<ConstructorParameters<typeof RawMcpClient>[1]> = {},
): { readonly client: RawMcpClient; readonly transport: FakeMessageTransport } {
  const client = new RawMcpClient(transport, {
    requestTimeoutMs: 1_000,
    ...overrides,
  });
  clients.push(client);
  return { client, transport };
}

function requestId(message: Record<string, unknown>): RequestId {
  const id = message['id'];
  if ((typeof id !== 'number' || !Number.isSafeInteger(id)) && typeof id !== 'string') {
    throw new Error('Expected a JSON-RPC request ID.');
  }
  return id;
}

function requestParams(message: Record<string, unknown>): Record<string, unknown> {
  const params = message['params'];
  if (params === null || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error('Expected JSON-RPC request params.');
  }
  return params as Record<string, unknown>;
}

function pushResult(
  transport: FakeMessageTransport,
  request: Record<string, unknown>,
  result: Record<string, unknown>,
): void {
  transport.pushIncoming({
    id: requestId(request),
    jsonrpc: '2.0',
    result,
  });
}

async function callAndRespond(
  client: RawMcpClient,
  transport: FakeMessageTransport,
  result: Record<string, unknown>,
): Promise<Awaited<ReturnType<RawMcpClient['callTool']>>> {
  const outcome = client.callTool('orders.create', { amount: 1 });
  const request = await transport.nextSent();
  pushResult(transport, request, result);
  return outcome;
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
});

describe('RawMcpClient request envelope', () => {
  it('uses server/discover without an initialize handshake and injects exact per-request metadata', async () => {
    const { client, transport } = createClient();

    const discovered = client.discover();
    const request = await transport.nextSent();

    expect(request).toMatchObject({
      jsonrpc: '2.0',
      method: 'server/discover',
    });
    const meta = requestParams(request)['_meta'];
    expect(meta).toEqual({
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': {
        name: 'halfack',
        version: '0.1.0',
      },
      'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
    });
    expect(JSON.stringify(request)).not.toContain('initialize');

    pushResult(transport, request, {
      capabilities: { tools: {} },
      supportedVersions: [MCP_PROTOCOL_VERSION],
    });
    await expect(discovered).resolves.toMatchObject({
      capabilities: { tools: {} },
    });
  });

  it('uses unique safe-integer IDs for concurrent requests', async () => {
    const { client, transport } = createClient();
    const first = client.callTool('orders.create', {});
    const second = client.callTool('orders.create', {});
    const firstRequest = await transport.nextSent();
    const secondRequest = await transport.nextSent();

    expect(requestId(firstRequest)).not.toBe(requestId(secondRequest));
    expect(Number.isSafeInteger(requestId(firstRequest))).toBe(true);
    expect(Number.isSafeInteger(requestId(secondRequest))).toBe(true);

    pushResult(transport, firstRequest, { content: [] });
    pushResult(transport, secondRequest, { content: [] });
    await Promise.all([first, second]);
  });
});

describe('RawMcpClient discovery and tools', () => {
  it('rejects a server that does not advertise the pinned protocol version', async () => {
    const { client, transport } = createClient();
    const discovered = client.discover();
    const request = await transport.nextSent();

    pushResult(transport, request, {
      capabilities: { tools: {} },
      supportedVersions: ['2025-11-25'],
    });

    await expect(discovered).rejects.toBeInstanceOf(McpCapabilityError);
  });

  it('rejects a server that does not advertise tools capability', async () => {
    const { client, transport } = createClient();
    const discovered = client.discover();
    const request = await transport.nextSent();

    pushResult(transport, request, {
      capabilities: {},
      supportedVersions: [MCP_PROTOCOL_VERSION],
    });

    await expect(discovered).rejects.toBeInstanceOf(McpCapabilityError);
  });

  it('paginates tools/list, preserves metadata, and returns unique tools in order', async () => {
    const { client, transport } = createClient();
    const listed = client.listTools();

    const firstRequest = await transport.nextSent();
    expect(firstRequest['method']).toBe('tools/list');
    expect(requestParams(firstRequest)).toHaveProperty('_meta');
    expect(requestParams(firstRequest)).not.toHaveProperty('cursor');
    pushResult(transport, firstRequest, {
      nextCursor: 'page-2',
      tools: [{ inputSchema: { type: 'object' }, name: 'orders.create' }],
    });

    const secondRequest = await transport.nextSent();
    expect(requestParams(secondRequest)['cursor']).toBe('page-2');
    expect(requestParams(secondRequest)).toHaveProperty('_meta');
    pushResult(transport, secondRequest, {
      tools: [{ inputSchema: { type: 'object' }, name: 'orders.count' }],
    });

    await expect(listed).resolves.toMatchObject([
      { name: 'orders.create' },
      { name: 'orders.count' },
    ]);
  });

  it('fails on a repeated pagination cursor instead of looping forever', async () => {
    const { client, transport } = createClient();
    const listed = client.listTools();
    const firstRequest = await transport.nextSent();
    pushResult(transport, firstRequest, {
      nextCursor: 'repeat',
      tools: [{ inputSchema: { type: 'object' }, name: 'first' }],
    });
    const secondRequest = await transport.nextSent();
    pushResult(transport, secondRequest, {
      nextCursor: 'repeat',
      tools: [{ inputSchema: { type: 'object' }, name: 'second' }],
    });

    await expect(listed).rejects.toBeInstanceOf(McpProtocolError);
  });

  it('fails on duplicate tool names across pages', async () => {
    const { client, transport } = createClient();
    const listed = client.listTools();
    const firstRequest = await transport.nextSent();
    pushResult(transport, firstRequest, {
      nextCursor: 'next',
      tools: [{ inputSchema: { type: 'object' }, name: 'duplicate' }],
    });
    const secondRequest = await transport.nextSent();
    pushResult(transport, secondRequest, {
      tools: [{ inputSchema: { type: 'object' }, name: 'duplicate' }],
    });

    await expect(listed).rejects.toBeInstanceOf(McpProtocolError);
  });

  it('verifies all scenario tool roles and reports missing requirements', async () => {
    const { client, transport } = createClient();
    const verified = client.requireTools(['orders.create', 'test.reset', 'orders.count']);
    const request = await transport.nextSent();
    pushResult(transport, request, {
      tools: [
        { inputSchema: { type: 'object' }, name: 'orders.create' },
        { inputSchema: { type: 'object' }, name: 'orders.count' },
      ],
    });

    await expect(verified).rejects.toBeInstanceOf(McpCapabilityError);
  });
});

describe('RawMcpClient tool calls and correlation', () => {
  it('exposes the request ID and distinguishes local-pipe acceptance from the outcome', async () => {
    const { client, transport } = createClient();
    const handle = client.beginToolCall('orders.create', { amount: 1 });
    const request = await transport.nextSent();

    expect(handle.requestId).toBe(requestId(request));
    await expect(handle.writeAccepted).resolves.toMatchObject({
      acceptedByLocalPipe: true,
      sequence: 1,
    });

    pushResult(transport, request, { content: [] });
    await expect(handle.outcome).resolves.toMatchObject({ kind: 'success' });
  });

  it('rejects explicit request ID reuse throughout one connection epoch', async () => {
    const { client, transport } = createClient();
    const first = client.beginToolCall('orders.create', {}, { requestId: 'attempt-A' });
    const firstRequest = await transport.nextSent();

    expect(requestId(firstRequest)).toBe('attempt-A');
    expect(() => client.beginToolCall('orders.create', {}, { requestId: 'attempt-A' })).toThrow(
      McpProtocolError,
    );

    pushResult(transport, firstRequest, { content: [] });
    await first.outcome;

    expect(() => client.beginToolCall('orders.create', {}, { requestId: 'attempt-A' })).toThrow(
      /connection epoch/u,
    );
  });

  it('rejects explicit reuse of an automatically allocated numeric request ID', async () => {
    const { client, transport } = createClient();
    const first = client.beginToolCall('orders.create', {});
    const firstRequest = await transport.nextSent();
    const allocatedId = requestId(firstRequest);

    pushResult(transport, firstRequest, { content: [] });
    await first.outcome;

    expect(typeof allocatedId).toBe('number');
    expect(() => client.beginToolCall('orders.create', {}, { requestId: allocatedId })).toThrow(
      /connection epoch/u,
    );
  });

  it('adds a caller-selected progress token to tools/call metadata', async () => {
    const { client, transport } = createClient();
    const handle = client.beginToolCall(
      'orders.create',
      {},
      { progressToken: 'progress-attempt-A' },
    );
    const request = await transport.nextSent();

    expect(requestParams(request)['_meta']).toMatchObject({
      progressToken: 'progress-attempt-A',
    });

    pushResult(transport, request, { content: [] });
    await handle.outcome;
  });

  it('classifies successful and tool-level error results separately', async () => {
    const { client, transport } = createClient();

    await expect(
      callAndRespond(client, transport, {
        content: [{ text: 'created', type: 'text' }],
        structuredContent: { count: 1 },
      }),
    ).resolves.toMatchObject({
      kind: 'success',
      result: { structuredContent: { count: 1 } },
    });
    await expect(
      callAndRespond(client, transport, {
        content: [{ text: 'declined', type: 'text' }],
        isError: true,
      }),
    ).resolves.toMatchObject({
      kind: 'tool_error',
      result: { isError: true },
    });
  });

  it('distinguishes a remote JSON-RPC error without exposing its message', async () => {
    const { client, transport } = createClient();
    const called = client.callTool('orders.create', {});
    const request = await transport.nextSent();
    transport.pushIncoming({
      error: {
        code: -32_001,
        data: { secret: 'canary-data' },
        message: 'canary-remote-message',
      },
      id: requestId(request),
      jsonrpc: '2.0',
    });

    let caught: unknown;
    try {
      await called;
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(McpRemoteError);
    expect(caught).toMatchObject({ remoteCode: -32_001 });
    expect((caught as Error).message).not.toContain('canary');
  });

  it('correlates out-of-order responses to the correct requests', async () => {
    const { client, transport } = createClient();
    const first = client.callTool('first', {});
    const second = client.callTool('second', {});
    const firstRequest = await transport.nextSent();
    const secondRequest = await transport.nextSent();

    pushResult(transport, secondRequest, {
      content: [],
      structuredContent: { marker: 'second' },
    });
    pushResult(transport, firstRequest, {
      content: [],
      structuredContent: { marker: 'first' },
    });

    await expect(first).resolves.toMatchObject({
      result: { structuredContent: { marker: 'first' } },
    });
    await expect(second).resolves.toMatchObject({
      result: { structuredContent: { marker: 'second' } },
    });
  });

  it('marks in-flight work unknown when an uncorrelatable response terminates the client', async () => {
    const { client, transport } = createClient();
    const called = client.callTool('orders.create', {});
    await transport.nextSent();

    transport.pushIncoming({
      id: 999_999,
      jsonrpc: '2.0',
      result: { content: [] },
    });

    await expect(called).rejects.toBeInstanceOf(McpInFlightOutcomeUnknownError);
    await expect(called).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(client.callTool('after-fatal', {})).rejects.toBeInstanceOf(McpProtocolError);
  });

  it('ignores a duplicate completed response without corrupting later in-flight work', async () => {
    const { client, transport } = createClient();
    const called = client.callTool('orders.create', {});
    const request = await transport.nextSent();
    const response = {
      id: requestId(request),
      jsonrpc: '2.0',
      result: { content: [] },
    };
    transport.pushIncoming(response);
    await called;

    const later = client.callTool('later', {});
    const laterRequest = await transport.nextSent();
    transport.pushIncoming(response);
    pushResult(transport, laterRequest, { content: [] });

    await expect(later).resolves.toMatchObject({ kind: 'success' });
  });

  it('fails the connection when a method result violates its MCP schema', async () => {
    const { client, transport } = createClient();
    const called = client.callTool('orders.create', {});
    const request = await transport.nextSent();
    pushResult(transport, request, { content: [{ type: 'unknown-content' }] });

    const caught = await called.catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(McpInFlightOutcomeUnknownError);
    expect(caught).toMatchObject({ outcome: 'unknown' });
    expect((caught as Error).cause).toBeInstanceOf(McpProtocolError);
  });

  it.each([
    {
      label: 'a non-object result',
      response: { result: null },
    },
    {
      label: 'an invalid remote error code',
      response: {
        error: {
          code: Number.MAX_SAFE_INTEGER + 1,
          message: 'invalid code',
        },
      },
    },
  ])('marks the request outcome unknown for $label', async ({ response }) => {
    const { client, transport } = createClient();
    const called = client.callTool('orders.create', {});
    const request = await transport.nextSent();
    transport.pushIncoming({
      ...response,
      id: requestId(request),
      jsonrpc: '2.0',
    });

    await expect(called).rejects.toBeInstanceOf(McpInFlightOutcomeUnknownError);
    await expect(called).rejects.toMatchObject({ outcome: 'unknown' });
  });
});

describe('RawMcpClient timeout and cancellation', () => {
  it('exposes sanitized progress and lets an observer cancel the matching call', async () => {
    const { client, transport } = createClient();
    const handle = client.beginToolCall(
      'slow',
      {},
      { progressToken: 'attempt-progress', requestId: 'attempt-request' },
    );
    const request = await transport.nextSent();
    const observed: unknown[] = [];
    let cancellationWrite: ReturnType<typeof handle.cancel> | undefined;
    const unsubscribe = client.subscribeNotifications((notification) => {
      observed.push(notification);
      if (notification.progressToken === 'attempt-progress') {
        cancellationWrite = handle.cancel();
      }
    });

    transport.pushIncoming({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progress: 0.5,
        progressToken: 'attempt-progress',
        total: 1,
      },
    });

    await expect(handle.outcome).rejects.toBeInstanceOf(McpRequestAbortedError);
    await expect(handle.outcome).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(transport.nextSent()).resolves.toMatchObject({
      method: 'notifications/cancelled',
      params: { requestId: requestId(request) },
    });
    await expect(cancellationWrite).resolves.toMatchObject({
      acceptedByLocalPipe: true,
      sequence: 2,
    });
    expect(observed).toEqual([
      {
        method: 'notifications/progress',
        progress: 0.5,
        progressToken: 'attempt-progress',
        total: 1,
      },
    ]);
    expect(client.notificationSnapshot()).toEqual({
      dropped: 0,
      notifications: observed,
    });

    unsubscribe();
    unsubscribe();
  });

  it('exposes cancellation-notification write failure instead of claiming cancellation delivery', async () => {
    const { client, transport } = createClient();
    const handle = client.beginToolCall('slow', {}, { requestId: 'attempt' });
    await transport.nextSent();
    transport.throwOnNextSend(new TransportError('canary-cancellation-write-failure'));

    const cancellationWrite = handle.cancel();

    await expect(handle.outcome).rejects.toBeInstanceOf(McpRequestAbortedError);
    await expect(cancellationWrite).rejects.toBeInstanceOf(McpTransportError);
    await expect(cancellationWrite).rejects.not.toThrow(/canary/u);
  });

  it('times out locally, sends cancellation, ignores the late response, and remains usable', async () => {
    const { client, transport } = createClient();
    const timedOut = client.callTool('slow', {}, { timeoutMs: 20 });
    const slowRequest = await transport.nextSent();

    await expect(timedOut).rejects.toMatchObject({
      outcome: 'unknown',
    });
    await expect(timedOut).rejects.toBeInstanceOf(McpRequestTimeoutError);
    const cancellation = await transport.nextSent();
    expect(cancellation).toMatchObject({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: requestId(slowRequest) },
    });

    pushResult(transport, slowRequest, { content: [] });
    const next = client.callTool('fast', {});
    const nextRequest = await transport.nextSent();
    pushResult(transport, nextRequest, { content: [] });
    await expect(next).resolves.toMatchObject({ kind: 'success' });
  });

  it('aborts locally, sends cancellation, and classifies the outcome as unknown', async () => {
    const { client, transport } = createClient();
    const controller = new AbortController();
    const called = client.callTool('slow', {}, { signal: controller.signal });
    const request = await transport.nextSent();

    controller.abort();

    await expect(called).rejects.toBeInstanceOf(McpRequestAbortedError);
    await expect(called).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(transport.nextSent()).resolves.toMatchObject({
      method: 'notifications/cancelled',
      params: { requestId: requestId(request) },
    });
  });

  it('does not write a request when its signal is already aborted', async () => {
    const { client } = createClient();
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.callTool('never-sent', {}, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(McpRequestAbortedError);
  });
});

describe('RawMcpClient inbound server messages and lifecycle', () => {
  it('does not process a message whose receive settles in the same turn as close', async () => {
    const { client, transport } = createClient();
    transport.pushIncoming({
      id: 'server-ping',
      jsonrpc: '2.0',
      method: 'ping',
      params: {},
    });

    await client.close();

    expect(transport.sentCount).toBe(0);
  });

  it('settles a pending write receipt when the client closes', async () => {
    const { client, transport } = createClient();
    transport.holdNextSend();
    const handle = client.beginToolCall('orders.create', {});
    await transport.nextSent();

    await client.close();

    await expect(handle.writeAccepted).rejects.toBeInstanceOf(McpTransportError);
    await expect(handle.outcome).rejects.toBeInstanceOf(McpInFlightOutcomeUnknownError);
  });

  it('answers server ping requests without claiming unsupported capabilities', async () => {
    const { transport } = createClient();

    transport.pushIncoming({
      id: 'server-ping',
      jsonrpc: '2.0',
      method: 'ping',
      params: {},
    });

    await expect(transport.nextSent()).resolves.toEqual({
      id: 'server-ping',
      jsonrpc: '2.0',
      result: {},
    });
  });

  it('returns method-not-found for server requests requiring undeclared capabilities', async () => {
    const { transport } = createClient();

    transport.pushIncoming({
      id: 'server-sampling',
      jsonrpc: '2.0',
      method: 'sampling/createMessage',
      params: { messages: [] },
    });

    await expect(transport.nextSent()).resolves.toMatchObject({
      error: { code: -32_601 },
      id: 'server-sampling',
      jsonrpc: '2.0',
    });
  });

  it('normalizes a synchronous server-reply write failure and closes the transport', async () => {
    const { client, transport } = createClient();
    const pending = client.callTool('pending', {});
    await transport.nextSent();
    transport.throwOnNextSend(new TransportError('synchronous fixture failure'));

    transport.pushIncoming({
      id: 'server-ping',
      jsonrpc: '2.0',
      method: 'ping',
      params: {},
    });

    await expect(pending).rejects.toBeInstanceOf(McpTransportError);
    await client.close();
    expect(transport.closeCalls).toBe(1);
  });

  it('keeps only bounded notification metadata and never retains notification params', async () => {
    const { client, transport } = createClient(undefined, { maxNotifications: 2 });
    transport.pushIncoming({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { data: 'canary-secret-one' },
    });
    transport.pushIncoming({
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
      params: { data: 'canary-secret-two' },
    });
    transport.pushIncoming({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { reason: 'canary-secret-three', requestId: 1 },
    });

    const called = client.callTool('barrier', {});
    const request = await transport.nextSent();
    pushResult(transport, request, { content: [] });
    await called;

    expect(client.notificationSnapshot()).toEqual({
      dropped: 1,
      notifications: [
        { method: 'notifications/tools/list_changed' },
        { method: 'notifications/cancelled' },
      ],
    });
    expect(JSON.stringify(client.notificationSnapshot())).not.toContain('canary');
  });

  it('bounds retained notification metadata by encoded bytes as well as count', async () => {
    const { client, transport } = createClient(undefined, {
      maxNotificationBytes: 80,
      maxNotifications: 10,
    });
    transport.pushIncoming({
      jsonrpc: '2.0',
      method: `notifications/${'x'.repeat(256)}`,
    });

    const called = client.callTool('barrier', {});
    const request = await transport.nextSent();
    pushResult(transport, request, { content: [] });
    await called;

    expect(client.notificationSnapshot()).toEqual({
      dropped: 1,
      notifications: [],
    });
  });

  it('classifies transport failure separately and rejects every pending request', async () => {
    const { client, transport } = createClient();
    const first = client.callTool('first', {});
    const second = client.callTool('second', {});
    await transport.nextSent();
    await transport.nextSent();

    transport.failIncoming(new TransportError('fixture transport failed'));

    await expect(first).rejects.toBeInstanceOf(McpTransportError);
    await expect(second).rejects.toBeInstanceOf(McpTransportError);
    await client.close();
    expect(transport.closeCalls).toBe(1);
    expect(transport.closed).toBe(true);
  });

  it('close is idempotent, marks pending outcomes unknown, and rejects new work as closed', async () => {
    const { client, transport } = createClient();
    const pending = client.callTool('pending', {});
    await transport.nextSent();

    await Promise.all([client.close(), client.close()]);

    await expect(pending).rejects.toBeInstanceOf(McpInFlightOutcomeUnknownError);
    await expect(pending).rejects.toMatchObject({ outcome: 'unknown' });
    await expect(client.callTool('after-close', {})).rejects.toBeInstanceOf(McpClientClosedError);
    expect(transport.closed).toBe(true);
    expect(transport.closeCalls).toBe(1);
  });

  it('settles close when the transport closes but an outstanding receive never settles', async () => {
    let closeCalls = 0;
    const transport: MessageTransport<void> = {
      close: () => {
        closeCalls += 1;
        return Promise.resolve();
      },
      receive: () => new Promise<Record<string, unknown>>(() => undefined),
      send: (): Promise<TransportWriteReceipt> =>
        Promise.resolve({
          acceptedByLocalPipe: true,
          byteLength: 0,
          sequence: 1,
        }),
    };
    const client = new RawMcpClient(transport, { requestTimeoutMs: 1_000 });
    let timeout: NodeJS.Timeout | undefined;

    const outcome = await Promise.race([
      client.close().then(() => 'closed' as const),
      new Promise<'timed-out'>((resolve) => {
        timeout = setTimeout(() => {
          resolve('timed-out');
        }, 100);
      }),
    ]);
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }

    expect(outcome).toBe('closed');
    expect(closeCalls).toBe(1);
  });
});
