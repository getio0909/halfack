import { TargetError } from '../domain/errors.js';

export class McpError extends TargetError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class McpProtocolError extends McpError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class McpCapabilityError extends McpError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class McpRemoteError extends McpError {
  public readonly outcome = 'rejected' as const;

  public constructor(
    public readonly remoteCode: number,
    options?: ErrorOptions,
  ) {
    super(`The MCP server rejected the request with code ${String(remoteCode)}.`, options);
  }
}

export class McpRequestTimeoutError extends McpError {
  public readonly outcome = 'unknown' as const;

  public constructor(options?: ErrorOptions) {
    super('The MCP request timed out; its remote outcome is unknown.', options);
  }
}

export class McpRequestAbortedError extends McpError {
  public readonly outcome = 'unknown' as const;

  public constructor(options?: ErrorOptions) {
    super('The MCP request was aborted; its remote outcome is unknown.', options);
  }
}

export class McpTransportError extends McpError {
  public readonly outcome = 'unknown' as const;

  public constructor(options?: ErrorOptions) {
    super('The MCP transport failed; pending remote outcomes are unknown.', options);
  }
}

export class McpClientClosedError extends McpError {
  public constructor(options?: ErrorOptions) {
    super('The MCP client is closed.', options);
  }
}

export class McpInFlightOutcomeUnknownError extends McpError {
  public readonly outcome = 'unknown' as const;

  public constructor(options?: ErrorOptions) {
    super('An in-flight MCP request was interrupted; its remote outcome is unknown.', options);
  }
}
