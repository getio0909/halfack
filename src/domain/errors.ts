import { ExitCode } from './exit-code.js';

export class HalfAckError extends Error {
  public constructor(
    message: string,
    public readonly publicCode: string,
    public readonly exitCode: ExitCode,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class UsageError extends HalfAckError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, 'HALFACK_USAGE', ExitCode.Usage, options);
  }
}

export class ConfigError extends HalfAckError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, 'HALFACK_CONFIG', ExitCode.Configuration, options);
  }
}

export class TargetError extends HalfAckError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, 'HALFACK_TARGET', ExitCode.Target, options);
  }
}

export class ContractViolationError extends HalfAckError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, 'HALFACK_CONTRACT', ExitCode.ContractViolation, options);
  }
}

export class InternalError extends HalfAckError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, 'HALFACK_INTERNAL', ExitCode.Internal, options);
  }
}

export function normalizeError(error: unknown): HalfAckError {
  if (error instanceof HalfAckError) {
    return error;
  }

  return new InternalError('HalfAck failed unexpectedly.', { cause: error });
}

export function renderError(error: HalfAckError): string {
  return `${error.publicCode}: ${error.message}\n`;
}
