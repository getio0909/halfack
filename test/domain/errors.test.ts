import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  HalfAckError,
  InternalError,
  UsageError,
  normalizeError,
  renderError,
} from '../../src/domain/errors.js';
import { ExitCode } from '../../src/domain/exit-code.js';

describe('HalfAck errors', () => {
  it.each([
    [new UsageError('bad invocation'), ExitCode.Usage, 'HALFACK_USAGE'],
    [new ConfigError('bad scenario'), ExitCode.Configuration, 'HALFACK_CONFIG'],
    [new InternalError('unexpected failure'), ExitCode.Internal, 'HALFACK_INTERNAL'],
  ])('carries a stable exit code and public code', (error, exitCode, publicCode) => {
    expect({
      exitCode: error.exitCode,
      publicCode: error.publicCode,
    }).toEqual({
      exitCode,
      publicCode,
    });
  });

  it('renders only the public message by default', () => {
    const cause = new Error('private-cause-value');
    const error = new ConfigError('Scenario is invalid.', { cause });

    expect(renderError(error)).toBe('HALFACK_CONFIG: Scenario is invalid.\n');
  });

  it('normalizes arbitrary thrown values without exposing them', () => {
    const error = normalizeError('canary-secret-value');

    expect({
      isHalfAckError: error instanceof HalfAckError,
      rendered: renderError(error),
    }).toEqual({
      isHalfAckError: true,
      rendered: 'HALFACK_INTERNAL: HalfAck failed unexpectedly.\n',
    });
  });
});
