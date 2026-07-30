export interface TransportWriteReceipt {
  /**
   * Confirms only that Node's local writable stream accepted and flushed this frame.
   * It is not evidence that the server read, handled, or committed the request.
   */
  readonly acceptedByLocalPipe: true;
  readonly byteLength: number;
  readonly sequence: number;
}

export interface MessageTransport<TClose = unknown> {
  close(): Promise<TClose>;
  receive(): Promise<Record<string, unknown>>;
  send(message: Record<string, unknown>): Promise<TransportWriteReceipt>;
}
