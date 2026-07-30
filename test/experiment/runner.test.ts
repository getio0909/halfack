import { describe, expect, it } from 'vitest';
import {
  EXPERIMENT_NAMES,
  scenarioSchema,
  type ExperimentName,
  type Scenario,
} from '../../src/config/scenario-schema.js';
import {
  runScenarioExperiments,
  type ExperimentRunnerDependencies,
} from '../../src/experiment/runner.js';
import type { ExpandedInvocation, ExpandedRun } from '../../src/experiment/arguments.js';
import {
  FaultGateError,
  type DisconnectGateLease,
  type ToolResponseGateLease,
  type ToolResponseGateObservation,
} from '../../src/experiment/fault-gate.js';
import {
  ExperimentSessionError,
  type ExperimentSession,
  type ExperimentSessionFactory,
  type OpenExperimentSessionInput,
} from '../../src/experiment/session.js';
import type { SafeProcessEvidence } from '../../src/experiment/types.js';
import {
  McpProtocolError,
  McpRequestAbortedError,
  McpRequestTimeoutError,
  McpTransportError,
} from '../../src/mcp/errors.js';
import type {
  McpRequestId,
  McpToolCallHandle,
  McpToolCallOptions,
  ObservedServerNotification,
  ToolCallOutcome,
} from '../../src/mcp/raw-client.js';
import type { SettledProbe } from '../../src/oracle/settle.js';
import type { ProcessCloseSummary, ProcessTermination } from '../../src/transport/stdio-process.js';
import type { TransportWriteReceipt } from '../../src/transport/message-transport.js';
import { createValidScenario } from '../config/scenario-fixture.js';

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
  void promise.catch(() => undefined);
  return {
    promise,
    reject: rejectPromise,
    resolve: resolvePromise,
  };
}

interface ModelOptions {
  readonly abortOnAdditionalOpen?: () => void;
  readonly abortOnInitialTerminationFailure?: () => void;
  readonly beginFailsOn?: 'parallel-b' | 'retry' | 'seed';
  readonly cancelWriteFails?: boolean;
  readonly cancelWriteHangs?: boolean;
  readonly cancelUsesWrongToken?: boolean;
  readonly cleanupResetFails?: boolean;
  readonly cleanupOpenTerminationFails?: boolean;
  readonly disconnectError?: Error;
  readonly disconnectTerminatesNaturally?: boolean;
  readonly disconnectTriggerFails?: boolean;
  readonly firstBaselineValue?: number;
  readonly firstCloseUnconfirmed?: boolean;
  readonly firstOpenTerminationFailure?: 'termination_failed' | 'termination_unproven';
  readonly firstOpenTerminationUnproven?: boolean;
  readonly firstResetFails?: boolean;
  readonly loseStateOnSecondOpen?: boolean;
  readonly mutationValue?: number;
  readonly onCancelWrite?: () => void;
  readonly parallelMode?:
    'failure_then_delayed_success' | 'second_begin_failure' | 'reverse_success';
  readonly retryIsUnknown?: boolean;
  readonly suppressionCancelWriteHangs?: boolean;
}

class ModelSessionFactory implements ExperimentSessionFactory {
  public readonly events: string[] = [];
  public readonly opensByRun = new Map<string, number>();
  public readonly settleModes: {
    readonly observeUntilDeadline: boolean;
    readonly runId: string;
  }[] = [];
  readonly #options: ModelOptions;
  readonly #resetCalls = new Map<string, number>();
  readonly #settleCalls = new Map<string, number>();
  readonly #state = new Map<string, number>();
  readonly #seen = new Set<string>();
  #closeCalls = 0;
  #openCalls = 0;

  public constructor(options: ModelOptions = {}) {
    this.#options = options;
  }

  public open(input: OpenExperimentSessionInput): Promise<ExperimentSession> {
    this.#openCalls += 1;
    const runId = input.run.runId;
    const opens = (this.opensByRun.get(runId) ?? 0) + 1;
    this.opensByRun.set(runId, opens);
    this.events.push(`open:${runId}:${String(opens)}`);
    if (this.#options.firstOpenTerminationFailure !== undefined && this.#openCalls === 1) {
      this.#options.abortOnInitialTerminationFailure?.();
      return Promise.reject(new ExperimentSessionError(this.#options.firstOpenTerminationFailure));
    }
    if (this.#options.firstOpenTerminationUnproven === true && this.#openCalls === 1) {
      return Promise.reject(new ExperimentSessionError('termination_unproven'));
    }
    if (this.#options.abortOnAdditionalOpen !== undefined && opens === 2) {
      this.#options.abortOnAdditionalOpen();
      return Promise.reject(new ExperimentSessionError('open_failed'));
    }
    if (this.#options.cleanupOpenTerminationFails === true && opens === 2) {
      return Promise.reject(new ExperimentSessionError('termination_failed'));
    }
    if (this.#options.loseStateOnSecondOpen === true && opens === 2) {
      this.#state.set(runId, 0);
      this.#seen.delete(runId);
    }
    return Promise.resolve(new ModelSession(this, input.run, input.scenario));
  }

  public reset(runId: string): ToolCallOutcome {
    const calls = (this.#resetCalls.get(runId) ?? 0) + 1;
    this.#resetCalls.set(runId, calls);
    this.events.push(`reset:${runId}:${String(calls)}`);
    if (
      (this.#options.firstResetFails === true && calls === 1) ||
      (this.#options.cleanupResetFails === true && calls >= 2)
    ) {
      return {
        kind: 'tool_error',
        result: {
          content: [],
          isError: true,
        },
      };
    }
    this.#state.set(runId, 0);
    this.#seen.delete(runId);
    return {
      kind: 'success',
      result: {
        content: [],
      },
    };
  }

  public mutate(runId: string): void {
    if (this.#seen.has(runId)) {
      return;
    }
    this.#seen.add(runId);
    this.#state.set(runId, this.#options.mutationValue ?? 1);
  }

  public cancel(runId: string, cancelledEffect: number): void {
    this.#state.set(runId, cancelledEffect);
    this.#seen.add(runId);
  }

  public settle(runId: string, observeUntilDeadline: boolean): SettledProbe {
    const calls = (this.#settleCalls.get(runId) ?? 0) + 1;
    this.#settleCalls.set(runId, calls);
    const value =
      calls === 1 && this.#options.firstBaselineValue !== undefined
        ? this.#options.firstBaselineValue
        : (this.#state.get(runId) ?? 0);
    this.settleModes.push({ observeUntilDeadline, runId });
    this.events.push(`settle:${runId}:${String(value)}`);
    return settled(value);
  }

  public close(runId: string): SafeProcessEvidence {
    this.#closeCalls += 1;
    const confirmed = !(this.#options.firstCloseUnconfirmed === true && this.#closeCalls === 1);
    this.events.push(`close:${runId}:${confirmed ? 'confirmed' : 'unconfirmed'}`);
    return processEvidence(confirmed);
  }

  public shouldReturnUnknown(requestId: McpRequestId): boolean {
    return (
      this.#options.retryIsUnknown === true &&
      typeof requestId === 'string' &&
      requestId.endsWith(':retry')
    );
  }

  public progressToken(requested: number | string | undefined): number | string | undefined {
    if (this.#options.cancelUsesWrongToken === true) {
      return 'wrong-progress-token';
    }
    return requested;
  }

  public options(): ModelOptions {
    return this.#options;
  }
}

class ModelSession implements ExperimentSession {
  readonly #factory: ModelSessionFactory;
  readonly #listeners = new Set<(notification: ObservedServerNotification) => void>();
  readonly #run: ExpandedRun;
  readonly #scenario: Scenario;
  #parallelFirst: Deferred<ToolCallOutcome> | undefined;
  #disconnectGate:
    | {
        readonly closed: Deferred<ProcessCloseSummary>;
        readonly requestId: McpRequestId;
        readonly triggered: Deferred<{
          readonly receipt: TransportWriteReceipt;
          readonly requestId: McpRequestId;
          readonly responseIntercepted: boolean;
        }>;
      }
    | undefined;
  #suppression:
    | {
        readonly observation: Deferred<ToolResponseGateObservation>;
        readonly requestId: McpRequestId;
      }
    | undefined;

  public constructor(factory: ModelSessionFactory, run: ExpandedRun, scenario: Scenario) {
    this.#factory = factory;
    this.#run = run;
    this.#scenario = scenario;
  }

  public armDisconnectAfterWriteAccepted(
    requestId: McpRequestId,
  ): DisconnectGateLease<ProcessCloseSummary> {
    this.#factory.events.push(`arm-disconnect:${String(requestId)}`);
    const gate = {
      closed: deferred<ProcessCloseSummary>(),
      requestId,
      triggered: deferred<{
        readonly receipt: TransportWriteReceipt;
        readonly requestId: McpRequestId;
        readonly responseIntercepted: boolean;
      }>(),
    };
    this.#disconnectGate = gate;
    return {
      abort: () => false,
      closed: gate.closed.promise,
      requestId,
      triggered: gate.triggered.promise,
    };
  }

  public armSuccessfulToolResponse(requestId: McpRequestId): ToolResponseGateLease {
    this.#factory.events.push(`arm-suppress:${String(requestId)}`);
    const observation = deferred<ToolResponseGateObservation>();
    const gate = { observation, requestId };
    this.#suppression = gate;
    return {
      disarm: () => {
        if (this.#suppression !== gate) {
          return false;
        }
        this.#suppression = undefined;
        observation.reject(new Error('disarmed'));
        return true;
      },
      observation: observation.promise,
      requestId,
    };
  }

  public begin(_invocation: ExpandedInvocation, options: McpToolCallOptions): McpToolCallHandle {
    const requestId = options.requestId;
    if (requestId === undefined) {
      throw new Error('model requires an explicit request id');
    }
    this.#factory.events.push(`begin:${String(requestId)}`);
    const failingSuffix = this.#factory.options().beginFailsOn;
    if (
      failingSuffix !== undefined &&
      typeof requestId === 'string' &&
      requestId.endsWith(`:${failingSuffix}`)
    ) {
      throw new Error('model begin failure');
    }
    const receipt = Object.freeze({
      acceptedByLocalPipe: true,
      byteLength: 64,
      sequence: 1,
    }) satisfies TransportWriteReceipt;

    if (this.#disconnectGate?.requestId === requestId) {
      const gate = this.#disconnectGate;
      this.#factory.mutate(this.#run.runId);
      if (this.#factory.options().disconnectTriggerFails === true) {
        gate.triggered.reject(new FaultGateError('disconnect_not_applied'));
      } else {
        gate.triggered.resolve({
          receipt,
          requestId,
          responseIntercepted: true,
        });
      }
      gate.closed.resolve(
        processSummary(
          true,
          this.#factory.options().disconnectTerminatesNaturally === true ? 'natural' : 'disconnect',
        ),
      );
      const outcome = Promise.reject<ToolCallOutcome>(
        this.#factory.options().disconnectError ?? new McpTransportError(),
      );
      void outcome.catch(() => undefined);
      return {
        cancel: () => Promise.resolve(undefined),
        outcome,
        requestId,
        writeAccepted: Promise.resolve(receipt),
      };
    }

    if (this.#suppression?.requestId === requestId) {
      const gate = this.#suppression;
      this.#suppression = undefined;
      this.#factory.mutate(this.#run.runId);
      gate.observation.resolve({
        kind: 'suppressed',
        requestId,
        responseKind: 'tool_success',
      });
      const outcome = deferred<ToolCallOutcome>();
      return {
        cancel: () => {
          outcome.reject(new McpRequestAbortedError());
          if (this.#factory.options().suppressionCancelWriteHangs === true) {
            return deferred<TransportWriteReceipt | undefined>().promise;
          }
          return Promise.resolve({
            ...receipt,
            sequence: 2,
          });
        },
        outcome: outcome.promise,
        requestId,
        writeAccepted: Promise.resolve(receipt),
      };
    }

    const isCancel = typeof requestId === 'string' && requestId.endsWith(':cancel');
    if (isCancel) {
      const outcome = deferred<ToolCallOutcome>();
      const token = this.#factory.progressToken(options.progressToken);
      if (token !== undefined) {
        const notification: ObservedServerNotification = {
          method: 'notifications/progress',
          progress: 1,
          progressToken: token,
        };
        for (const listener of this.#listeners) {
          listener(notification);
        }
      }
      if (token !== options.progressToken) {
        outcome.resolve(successOutcome());
      }
      return {
        cancel: () => {
          this.#factory.cancel(this.#run.runId, this.#scenario.oracle.cancelledEffect ?? 0);
          outcome.reject(new McpRequestAbortedError());
          this.#factory.options().onCancelWrite?.();
          if (this.#factory.options().cancelWriteFails === true) {
            return Promise.reject(new McpTransportError());
          }
          if (this.#factory.options().cancelWriteHangs === true) {
            return deferred<TransportWriteReceipt | undefined>().promise;
          }
          return Promise.resolve({
            ...receipt,
            sequence: 2,
          });
        },
        outcome: outcome.promise,
        requestId,
        writeAccepted: Promise.resolve(receipt),
      };
    }

    const parallelLabel =
      typeof requestId === 'string' && requestId.endsWith(':parallel-a')
        ? 'a'
        : typeof requestId === 'string' && requestId.endsWith(':parallel-b')
          ? 'b'
          : undefined;
    const parallelMode = this.#factory.options().parallelMode;
    if (parallelLabel !== undefined && parallelMode !== undefined) {
      this.#factory.mutate(this.#run.runId);
      let outcome: Promise<ToolCallOutcome>;
      if (parallelLabel === 'a') {
        const first = deferred<ToolCallOutcome>();
        this.#parallelFirst = first;
        if (parallelMode === 'failure_then_delayed_success') {
          first.reject(new McpRequestTimeoutError());
        }
        outcome = first.promise;
      } else if (parallelMode === 'reverse_success') {
        const second = deferred<ToolCallOutcome>();
        outcome = second.promise;
        queueMicrotask(() => {
          this.#factory.events.push('parallel-release-b');
          second.resolve(successOutcome());
          queueMicrotask(() => {
            this.#factory.events.push('parallel-release-a');
            this.#parallelFirst?.resolve(successOutcome());
          });
        });
      } else {
        outcome = new Promise<ToolCallOutcome>((resolve) => {
          setTimeout(() => {
            this.#factory.events.push('parallel-release-b');
            resolve(successOutcome());
          }, 10);
        });
      }
      void outcome.catch(() => undefined);
      return {
        cancel: () => {
          if (parallelMode !== 'second_begin_failure') {
            return Promise.resolve(undefined);
          }
          this.#factory.events.push('parallel-cancel-started');
          return new Promise<undefined>((resolve) => {
            setTimeout(() => {
              this.#factory.events.push('parallel-peer-settled');
              this.#parallelFirst?.reject(new McpRequestAbortedError());
              resolve(undefined);
            }, 10);
          });
        },
        outcome,
        requestId,
        writeAccepted: Promise.resolve(receipt),
      };
    }

    this.#factory.mutate(this.#run.runId);
    const outcome = this.#factory.shouldReturnUnknown(requestId)
      ? Promise.reject<ToolCallOutcome>(new McpRequestTimeoutError())
      : Promise.resolve(successOutcome());
    void outcome.catch(() => undefined);
    return {
      cancel: () => Promise.resolve(undefined),
      outcome,
      requestId,
      writeAccepted: Promise.resolve(receipt),
    };
  }

  public call(invocation: ExpandedInvocation): Promise<ToolCallOutcome> {
    if (invocation.tool !== this.#run.reset.tool) {
      throw new Error('model supports only reset through call');
    }
    return Promise.resolve(this.#factory.reset(this.#run.runId));
  }

  public close(): Promise<SafeProcessEvidence> {
    const evidence = this.#factory.close(this.#run.runId);
    if (this.#disconnectGate === undefined) {
      return Promise.resolve(evidence);
    }
    return Promise.resolve(
      Object.freeze({
        ...evidence,
        termination:
          this.#factory.options().disconnectTerminatesNaturally === true ? 'natural' : 'disconnect',
      }),
    );
  }

  public settle(
    _signal?: AbortSignal,
    options?: { readonly observeUntilDeadline?: boolean },
  ): Promise<SettledProbe> {
    return Promise.resolve(
      this.#factory.settle(this.#run.runId, options?.observeUntilDeadline === true),
    );
  }

  public subscribe(listener: (notification: ObservedServerNotification) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

function scenarioWith(experiments: readonly ExperimentName[]): Scenario {
  const input = createValidScenario();
  input['experiments'] = [...experiments];
  return scenarioSchema.parse(input);
}

function dependencies(factory: ModelSessionFactory): ExperimentRunnerDependencies {
  return {
    createRunId: (_scenario, experiment, ordinal) => `run-${String(ordinal)}-${experiment}`,
    sessions: factory,
  };
}

function successOutcome(): ToolCallOutcome {
  return {
    kind: 'success',
    result: {
      content: [],
    },
  };
}

function settled(value: number): SettledProbe {
  return Object.freeze({
    evidence: Object.freeze({
      droppedSamples: 0,
      elapsedMs: 0,
      lastStreak: 2,
      lastValue: value,
      longestStreak: 2,
      samples: Object.freeze([]),
      totalSamples: 2,
      transitions: 0,
    }),
    kind: 'stable',
    value,
  });
}

function processEvidence(confirmed: boolean): SafeProcessEvidence {
  return Object.freeze({
    closeObserved: confirmed,
    code: confirmed ? 0 : null,
    directProcessTermination: confirmed ? 'confirmed' : 'unconfirmed',
    exitObserved: confirmed,
    processBoundary: 'declared-single-process',
    signal: null,
    stderrTotalBytes: 0,
    stderrTruncated: false,
    stdioDetached: !confirmed,
    termination: confirmed ? 'natural' : 'kill',
  });
}

function processSummary(confirmed: boolean, termination: ProcessTermination): ProcessCloseSummary {
  return {
    closeObserved: confirmed,
    code: confirmed ? 0 : null,
    directProcessTermination: confirmed ? 'confirmed' : 'unconfirmed',
    exitObserved: confirmed,
    signal: null,
    stderr: {
      text: '',
      totalBytes: 0,
      truncated: false,
    },
    stdioDetached: !confirmed,
    stdoutEnded: confirmed,
    termination,
  };
}

describe('runScenarioExperiments', () => {
  it('runs all seven experiments with fresh run scopes and proven cleanup', async () => {
    const factory = new ModelSessionFactory();
    const scenario = scenarioWith(EXPERIMENT_NAMES);

    const suite = await runScenarioExperiments(scenario, dependencies(factory));

    expect(suite.status).toBe('pass');
    expect(suite.halted).toBe(false);
    expect(suite.counts).toEqual({
      inconclusive: 0,
      passed: 7,
      violations: 0,
    });
    expect(suite.results).toHaveLength(7);
    expect(suite.results.map((result) => result.experiment)).toEqual(EXPERIMENT_NAMES);
    expect(
      suite.results.every(
        (result) => result.conclusion.kind === 'pass' && result.cleanup.kind === 'clean',
      ),
    ).toBe(true);
    expect(new Set(suite.results.map((result) => result.runId)).size).toBe(7);

    const parallelRun = suite.results.find((result) => result.experiment === 'parallel_new_ids');
    expect(parallelRun?.fault).toMatchObject({
      kind: 'parallel_new_ids',
    });
    const parallelBegins = factory.events.filter((event) =>
      event.includes('parallel_new_ids:parallel-'),
    );
    expect(parallelBegins).toHaveLength(2);
  });

  it('uses a fresh cleanup process to quiesce externally persistent effects', async () => {
    const factory = new ModelSessionFactory();
    const suite = await runScenarioExperiments(
      scenarioWith(['suppress_completed_response']),
      dependencies(factory),
    );

    expect(suite.status).toBe('pass');
    expect([...factory.opensByRun.values()]).toEqual([2]);
  });

  it('observes parallel attempts that complete in reverse order', async () => {
    const factory = new ModelSessionFactory({ parallelMode: 'reverse_success' });
    const suite = await runScenarioExperiments(
      scenarioWith(['parallel_new_ids']),
      dependencies(factory),
    );

    expect(suite.status).toBe('pass');
    expect(factory.events.indexOf('parallel-release-b')).toBeLessThan(
      factory.events.indexOf('parallel-release-a'),
    );
  });

  it('waits for the delayed parallel peer before classifying and cleaning up', async () => {
    const factory = new ModelSessionFactory({
      parallelMode: 'failure_then_delayed_success',
    });
    const suite = await runScenarioExperiments(
      scenarioWith(['parallel_new_ids']),
      dependencies(factory),
    );

    expect(suite.results[0]?.conclusion).toEqual({
      kind: 'inconclusive',
      phase: 'fault',
      reason: 'unexpected_unknown',
    });
    const delayedRelease = factory.events.indexOf('parallel-release-b');
    const cleanupReset = factory.events.findIndex((event) => event.endsWith(':2'));
    expect(delayedRelease).toBeGreaterThan(-1);
    expect(cleanupReset).toBeGreaterThan(delayedRelease);
  });

  it('cancels and boundedly settles the first peer when the second parallel begin fails', async () => {
    const factory = new ModelSessionFactory({
      beginFailsOn: 'parallel-b',
      parallelMode: 'second_begin_failure',
    });
    const suite = await runScenarioExperiments(
      scenarioWith(['parallel_new_ids']),
      dependencies(factory),
    );

    expect(suite.results[0]?.conclusion).toEqual({
      kind: 'inconclusive',
      phase: 'fault',
      reason: 'target_failed',
    });
    const cancellation = factory.events.indexOf('parallel-cancel-started');
    const peerSettled = factory.events.indexOf('parallel-peer-settled');
    const cleanupReset = factory.events.findIndex((event) => event.endsWith(':2'));
    expect(cancellation).toBeGreaterThan(-1);
    expect(peerSettled).toBeGreaterThan(cancellation);
    expect(cleanupReset).toBeGreaterThan(peerSettled);
  });

  it('does not send an exercise when the setup reset fails', async () => {
    const factory = new ModelSessionFactory({ firstResetFails: true });
    const suite = await runScenarioExperiments(
      scenarioWith(['suppress_completed_response']),
      dependencies(factory),
    );

    expect(suite.results[0]?.conclusion).toEqual({
      kind: 'inconclusive',
      phase: 'reset',
      reason: 'target_failed',
    });
    expect(factory.events.some((event) => event.startsWith('begin:'))).toBe(false);
  });

  it('does not send an exercise when the stable baseline is wrong', async () => {
    const factory = new ModelSessionFactory({ firstBaselineValue: 9 });
    const suite = await runScenarioExperiments(
      scenarioWith(['suppress_completed_response']),
      dependencies(factory),
    );

    expect(suite.results[0]?.conclusion).toEqual({
      kind: 'inconclusive',
      phase: 'baseline',
      reason: 'target_failed',
    });
    expect(factory.events.some((event) => event.startsWith('begin:'))).toBe(false);
  });

  it('classifies a stable unexpected final value as a contract violation', async () => {
    const factory = new ModelSessionFactory({ mutationValue: 2 });
    const suite = await runScenarioExperiments(
      scenarioWith(['suppress_completed_response']),
      dependencies(factory),
    );

    expect(suite.status).toBe('violation');
    expect(suite.results[0]?.conclusion).toEqual({
      expected: 1,
      kind: 'violation',
      observed: 2,
      phase: 'final_effect',
    });
  });

  it('keeps an unknown retry inconclusive even if cleanup succeeds', async () => {
    const factory = new ModelSessionFactory({ retryIsUnknown: true });
    const suite = await runScenarioExperiments(
      scenarioWith(['retry_new_id']),
      dependencies(factory),
    );

    expect(suite.results[0]?.conclusion).toEqual({
      kind: 'inconclusive',
      phase: 'retry',
      reason: 'unexpected_unknown',
    });
    expect(suite.results[0]?.cleanup.kind).toBe('clean');
    expect(suite.results[0]?.fault).toMatchObject({
      kind: 'retry_new_id',
    });
  });

  it.each([
    ['seed', 'seed'],
    ['retry', 'retry'],
  ] as const)(
    'retains the %s phase when begin throws synchronously',
    async (failingPhase, phase) => {
      const factory = new ModelSessionFactory({ beginFailsOn: failingPhase });
      const suite = await runScenarioExperiments(
        scenarioWith(['retry_new_id']),
        dependencies(factory),
      );

      expect(suite.results[0]?.conclusion).toEqual({
        kind: 'inconclusive',
        phase,
        reason: 'target_failed',
      });
    },
  );

  it('requires a matching progress token before claiming cancellation', async () => {
    const factory = new ModelSessionFactory({
      cancelUsesWrongToken: true,
    });
    const suite = await runScenarioExperiments(
      scenarioWith(['cancel_on_progress']),
      dependencies(factory),
    );

    expect(suite.results[0]?.fault).toEqual({
      kind: 'not_proven',
      reason: 'missing_progress',
    });
    expect(suite.results[0]?.conclusion).toEqual({
      kind: 'inconclusive',
      phase: 'fault',
      reason: 'fault_not_proven',
    });
  });

  it('uses full-deadline observation for every pass-critical cancellation probe', async () => {
    const factory = new ModelSessionFactory();
    const suite = await runScenarioExperiments(
      scenarioWith(['cancel_on_progress']),
      dependencies(factory),
    );

    expect(suite.status).toBe('pass');
    expect(factory.settleModes).toEqual([
      {
        observeUntilDeadline: true,
        runId: 'run-1-cancel_on_progress',
      },
      {
        observeUntilDeadline: true,
        runId: 'run-1-cancel_on_progress',
      },
      {
        observeUntilDeadline: true,
        runId: 'run-1-cancel_on_progress',
      },
      {
        observeUntilDeadline: true,
        runId: 'run-1-cancel_on_progress',
      },
    ]);
  });

  it.each([
    ['a rejected cancellation write', { cancelWriteFails: true }],
    ['a cancellation write that misses its deadline', { cancelWriteHangs: true }],
  ] as const)('does not claim cancellation when %s', async (_label, options) => {
    const factory = new ModelSessionFactory(options);
    const suite = await runScenarioExperiments(
      scenarioWith(['cancel_on_progress']),
      dependencies(factory),
    );

    expect(suite.results[0]?.fault).toEqual({
      kind: 'not_proven',
      reason: 'write_not_accepted',
    });
    expect(suite.results[0]?.conclusion).toEqual({
      kind: 'inconclusive',
      phase: 'fault',
      reason: 'fault_not_proven',
    });
  });

  it('bounds the suppressed-request cancellation write before cleanup', async () => {
    const factory = new ModelSessionFactory({ suppressionCancelWriteHangs: true });
    const suite = await runScenarioExperiments(
      scenarioWith(['suppress_completed_response']),
      dependencies(factory),
    );

    expect(suite.results[0]?.conclusion).toEqual({
      kind: 'inconclusive',
      phase: 'seed',
      reason: 'target_failed',
    });
    expect(suite.results[0]?.cleanup.kind).toBe('clean');
  });

  it('preserves the active fault phase when cancellation is externally aborted', async () => {
    const cancellationIssued = deferred<boolean>();
    const controller = new AbortController();
    const factory = new ModelSessionFactory({
      cancelWriteHangs: true,
      onCancelWrite: () => {
        cancellationIssued.resolve(true);
      },
    });
    const running = runScenarioExperiments(
      scenarioWith(['cancel_on_progress', 'parallel_new_ids']),
      dependencies(factory),
      { signal: controller.signal },
    );
    await cancellationIssued.promise;
    controller.abort();

    const suite = await running;

    expect(suite.results).toHaveLength(1);
    expect(suite.halted).toBe(true);
    expect(suite.results[0]?.conclusion).toEqual({
      kind: 'inconclusive',
      phase: 'fault',
      reason: 'aborted',
    });
  });

  it('requires the disconnect outcome to be caused by the transport boundary', async () => {
    const factory = new ModelSessionFactory({
      disconnectError: new McpProtocolError('malformed target response'),
    });
    const suite = await runScenarioExperiments(
      scenarioWith(['disconnect_after_request_write_accepted']),
      dependencies(factory),
    );

    expect(suite.results[0]?.fault).toEqual({
      kind: 'not_proven',
      reason: 'unexpected_outcome',
    });
    expect(suite.results[0]?.conclusion).toEqual({
      kind: 'inconclusive',
      phase: 'fault',
      reason: 'fault_not_proven',
    });
  });

  it('does not retry when transport failure precedes the disconnect injection', async () => {
    const factory = new ModelSessionFactory({
      disconnectTriggerFails: true,
    });
    const suite = await runScenarioExperiments(
      scenarioWith(['disconnect_after_request_write_accepted']),
      dependencies(factory),
    );

    expect(suite.results[0]?.fault).toEqual({
      kind: 'not_proven',
      reason: 'unexpected_outcome',
    });
    expect(suite.results[0]?.conclusion).toEqual({
      kind: 'inconclusive',
      phase: 'fault',
      reason: 'fault_not_proven',
    });
    expect(factory.events.some((event) => event.endsWith(':retry'))).toBe(false);
  });

  it('does not retry when the target terminates naturally instead of being disconnected', async () => {
    const factory = new ModelSessionFactory({
      disconnectTerminatesNaturally: true,
    });
    const suite = await runScenarioExperiments(
      scenarioWith(['disconnect_after_request_write_accepted']),
      dependencies(factory),
    );

    expect(suite.results[0]?.fault).toEqual({
      kind: 'not_proven',
      reason: 'unexpected_outcome',
    });
    expect(suite.results[0]?.conclusion).toEqual({
      kind: 'inconclusive',
      phase: 'fault',
      reason: 'fault_not_proven',
    });
    expect(factory.events.some((event) => event.endsWith(':retry'))).toBe(false);
  });

  it('rejects a restart result when external state disappears before retry', async () => {
    const factory = new ModelSessionFactory({ loseStateOnSecondOpen: true });
    const suite = await runScenarioExperiments(
      scenarioWith(['restart_after_suppressed_response']),
      dependencies(factory),
    );

    expect(suite.results[0]?.boundary).toMatchObject({ value: 0 });
    expect(suite.results[0]?.conclusion).toEqual({
      kind: 'inconclusive',
      phase: 'boundary',
      reason: 'target_failed',
    });
    expect(
      factory.events.some((event) => event.includes('restart_after_suppressed_response:retry')),
    ).toBe(false);
  });

  it('rejects a disconnect result when external state disappears before retry', async () => {
    const factory = new ModelSessionFactory({ loseStateOnSecondOpen: true });
    const suite = await runScenarioExperiments(
      scenarioWith(['disconnect_after_request_write_accepted']),
      dependencies(factory),
    );

    expect(suite.results[0]?.boundary).toMatchObject({ value: 0 });
    expect(suite.results[0]?.conclusion).toEqual({
      kind: 'inconclusive',
      phase: 'boundary',
      reason: 'target_failed',
    });
    expect(
      factory.events.some((event) =>
        event.includes('disconnect_after_request_write_accepted:retry'),
      ),
    ).toBe(false);
  });

  it('reuses an RPC ID only after opening a new connection epoch', async () => {
    const factory = new ModelSessionFactory();
    const suite = await runScenarioExperiments(
      scenarioWith(['rpc_id_reuse']),
      dependencies(factory),
    );

    expect(suite.status).toBe('pass');
    expect([...factory.opensByRun.values()]).toEqual([3]);
    expect(suite.results[0]?.boundary).toMatchObject({ value: 1 });
    expect(suite.results[0]?.fault).toMatchObject({
      kind: 'rpc_id_reuse',
      oldProcess: {
        directProcessTermination: 'confirmed',
      },
    });
  });

  it('halts before opening another process when direct termination is unconfirmed', async () => {
    const factory = new ModelSessionFactory({
      firstCloseUnconfirmed: true,
    });
    const suite = await runScenarioExperiments(
      scenarioWith(['suppress_completed_response', 'parallel_new_ids']),
      dependencies(factory),
    );

    expect(suite.halted).toBe(true);
    expect(suite.results).toHaveLength(1);
    expect(suite.results[0]?.cleanup).toMatchObject({
      kind: 'failed',
      phase: 'close',
    });
    expect(factory.opensByRun.size).toBe(1);
  });

  it('halts when an opening failure cannot confirm target termination', async () => {
    const factory = new ModelSessionFactory({
      firstOpenTerminationUnproven: true,
    });
    const suite = await runScenarioExperiments(
      scenarioWith(['suppress_completed_response', 'parallel_new_ids']),
      dependencies(factory),
    );

    expect(suite.halted).toBe(true);
    expect(suite.results).toHaveLength(1);
    expect(suite.results[0]?.conclusion).toEqual({
      kind: 'inconclusive',
      phase: 'open',
      reason: 'termination_unproven',
    });
    expect(suite.results[0]?.cleanup).toEqual({
      kind: 'failed',
      phase: 'close',
    });
    expect(factory.events.filter((event) => event.startsWith('open:'))).toHaveLength(1);
  });

  it.each(['termination_unproven', 'termination_failed'] as const)(
    'prioritizes initial %s evidence over a concurrent abort',
    async (reason) => {
      const controller = new AbortController();
      const factory = new ModelSessionFactory({
        abortOnInitialTerminationFailure: () => {
          controller.abort();
        },
        firstOpenTerminationFailure: reason,
      });

      const suite = await runScenarioExperiments(
        scenarioWith(['suppress_completed_response', 'parallel_new_ids']),
        dependencies(factory),
        { signal: controller.signal },
      );

      expect(suite.results[0]?.conclusion).toEqual({
        kind: 'inconclusive',
        phase: 'open',
        reason: 'termination_unproven',
      });
      expect(suite.halted).toBe(true);
      expect(suite.results).toHaveLength(1);
    },
  );

  it('classifies an abort during an additional open ahead of a generic target failure', async () => {
    const controller = new AbortController();
    const factory = new ModelSessionFactory({
      abortOnAdditionalOpen: () => {
        controller.abort();
      },
    });

    const suite = await runScenarioExperiments(
      scenarioWith(['restart_after_suppressed_response', 'parallel_new_ids']),
      dependencies(factory),
      { signal: controller.signal },
    );

    expect(suite.results[0]?.conclusion).toEqual({
      kind: 'inconclusive',
      phase: 'open',
      reason: 'aborted',
    });
    expect(suite.results).toHaveLength(1);
    expect(suite.halted).toBe(true);
  });

  it('halts when a cleanup-session open cannot prove target termination', async () => {
    const factory = new ModelSessionFactory({
      cleanupOpenTerminationFails: true,
      retryIsUnknown: true,
    });
    const suite = await runScenarioExperiments(
      scenarioWith(['retry_new_id', 'parallel_new_ids']),
      dependencies(factory),
    );

    expect(suite.halted).toBe(true);
    expect(suite.results).toHaveLength(1);
    expect(suite.results[0]?.cleanup).toEqual({
      kind: 'failed',
      phase: 'open',
    });
  });

  it('reports cleanup failure separately from a proven experiment conclusion', async () => {
    const factory = new ModelSessionFactory({ cleanupResetFails: true });
    const suite = await runScenarioExperiments(
      scenarioWith(['suppress_completed_response']),
      dependencies(factory),
    );

    expect(suite.results[0]?.conclusion.kind).toBe('pass');
    expect(suite.results[0]?.cleanup).toMatchObject({
      kind: 'failed',
      phase: 'reset',
    });
    expect(suite.status).toBe('inconclusive');
  });

  it('honors a pre-aborted signal without opening a target session', async () => {
    const factory = new ModelSessionFactory();
    const controller = new AbortController();
    controller.abort();

    const suite = await runScenarioExperiments(
      scenarioWith(['suppress_completed_response', 'parallel_new_ids']),
      dependencies(factory),
      { signal: controller.signal },
    );

    expect(suite.results[0]?.conclusion).toEqual({
      kind: 'inconclusive',
      phase: 'open',
      reason: 'aborted',
    });
    expect(suite.results[0]?.cleanup).toEqual({ kind: 'not_needed' });
    expect(factory.opensByRun.size).toBe(0);
    expect(suite.results).toHaveLength(1);
    expect(suite.halted).toBe(true);
  });
});
