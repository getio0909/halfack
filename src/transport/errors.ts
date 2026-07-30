import { TargetError } from '../domain/errors.js';

export class TransportError extends TargetError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class NdjsonProtocolError extends TransportError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class TransportCapacityError extends TransportError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class TransportClosedError extends TransportError {
  public constructor(message = 'The target transport is closed.', options?: ErrorOptions) {
    super(message, options);
  }
}

export class TransportWriteError extends TransportError {
  public constructor(
    message = 'The target transport rejected a local write.',
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
