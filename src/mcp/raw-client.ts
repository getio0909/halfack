import {
  CallToolRequestSchema,
  CallToolResultSchema,
  CancelledNotificationSchema,
  DiscoverRequestSchema,
  DiscoverResultSchema,
  JSONRPCErrorResponseSchema,
  JSONRPCMessageSchema,
  JSONRPCNotificationSchema,
  JSONRPCRequestSchema,
  JSONRPCResultResponseSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  PingRequestSchema,
  ProgressNotificationSchema,
  type ToolSchema,
} from '@modelcontextprotocol/core';
import type { z } from 'zod/v4';
import { MCP_PROTOCOL_VERSION } from '../config/scenario-schema.js';
import type { MessageTransport, TransportWriteReceipt } from '../transport/message-transport.js';
import {
  McpCapabilityError,
  McpClientClosedError,
  McpInFlightOutcomeUnknownError,
  McpProtocolError,
  McpRemoteError,
  McpRequestAbortedError,
  McpRequestTimeoutError,
  McpTransportError,
  type McpError,
} from './errors.js';
import { createRequestMeta } from './request-meta.js';

const DEFAULT_MAX_LIST_PAGES = 64;
const DEFAULT_MAX_NOTIFICATION_BYTES = 64 * 1024;
const DEFAULT_MAX_NOTIFICATIONS = 256;
const DEFAULT_MAX_TOMBSTONES = 4_096;
const DEFAULT_MAX_TOOLS = 10_000;
const METHOD_NOT_FOUND = -32_601;

export type McpRequestId = number | string;
export type McpProgressToken = number | string;
type DiscoverResult = z.output<typeof DiscoverResultSchema>;
type CallToolResult = z.output<typeof CallToolResultSchema>;
export type McpTool = z.output<typeof ToolSchema>;

export interface RawMcpClientOptions {
  readonly maxListPages?: number;
  readonly maxNotificationBytes?: number;
  readonly maxNotifications?: number;
  readonly maxTombstones?: number;
  readonly maxTools?: number;
  readonly requestTimeoutMs: number;
}

export interface McpRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface McpToolCallOptions extends McpRequestOptions {
  readonly progressToken?: McpProgressToken;
  readonly requestId?: McpRequestId;
}

export type ToolCallOutcome =
  | {
      readonly kind: 'success';
      readonly result: CallToolResult;
    }
  | {
      readonly kind: 'tool_error';
      readonly result: CallToolResult;
    };

export interface ObservedServerNotification {
  readonly method: string;
  readonly progress?: number;
  readonly progressToken?: McpProgressToken;
  readonly total?: number;
}

export interface NotificationSnapshot {
  readonly dropped: number;
  readonly notifications: readonly ObservedServerNotification[];
}

export interface McpToolCallHandle {
  readonly cancel: () => Promise<TransportWriteReceipt | undefined>;
  readonly outcome: Promise<ToolCallOutcome>;
  readonly requestId: McpRequestId;
  readonly writeAccepted: Promise<TransportWriteReceipt>;
}

interface NormalizedClientOptions {
  readonly maxListPages: number;
  readonly maxNotificationBytes: number;
  readonly maxNotifications: number;
  readonly maxTombstones: number;
  readonly maxTools: number;
  readonly requestTimeoutMs: number;
}

interface PendingRequest {
  readonly abortListener: (() => void) | undefined;
  readonly id: McpRequestId;
  readonly reject: (error: McpError) => void;
  readonly resolve: (result: Record<string, unknown>) => void;
  readonly signal: AbortSignal | undefined;
  readonly timer: NodeJS.Timeout;
}

interface StartedRequest {
  readonly cancel: () => Promise<TransportWriteReceipt | undefined>;
  readonly id: McpRequestId;
  readonly result: Promise<Record<string, unknown>>;
  readonly writeAccepted: Promise<TransportWriteReceipt>;
}

interface RetainedNotification extends ObservedServerNotification {
  readonly retainedBytes: number;
}

type NotificationListener = (notification: ObservedServerNotification) => void;

export class RawMcpClient {
  readonly #explicitRequestIds = new Set<McpRequestId>();
  readonly #notificationListeners = new Set<NotificationListener>();
  readonly #notifications: RetainedNotification[] = [];
  readonly #options: NormalizedClientOptions;
  readonly #pending = new Map<McpRequestId, PendingRequest>();
  readonly #reader: Promise<void>;
  readonly #readerBoundary = createReaderBoundary();
  readonly #tombstones = new Map<McpRequestId, true>();
  readonly #transport: MessageTransport;
  readonly #writeBoundary = createWriteBoundary();
  #closePromise: Promise<void> | undefined;
  #droppedNotifications = 0;
  #notificationBytes = 0;
  #nextRequestId = 1;
  #terminalError: McpError | undefined;
  #transportClosePromise: Promise<unknown> | undefined;

  public constructor(transport: MessageTransport, options: RawMcpClientOptions) {
    this.#transport = transport;
    this.#options = normalizeOptions(options);
    this.#reader = this.#readLoop();
  }

  public async discover(options: McpRequestOptions = {}): Promise<DiscoverResult> {
    const body = parseGeneratedBody(
      DiscoverRequestSchema,
      {
        method: 'server/discover',
        params: { _meta: createRequestMeta() },
      },
      'server/discover',
    );
    const rawResult = await this.#request(body, options);
    const result = this.#parseTargetResult(DiscoverResultSchema, rawResult, 'server/discover');

    if (!result.supportedVersions.includes(MCP_PROTOCOL_VERSION)) {
      throw new McpCapabilityError(
        `The MCP server does not support protocol ${MCP_PROTOCOL_VERSION}.`,
      );
    }
    if (result.capabilities.tools === undefined) {
      throw new McpCapabilityError('The MCP server does not advertise tools capability.');
    }
    return result;
  }

  public async listTools(options: McpRequestOptions = {}): Promise<readonly McpTool[]> {
    const tools: McpTool[] = [];
    const toolNames = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < this.#options.maxListPages; page += 1) {
      const params =
        cursor === undefined
          ? { _meta: createRequestMeta() }
          : { _meta: createRequestMeta(), cursor };
      const body = parseGeneratedBody(
        ListToolsRequestSchema,
        { method: 'tools/list', params },
        'tools/list',
      );
      const rawResult = await this.#request(body, options);
      const result = this.#parseTargetResult(ListToolsResultSchema, rawResult, 'tools/list');

      for (const tool of result.tools) {
        if (toolNames.has(tool.name)) {
          throw this.#protocolFailure('The MCP server listed a duplicate tool name.');
        }
        toolNames.add(tool.name);
        tools.push(tool);
        if (tools.length > this.#options.maxTools) {
          throw this.#protocolFailure('The MCP tool catalog exceeded its safety limit.');
        }
      }

      const nextCursor = result.nextCursor;
      if (nextCursor === undefined) {
        return tools;
      }
      if (seenCursors.has(nextCursor)) {
        throw this.#protocolFailure('The MCP server repeated a tools pagination cursor.');
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    throw this.#protocolFailure('The MCP tool catalog exceeded its page limit.');
  }

  public async requireTools(
    requiredNames: readonly string[],
    options: McpRequestOptions = {},
  ): Promise<readonly McpTool[]> {
    const uniqueRequiredNames = [...new Set(requiredNames)];
    const tools = await this.listTools(options);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    const requiredTools: McpTool[] = [];
    let missing = 0;
    for (const name of uniqueRequiredNames) {
      const tool = byName.get(name);
      if (tool === undefined) {
        missing += 1;
      } else {
        requiredTools.push(tool);
      }
    }
    if (missing !== 0) {
      throw new McpCapabilityError(
        `The MCP server is missing ${String(missing)} required tool(s).`,
      );
    }
    return requiredTools;
  }

  public beginToolCall(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    options: McpToolCallOptions = {},
  ): McpToolCallHandle {
    const body = parseGeneratedBody(
      CallToolRequestSchema,
      {
        method: 'tools/call',
        params: {
          _meta: createRequestMeta(options.progressToken),
          arguments: arguments_,
          name,
        },
      },
      'tools/call',
    );
    const started = this.#startRequest(body, options);
    const outcome = started.result.then((rawResult) => {
      let result: CallToolResult;
      try {
        result = this.#parseTargetResult(CallToolResultSchema, rawResult, 'tools/call');
      } catch (error: unknown) {
        if (error instanceof McpProtocolError) {
          throw new McpInFlightOutcomeUnknownError({ cause: error });
        }
        throw error;
      }
      return result.isError === true
        ? ({ kind: 'tool_error', result } as const)
        : ({ kind: 'success', result } as const);
    });
    void outcome.catch(() => undefined);

    return {
      cancel: started.cancel,
      outcome,
      requestId: started.id,
      writeAccepted: started.writeAccepted,
    };
  }

  public async callTool(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    options: McpToolCallOptions = {},
  ): Promise<ToolCallOutcome> {
    return this.beginToolCall(name, arguments_, options).outcome;
  }

  public subscribeNotifications(listener: NotificationListener): () => void {
    if (this.#terminalError !== undefined) {
      throw this.#terminalError;
    }
    this.#notificationListeners.add(listener);
    let subscribed = true;
    return () => {
      if (subscribed) {
        subscribed = false;
        this.#notificationListeners.delete(listener);
      }
    };
  }

  public notificationSnapshot(): NotificationSnapshot {
    return {
      dropped: this.#droppedNotifications,
      notifications: this.#notifications.map((notification) => ({
        method: notification.method,
        ...(notification.progress === undefined ? {} : { progress: notification.progress }),
        ...(notification.progressToken === undefined
          ? {}
          : { progressToken: notification.progressToken }),
        ...(notification.total === undefined ? {} : { total: notification.total }),
      })),
    };
  }

  public close(): Promise<void> {
    this.#closePromise ??= this.#closeInternal();
    return this.#closePromise;
  }

  async #closeInternal(): Promise<void> {
    this.#terminate(new McpClientClosedError(), false);
    try {
      await this.#closeTransport();
    } catch {
      // Resource cleanup is best-effort after all callers have already been settled.
    }
    await this.#reader;
  }

  #request(
    body: Record<string, unknown>,
    options: McpRequestOptions,
  ): Promise<Record<string, unknown>> {
    return this.#startRequest(body, options).result;
  }

  #startRequest(body: Record<string, unknown>, options: McpToolCallOptions): StartedRequest {
    if (this.#terminalError !== undefined) {
      throw this.#terminalError;
    }
    if (options.signal?.aborted === true) {
      throw new McpRequestAbortedError();
    }

    const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs;
    assertPositiveInteger(timeoutMs, 'request timeout');
    const id = this.#selectRequestId(options.requestId);
    const wire = parseGeneratedWireRequest({
      ...body,
      id,
      jsonrpc: '2.0',
    });

    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const abortListener =
        options.signal === undefined
          ? undefined
          : () => {
              void this.#abandonRequest(id, new McpRequestAbortedError()).catch(() => undefined);
            };
      const timer = setTimeout(() => {
        void this.#abandonRequest(id, new McpRequestTimeoutError()).catch(() => undefined);
      }, timeoutMs);

      const pending: PendingRequest = {
        abortListener,
        id,
        reject,
        resolve,
        signal: options.signal,
        timer,
      };
      this.#pending.set(id, pending);
      if (options.signal !== undefined && abortListener !== undefined) {
        options.signal.addEventListener('abort', abortListener, { once: true });
      }
    });

    let transportWrite: Promise<TransportWriteReceipt>;
    try {
      transportWrite = this.#transport.send(wire);
    } catch (error: unknown) {
      transportWrite = Promise.reject(error instanceof Error ? error : new Error('Write failed.'));
    }
    const writeAccepted = Promise.race([transportWrite, this.#writeBoundary.promise]).catch(
      (error: unknown) => {
        const failure = new McpTransportError({ cause: error });
        this.#terminate(failure, true);
        throw failure;
      },
    );
    void writeAccepted.catch(() => undefined);
    void response.catch(() => undefined);

    return {
      cancel: () => {
        return this.#abandonRequest(id, new McpRequestAbortedError());
      },
      id,
      result: response,
      writeAccepted,
    };
  }

  async #readLoop(): Promise<void> {
    while (!this.#isTerminated()) {
      let message: Record<string, unknown> | undefined;
      try {
        message = await Promise.race([
          this.#transport.receive(),
          this.#readerBoundary.promise.then(() => undefined),
        ]);
      } catch (error: unknown) {
        this.#terminate(new McpTransportError({ cause: error }), true);
        return;
      }
      if (message === undefined || this.#isTerminated()) {
        return;
      }
      this.#handleIncoming(message);
    }
  }

  #isTerminated(): boolean {
    return this.#terminalError !== undefined;
  }

  #handleIncoming(message: Record<string, unknown>): void {
    const parsed = JSONRPCMessageSchema.safeParse(message);
    if (!parsed.success) {
      this.#protocolFailure('The MCP server sent an invalid JSON-RPC message.', {
        cause: parsed.error,
      });
      return;
    }
    const wire: Record<string, unknown> = parsed.data;

    if ('result' in wire || 'error' in wire) {
      this.#handleResponse(wire);
      return;
    }
    if ('id' in wire) {
      this.#handleServerRequest(wire);
      return;
    }
    this.#recordNotification(wire);
  }

  #handleResponse(wire: Record<string, unknown>): void {
    const id = wire['id'];
    if (!isRequestId(id)) {
      this.#protocolFailure('The MCP server sent an uncorrelatable response.');
      return;
    }
    if (this.#tombstones.has(id)) {
      return;
    }

    const pending = this.#pending.get(id);
    if (pending === undefined) {
      this.#protocolFailure('The MCP server sent a response with an unknown request ID.');
      return;
    }
    this.#pending.delete(id);
    this.#rememberTombstone(id);
    cleanupPending(pending);

    if ('error' in wire) {
      const errorObject = wire['error'];
      const remoteCode =
        errorObject !== null && typeof errorObject === 'object'
          ? (errorObject as Record<string, unknown>)['code']
          : undefined;
      if (typeof remoteCode !== 'number' || !Number.isSafeInteger(remoteCode)) {
        const error = this.#protocolFailure('The MCP server sent an invalid error response.');
        pending.reject(new McpInFlightOutcomeUnknownError({ cause: error }));
        return;
      }
      pending.reject(new McpRemoteError(remoteCode));
      return;
    }

    const result = wire['result'];
    if (result === null || typeof result !== 'object' || Array.isArray(result)) {
      const error = this.#protocolFailure('The MCP server sent an invalid result response.');
      pending.reject(new McpInFlightOutcomeUnknownError({ cause: error }));
      return;
    }
    pending.resolve(result as Record<string, unknown>);
  }

  #handleServerRequest(wire: Record<string, unknown>): void {
    const id = wire['id'];
    if (!isRequestId(id)) {
      this.#protocolFailure('The MCP server sent a request with an invalid ID.');
      return;
    }
    const method = String(wire['method']);
    const body = {
      method,
      ...(wire['params'] === undefined ? {} : { params: wire['params'] }),
    };

    if (method === 'ping' && PingRequestSchema.safeParse(body).success) {
      const response = JSONRPCResultResponseSchema.parse({
        id,
        jsonrpc: '2.0',
        result: {},
      });
      this.#sendServerReply(response);
      return;
    }

    const response = JSONRPCErrorResponseSchema.parse({
      error: {
        code: METHOD_NOT_FOUND,
        message: 'Method not supported by HalfAck.',
      },
      id,
      jsonrpc: '2.0',
    });
    this.#sendServerReply(response);
  }

  #sendServerReply(message: Record<string, unknown>): void {
    void this.#sendAuxiliaryMessage(message).catch(() => undefined);
  }

  #sendAuxiliaryMessage(message: Record<string, unknown>): Promise<TransportWriteReceipt> {
    let write: Promise<TransportWriteReceipt>;
    try {
      write = this.#transport.send(message);
    } catch (error: unknown) {
      const failure = new McpTransportError({ cause: error });
      this.#terminate(failure, true);
      const rejected = Promise.reject<TransportWriteReceipt>(failure);
      void rejected.catch(() => undefined);
      return rejected;
    }
    const observed = Promise.race([write, this.#writeBoundary.promise]).catch((error: unknown) => {
      const failure = new McpTransportError({ cause: error });
      this.#terminate(failure, true);
      throw failure;
    });
    void observed.catch(() => undefined);
    return observed;
  }

  #recordNotification(wire: Record<string, unknown>): void {
    const method = String(wire['method']);
    let notification: ObservedServerNotification = { method };
    if (method === 'notifications/progress') {
      const parsed = ProgressNotificationSchema.safeParse({
        method,
        ...(wire['params'] === undefined ? {} : { params: wire['params'] }),
      });
      if (!parsed.success) {
        this.#protocolFailure('The MCP server sent an invalid progress notification.', {
          cause: parsed.error,
        });
        return;
      }
      notification = {
        method,
        progress: parsed.data.params.progress,
        progressToken: parsed.data.params.progressToken,
        ...(parsed.data.params.total === undefined ? {} : { total: parsed.data.params.total }),
      };
    }

    const immutableNotification = Object.freeze(notification);
    for (const listener of [...this.#notificationListeners]) {
      try {
        listener(immutableNotification);
      } catch {
        // Listener failures are local observer failures and cannot corrupt protocol handling.
      }
    }

    const retainedBytes = Buffer.byteLength(JSON.stringify(immutableNotification));
    if (retainedBytes > this.#options.maxNotificationBytes) {
      this.#droppedNotifications += 1;
      return;
    }
    while (
      this.#notifications.length >= this.#options.maxNotifications ||
      this.#notificationBytes + retainedBytes > this.#options.maxNotificationBytes
    ) {
      const removed = this.#notifications.shift();
      if (removed === undefined) {
        break;
      }
      this.#notificationBytes -= removed.retainedBytes;
      this.#droppedNotifications += 1;
    }
    this.#notifications.push({ ...immutableNotification, retainedBytes });
    this.#notificationBytes += retainedBytes;
  }

  #abandonRequest(
    id: McpRequestId,
    error: McpRequestAbortedError | McpRequestTimeoutError,
  ): Promise<TransportWriteReceipt | undefined> {
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      return Promise.resolve(undefined);
    }
    this.#pending.delete(id);
    cleanupPending(pending);
    this.#rememberTombstone(id);
    pending.reject(error);
    return this.#sendCancellation(id);
  }

  #sendCancellation(id: McpRequestId): Promise<TransportWriteReceipt> {
    const body = CancelledNotificationSchema.parse({
      method: 'notifications/cancelled',
      params: { requestId: id },
    });
    const wire = JSONRPCNotificationSchema.parse({
      ...body,
      jsonrpc: '2.0',
    });
    return this.#sendAuxiliaryMessage(wire);
  }

  #rememberTombstone(id: McpRequestId): void {
    this.#tombstones.set(id, true);
    if (this.#tombstones.size > this.#options.maxTombstones) {
      const oldest = this.#tombstones.keys().next().value;
      if (oldest !== undefined) {
        this.#tombstones.delete(oldest);
      }
    }
  }

  #parseTargetResult<T>(schema: z.ZodType<T>, value: Record<string, unknown>, method: string): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw this.#protocolFailure(`The MCP server returned an invalid ${method} result.`, {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  #protocolFailure(message: string, options?: ErrorOptions): McpProtocolError {
    const error = new McpProtocolError(message, options);
    this.#terminate(error, true);
    return error;
  }

  #terminate(error: McpError, closeTransport: boolean): void {
    if (this.#terminalError !== undefined) {
      return;
    }
    this.#terminalError = error;
    this.#readerBoundary.resolve();
    this.#writeBoundary.reject(error);
    const pendingError =
      error instanceof McpTransportError
        ? error
        : new McpInFlightOutcomeUnknownError({ cause: error });
    for (const pending of this.#pending.values()) {
      cleanupPending(pending);
      pending.reject(pendingError);
    }
    this.#pending.clear();
    this.#notificationListeners.clear();

    if (closeTransport) {
      void this.#closeTransport().catch(() => undefined);
    }
  }

  #closeTransport(): Promise<unknown> {
    if (this.#transportClosePromise === undefined) {
      try {
        this.#transportClosePromise = this.#transport.close();
      } catch (error: unknown) {
        this.#transportClosePromise = Promise.reject(new McpTransportError({ cause: error }));
      }
    }
    return this.#transportClosePromise;
  }

  #allocateRequestId(): number {
    if (!Number.isSafeInteger(this.#nextRequestId)) {
      throw this.#protocolFailure('The MCP request ID space is exhausted.');
    }
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    return id;
  }

  #selectRequestId(requestedId: McpRequestId | undefined): McpRequestId {
    if (requestedId === undefined) {
      return this.#allocateRequestId();
    }
    if (!isRequestId(requestedId)) {
      throw new RangeError('requestId must be a string or safe integer.');
    }
    if (this.#pending.has(requestedId)) {
      throw new McpProtocolError('An MCP request ID cannot be reused while it is active.');
    }
    if (typeof requestedId === 'number' && requestedId < this.#nextRequestId) {
      throw new McpProtocolError(
        'A numeric MCP request ID cannot be reused within one connection epoch.',
      );
    }
    if (this.#explicitRequestIds.has(requestedId)) {
      throw new McpProtocolError(
        'An explicit MCP request ID cannot be reused within one connection epoch.',
      );
    }
    if (this.#explicitRequestIds.size >= this.#options.maxTombstones) {
      throw new McpProtocolError('The explicit MCP request ID budget is exhausted.');
    }
    this.#explicitRequestIds.add(requestedId);
    if (typeof requestedId === 'number' && requestedId >= this.#nextRequestId) {
      this.#nextRequestId = requestedId + 1;
    }
    return requestedId;
  }
}

function parseGeneratedBody<T extends Record<string, unknown>>(
  schema: z.ZodType<T>,
  value: unknown,
  method: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new McpProtocolError(`HalfAck could not construct a valid ${method} request.`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function parseGeneratedWireRequest(value: unknown): Record<string, unknown> {
  const parsed = JSONRPCRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new McpProtocolError('HalfAck could not construct a valid JSON-RPC request.', {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

function cleanupPending(pending: PendingRequest): void {
  clearTimeout(pending.timer);
  if (pending.abortListener !== undefined) {
    pending.signal?.removeEventListener('abort', pending.abortListener);
  }
}

function createWriteBoundary(): {
  readonly promise: Promise<never>;
  readonly reject: (error: McpError) => void;
} {
  let rejectPromise!: (error: McpError) => void;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return {
    promise,
    reject: rejectPromise,
  };
}

function createReaderBoundary(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: resolvePromise,
  };
}

function isRequestId(value: unknown): value is McpRequestId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
}

function normalizeOptions(options: RawMcpClientOptions): NormalizedClientOptions {
  const normalized: NormalizedClientOptions = {
    maxListPages: options.maxListPages ?? DEFAULT_MAX_LIST_PAGES,
    maxNotificationBytes: options.maxNotificationBytes ?? DEFAULT_MAX_NOTIFICATION_BYTES,
    maxNotifications: options.maxNotifications ?? DEFAULT_MAX_NOTIFICATIONS,
    maxTombstones: options.maxTombstones ?? DEFAULT_MAX_TOMBSTONES,
    maxTools: options.maxTools ?? DEFAULT_MAX_TOOLS,
    requestTimeoutMs: options.requestTimeoutMs,
  };
  const limits = [
    ['maxListPages', normalized.maxListPages],
    ['maxNotificationBytes', normalized.maxNotificationBytes],
    ['maxNotifications', normalized.maxNotifications],
    ['maxTombstones', normalized.maxTombstones],
    ['maxTools', normalized.maxTools],
    ['requestTimeoutMs', normalized.requestTimeoutMs],
  ] as const;
  for (const [name, value] of limits) {
    assertPositiveInteger(value, name);
  }
  return normalized;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}
