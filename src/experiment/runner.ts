import { randomUUID } from 'node:crypto';
import type { ExperimentName, Scenario } from '../config/scenario-schema.js';
import {
  McpClientClosedError,
  McpInFlightOutcomeUnknownError,
  McpProtocolError,
  McpRemoteError,
  McpRequestAbortedError,
  McpRequestTimeoutError,
  McpTransportError,
} from '../mcp/errors.js';
import type {
  McpProgressToken,
  McpRequestId,
  McpToolCallHandle,
  ObservedServerNotification,
  ToolCallOutcome,
} from '../mcp/raw-client.js';
import { ProbeAbortedError, ProbeSettleTimeoutError, type SettledProbe } from '../oracle/settle.js';
import type { TransportWriteReceipt } from '../transport/message-transport.js';
import { expandRun, type ExpandedRun } from './arguments.js';
import { FaultGateError } from './fault-gate.js';
import {
  ExperimentSessionError,
  StdioExperimentSessionFactory,
  type ExperimentSession,
  type ExperimentSessionFactory,
} from './session.js';
import type {
  AttemptCompletion,
  AttemptEvidence,
  AttemptLabel,
  CleanupEvidence,
  ExperimentConclusion,
  ExperimentResult,
  ExperimentSuiteResult,
  FaultEvidence,
  InconclusivePhase,
  InconclusiveReason,
  SafeProcessEvidence,
} from './types.js';

export interface ExperimentRunnerDependencies {
  readonly createRunId: (
    scenarioName: string,
    experiment: ExperimentName,
    ordinal: number,
  ) => string;
  readonly sessions: ExperimentSessionFactory;
}

export interface RunExperimentsOptions {
  readonly signal?: AbortSignal;
}

interface MutableExperimentState {
  readonly attempts: AttemptEvidence[];
  baseline: SettledProbe | undefined;
  boundary: SettledProbe | undefined;
  canSpawn: boolean;
  conclusion: ExperimentConclusion;
  fault: FaultEvidence;
  final: SettledProbe | undefined;
  openedAny: boolean;
  requiresFreshCleanup: boolean;
  seed: SettledProbe | undefined;
  session: ExperimentSession | undefined;
  unconfirmedProcess: SafeProcessEvidence | undefined;
}

interface SingleExperimentOutcome {
  readonly halted: boolean;
  readonly result: ExperimentResult;
}

interface StrategyContext {
  readonly experiment: ExperimentName;
  readonly options: RunExperimentsOptions;
  readonly run: ExpandedRun;
  readonly scenario: Scenario;
  readonly sessions: ExperimentSessionFactory;
  readonly state: MutableExperimentState;
}

class FlowFailure extends Error {
  public constructor(
    public readonly phase: InconclusivePhase,
    public readonly reason: InconclusiveReason,
  ) {
    super('The experiment could not reach a sound conclusion.');
    this.name = new.target.name;
  }
}

class RunnerDeadlineError extends Error {}
class RunnerAbortedError extends Error {
  public constructor(public readonly phase: InconclusivePhase) {
    super();
  }
}

export function createDefaultExperimentRunnerDependencies(): ExperimentRunnerDependencies {
  const dependencies: ExperimentRunnerDependencies = {
    createRunId: (scenarioName: string, experiment: ExperimentName, ordinal: number) =>
      `${safeIdFragment(scenarioName)}-${String(ordinal)}-${safeIdFragment(experiment)}-${randomUUID()}`,
    sessions: new StdioExperimentSessionFactory(),
  };
  return Object.freeze(dependencies);
}

export async function runScenarioExperiments(
  scenario: Scenario,
  dependencies: ExperimentRunnerDependencies,
  options: RunExperimentsOptions = {},
): Promise<ExperimentSuiteResult> {
  const results: ExperimentResult[] = [];
  let halted = false;

  for (const [index, experiment] of scenario.experiments.entries()) {
    const runId = dependencies.createRunId(scenario.name, experiment, index + 1);
    const run = expandRun(scenario, runId);
    const outcome = await runSingleExperiment(
      scenario,
      experiment,
      run,
      dependencies.sessions,
      options,
    );
    results.push(outcome.result);
    if (outcome.halted || options.signal?.aborted === true) {
      halted = true;
      break;
    }
  }

  const counts = {
    inconclusive: results.filter((result) => result.conclusion.kind === 'inconclusive').length,
    passed: results.filter((result) => result.conclusion.kind === 'pass').length,
    violations: results.filter((result) => result.conclusion.kind === 'violation').length,
  };
  const cleanupFailed = results.some((result) => result.cleanup.kind === 'failed');
  const status =
    counts.violations > 0
      ? 'violation'
      : counts.inconclusive > 0 || cleanupFailed || halted
        ? 'inconclusive'
        : 'pass';

  return Object.freeze({
    counts: Object.freeze(counts),
    halted,
    results: Object.freeze(results),
    scenario: scenario.name,
    status,
  });
}

async function runSingleExperiment(
  scenario: Scenario,
  experiment: ExperimentName,
  run: ExpandedRun,
  sessions: ExperimentSessionFactory,
  options: RunExperimentsOptions,
): Promise<SingleExperimentOutcome> {
  const state: MutableExperimentState = {
    attempts: [],
    baseline: undefined,
    boundary: undefined,
    canSpawn: true,
    conclusion: inconclusive('open', 'target_failed'),
    fault: notProven('unexpected_outcome'),
    final: undefined,
    openedAny: false,
    requiresFreshCleanup: false,
    seed: undefined,
    session: undefined,
    unconfirmedProcess: undefined,
  };

  try {
    assertNotAborted(options.signal, 'open');
    state.session = await sessions.open({
      run,
      scenario,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    state.openedAny = true;
    await prepareBaseline(state, run, scenario, options.signal);
    await runStrategy({
      experiment,
      options,
      run,
      scenario,
      sessions,
      state,
    });
  } catch (error: unknown) {
    const flow = normalizeFlowFailure(error, options.signal);
    state.conclusion = inconclusive(flow.phase, flow.reason);
    state.requiresFreshCleanup = true;
    if (flow.reason === 'termination_unproven') {
      state.canSpawn = false;
    }
  }

  const cleanup = await cleanupExperiment(state, run, scenario, sessions);
  const halted = !state.canSpawn;
  return {
    halted,
    result: Object.freeze({
      attempts: Object.freeze([...state.attempts]),
      ...(state.baseline === undefined ? {} : { baseline: state.baseline }),
      ...(state.boundary === undefined ? {} : { boundary: state.boundary }),
      cleanup,
      conclusion: Object.freeze(state.conclusion),
      experiment,
      fault: Object.freeze(state.fault),
      ...(state.final === undefined ? {} : { final: state.final }),
      runId: run.runId,
      ...(state.seed === undefined ? {} : { seed: state.seed }),
    }),
  };
}

async function prepareBaseline(
  state: MutableExperimentState,
  run: ExpandedRun,
  scenario: Scenario,
  signal: AbortSignal | undefined,
): Promise<void> {
  const session = requireSession(state, 'reset');
  const reset = await callKnownTool(
    session,
    run.reset,
    scenario.timeouts.requestMs,
    signal,
    'reset',
  );
  if (reset.kind !== 'success') {
    throw new FlowFailure('reset', 'target_failed');
  }

  state.baseline = await settleForPhase(session, signal, 'baseline');
  if (state.baseline.value !== scenario.oracle.baseline) {
    throw new FlowFailure('baseline', 'target_failed');
  }
}

async function runStrategy(context: StrategyContext): Promise<void> {
  switch (context.experiment) {
    case 'suppress_completed_response':
      await suppressCompletedResponse(context);
      return;
    case 'retry_new_id':
      await retryWithNewId(context);
      return;
    case 'rpc_id_reuse':
      await reuseRpcId(context);
      return;
    case 'restart_after_suppressed_response':
      await restartAfterSuppressedResponse(context);
      return;
    case 'parallel_new_ids':
      await parallelNewIds(context);
      return;
    case 'cancel_on_progress':
      await cancelOnProgress(context);
      return;
    case 'disconnect_after_request_write_accepted':
      await disconnectAfterWriteAccepted(context);
  }
}

async function suppressCompletedResponse(context: StrategyContext): Promise<void> {
  const seedId = requestId(context.run, 'seed');
  await runSuppressedSeed(context, seedId);
  context.state.fault = {
    kind: 'suppress_completed_response',
    seedId,
  };
  await concludeFromFinal(context, context.scenario.oracle.once);
}

async function retryWithNewId(context: StrategyContext): Promise<void> {
  const firstId = requestId(context.run, 'seed');
  const retryId = requestId(context.run, 'retry');
  await runSuppressedSeed(context, firstId);
  if (!(await verifySeedEffect(context))) {
    return;
  }

  const attempt = await runNormalAttempt(context, retryId, 'retry');
  context.state.attempts.push(attempt);
  context.state.fault = {
    firstId,
    kind: 'retry_new_id',
    retryId,
  };
  requireAcceptedKnownAttempt(attempt, 'retry');
  await concludeFromFinal(context, context.scenario.oracle.once);
}

async function reuseRpcId(context: StrategyContext): Promise<void> {
  const reusedId = requestId(context.run, 'reused');
  await runSuppressedSeed(context, reusedId);
  if (!(await verifySeedEffect(context))) {
    return;
  }

  const oldProcess = await closeCurrentSession(context.state, 'seed');
  context.state.session = await openAdditionalSession(context);
  await verifyPersistenceBoundary(context);
  const attempt = await runNormalAttempt(context, reusedId, 'retry');
  context.state.attempts.push(attempt);
  context.state.fault = {
    kind: 'rpc_id_reuse',
    oldProcess,
    reusedId,
  };
  requireAcceptedKnownAttempt(attempt, 'retry');
  await concludeFromFinal(context, context.scenario.oracle.once);
}

async function restartAfterSuppressedResponse(context: StrategyContext): Promise<void> {
  const firstId = requestId(context.run, 'seed');
  const retryId = requestId(context.run, 'retry');
  await runSuppressedSeed(context, firstId);
  if (!(await verifySeedEffect(context))) {
    return;
  }

  const oldProcess = await closeCurrentSession(context.state, 'seed');
  context.state.session = await openAdditionalSession(context);
  await verifyPersistenceBoundary(context);
  const attempt = await runNormalAttempt(context, retryId, 'retry');
  context.state.attempts.push(attempt);
  context.state.fault = {
    firstId,
    kind: 'restart_after_suppressed_response',
    oldProcess,
    retryId,
  };
  requireAcceptedKnownAttempt(attempt, 'retry');
  await concludeFromFinal(context, context.scenario.oracle.once);
}

async function parallelNewIds(context: StrategyContext): Promise<void> {
  const firstId = requestId(context.run, 'parallel-a');
  const secondId = requestId(context.run, 'parallel-b');
  const session = requireSession(context.state, 'fault');
  const first = beginExercise(context, session, firstId, 'fault');
  let second: McpToolCallHandle;
  try {
    second = beginExercise(context, session, secondId, 'fault');
  } catch (error: unknown) {
    const firstAttempt = await cancelAndObserveStartedPeer(
      first,
      context.scenario.timeouts.requestMs,
    );
    context.state.attempts.push(firstAttempt);
    throw error;
  }

  const [firstAttempt, secondAttempt] = await Promise.all([
    observeHandle(
      first,
      'parallel_a',
      context.scenario.timeouts.requestMs,
      context.options.signal,
      'fault',
    ),
    observeHandle(
      second,
      'parallel_b',
      context.scenario.timeouts.requestMs,
      context.options.signal,
      'fault',
    ),
  ]);
  context.state.attempts.push(firstAttempt, secondAttempt);
  requireAcceptedKnownAttempt(firstAttempt, 'fault');
  requireAcceptedKnownAttempt(secondAttempt, 'fault');
  context.state.fault = {
    ids: Object.freeze([firstId, secondId]),
    kind: 'parallel_new_ids',
  };
  await concludeFromFinal(context, context.scenario.oracle.once);
}

async function cancelOnProgress(context: StrategyContext): Promise<void> {
  const session = requireSession(context.state, 'fault');
  const requestIdValue = requestId(context.run, 'cancel');
  const progressToken = requestId(context.run, 'progress');
  const progressSeen = createDeferred<ObservedServerNotification>();
  let matchingNotification: ObservedServerNotification | undefined;
  let handle: McpToolCallHandle | undefined;
  let cancelIssued = false;
  let cancellationWrite: Promise<TransportWriteReceipt | undefined> | undefined;

  const issueCancellation = (): void => {
    if (cancelIssued || handle === undefined || matchingNotification === undefined) {
      return;
    }
    cancelIssued = true;
    context.state.requiresFreshCleanup = true;
    try {
      cancellationWrite = handle.cancel();
    } catch {
      cancellationWrite = Promise.reject(new McpTransportError());
    }
    void cancellationWrite.catch(() => undefined);
  };
  let unsubscribe: () => void;
  try {
    unsubscribe = session.subscribe((notification) => {
      if (
        matchingNotification !== undefined ||
        notification.method !== 'notifications/progress' ||
        notification.progressToken !== progressToken
      ) {
        return;
      }
      matchingNotification = notification;
      progressSeen.resolve(notification);
      issueCancellation();
    });
  } catch {
    throw new FlowFailure('fault', 'target_failed');
  }

  try {
    handle = beginExercise(context, session, requestIdValue, 'fault', progressToken);
    issueCancellation();
    const first = await awaitBounded(
      Promise.race([
        progressSeen.promise.then((notification) => ({ kind: 'progress', notification }) as const),
        handle.outcome.then(
          (outcome) => ({ kind: 'outcome', outcome }) as const,
          (error: unknown) => ({ error, kind: 'error' }) as const,
        ),
      ]),
      context.scenario.timeouts.requestMs,
      context.options.signal,
      'fault',
    );
    if (first.kind !== 'progress') {
      context.state.fault = notProven('missing_progress');
      if (first.kind === 'outcome') {
        context.state.attempts.push({
          completion: completionFromOutcome(first.outcome),
          label: 'cancelled_attempt',
          requestId: requestIdValue,
        });
      } else {
        context.state.attempts.push({
          completion: classifyAttemptError(first.error),
          label: 'cancelled_attempt',
          requestId: requestIdValue,
        });
      }
      throw new FlowFailure('fault', 'fault_not_proven');
    }

    issueCancellation();
    const attempt = await observeHandle(
      handle,
      'cancelled_attempt',
      context.scenario.timeouts.requestMs,
      context.options.signal,
      'fault',
    );
    context.state.attempts.push(attempt);
    if (attempt.completion.kind !== 'unknown' || attempt.completion.reason !== 'aborted') {
      context.state.fault = notProven('unexpected_outcome');
      throw new FlowFailure('fault', 'fault_not_proven');
    }

    const pendingCancellationWrite = cancellationWrite;
    if (pendingCancellationWrite === undefined) {
      context.state.fault = notProven('write_not_accepted');
      throw new FlowFailure('fault', 'fault_not_proven');
    }
    let cancellationReceipt: TransportWriteReceipt | undefined;
    try {
      cancellationReceipt = await awaitBounded(
        pendingCancellationWrite,
        context.scenario.timeouts.requestMs,
        context.options.signal,
        'fault',
      );
    } catch (error: unknown) {
      if (error instanceof RunnerAbortedError) {
        throw new FlowFailure('fault', 'aborted');
      }
      context.state.fault = notProven('write_not_accepted');
      throw new FlowFailure('fault', 'fault_not_proven');
    }
    if (cancellationReceipt === undefined) {
      context.state.fault = notProven('write_not_accepted');
      throw new FlowFailure('fault', 'fault_not_proven');
    }

    context.state.fault = {
      cancellationWrite: Object.freeze({
        byteLength: cancellationReceipt.byteLength,
        sequence: cancellationReceipt.sequence,
      }),
      kind: 'cancel_on_progress',
      progress: first.notification.progress ?? 0,
      progressToken,
      requestId: requestIdValue,
    };
    const expected = context.scenario.oracle.cancelledEffect;
    if (expected === undefined) {
      throw new FlowFailure('fault', 'target_failed');
    }
    context.state.final = await settleForPhase(session, context.options.signal, 'observe', true);
    context.state.conclusion =
      context.state.final.value === expected
        ? Object.freeze({
            expected,
            kind: 'pass',
            observed: context.state.final.value,
          })
        : Object.freeze({
            expected,
            kind: 'violation',
            observed: context.state.final.value,
            phase: 'final_effect',
          });
    if (context.scenario.persistence === 'process') {
      context.state.requiresFreshCleanup = false;
    }
  } catch (error: unknown) {
    if (error instanceof RunnerDeadlineError) {
      context.state.fault = notProven('missing_progress');
      throw new FlowFailure('fault', 'fault_not_proven');
    }
    throw error;
  } finally {
    unsubscribe();
  }
}

async function disconnectAfterWriteAccepted(context: StrategyContext): Promise<void> {
  const session = requireSession(context.state, 'fault');
  const firstId = requestId(context.run, 'disconnect');
  const retryId = requestId(context.run, 'retry');
  let gate: ReturnType<ExperimentSession['armDisconnectAfterWriteAccepted']>;
  try {
    gate = session.armDisconnectAfterWriteAccepted(firstId);
  } catch {
    throw new FlowFailure('fault', 'target_failed');
  }
  let handle: McpToolCallHandle | undefined;

  try {
    handle = beginExercise(context, session, firstId, 'fault');
    const [triggerResult, attempt] = await Promise.all([
      awaitBounded(
        gate.triggered,
        context.scenario.timeouts.requestMs,
        context.options.signal,
        'fault',
      ),
      observeHandle(
        handle,
        'disconnected_attempt',
        context.scenario.timeouts.requestMs,
        context.options.signal,
        'fault',
      ),
    ]);
    context.state.attempts.push(attempt);
    if (
      attempt.completion.kind !== 'unknown' ||
      attempt.completion.reason !== 'transport' ||
      attempt.write === undefined
    ) {
      context.state.fault = notProven('unexpected_outcome');
      throw new FlowFailure('fault', 'fault_not_proven');
    }

    const oldProcess = await closeCurrentSession(context.state, 'fault');
    if (oldProcess.termination === 'natural' || oldProcess.termination === 'stdin-eof') {
      context.state.fault = notProven('unexpected_outcome');
      throw new FlowFailure('fault', 'fault_not_proven');
    }
    context.state.session = await openAdditionalSession(context);
    await verifyPersistenceBoundary(context);
    const retry = await runNormalAttempt(context, retryId, 'retry');
    context.state.attempts.push(retry);
    requireAcceptedKnownAttempt(retry, 'retry');
    context.state.fault = {
      firstId,
      kind: 'disconnect_after_request_write_accepted',
      localDelivery: 'accepted',
      oldProcess,
      responseIntercepted: triggerResult.responseIntercepted,
      retryId,
      write: Object.freeze({
        byteLength: triggerResult.receipt.byteLength,
        sequence: triggerResult.receipt.sequence,
      }),
    };
    await concludeFromFinal(context, context.scenario.oracle.once);
  } catch (error: unknown) {
    gate.abort();
    if (error instanceof FaultGateError && error.reason === 'disconnect_not_applied') {
      context.state.fault = notProven('unexpected_outcome');
      throw new FlowFailure('fault', 'fault_not_proven');
    }
    if (error instanceof RunnerDeadlineError || error instanceof RunnerAbortedError) {
      context.state.fault = notProven('write_not_accepted');
    }
    throw error;
  }
}

async function runSuppressedSeed(context: StrategyContext, seedId: McpRequestId): Promise<void> {
  const session = requireSession(context.state, 'seed');
  let lease: ReturnType<ExperimentSession['armSuccessfulToolResponse']>;
  try {
    lease = session.armSuccessfulToolResponse(seedId);
  } catch {
    throw new FlowFailure('seed', 'target_failed');
  }
  let handle: McpToolCallHandle;
  try {
    handle = beginExercise(context, session, seedId, 'seed');
  } catch (error: unknown) {
    lease.disarm();
    throw error;
  }

  try {
    const first = await awaitBounded(
      Promise.race([
        lease.observation.then((observation) => ({ kind: 'observation', observation }) as const),
        handle.outcome.then(
          (outcome) => ({ kind: 'outcome', outcome }) as const,
          (error: unknown) => ({ error, kind: 'error' }) as const,
        ),
      ]),
      context.scenario.timeouts.requestMs,
      context.options.signal,
      'seed',
    );
    if (first.kind !== 'observation' || first.observation.kind !== 'suppressed') {
      context.state.fault = notProven('completed_before_fault');
      const completion =
        first.kind === 'outcome'
          ? completionFromOutcome(first.outcome)
          : first.kind === 'error'
            ? classifyAttemptError(first.error)
            : await awaitBounded(
                handle.outcome,
                context.scenario.timeouts.requestMs,
                context.options.signal,
                'seed',
              ).then(completionFromOutcome, classifyAttemptError);
      context.state.attempts.push({
        completion,
        label: 'seed',
        requestId: seedId,
      });
      throw new FlowFailure('fault', 'fault_not_proven');
    }

    const receipt = await awaitBounded(
      handle.writeAccepted,
      context.scenario.timeouts.requestMs,
      context.options.signal,
      'seed',
    );
    let cancellationReceipt: TransportWriteReceipt | undefined;
    try {
      cancellationReceipt = await awaitBounded(
        handle.cancel(),
        context.scenario.timeouts.requestMs,
        context.options.signal,
        'seed',
      );
    } catch (error: unknown) {
      if (error instanceof RunnerAbortedError) {
        throw new FlowFailure('seed', 'aborted');
      }
      throw new FlowFailure('seed', 'target_failed');
    }
    if (cancellationReceipt === undefined) {
      throw new FlowFailure('seed', 'target_failed');
    }
    const completion = await awaitBounded(
      handle.outcome.then(completionFromOutcome, classifyAttemptError),
      context.scenario.timeouts.requestMs,
      context.options.signal,
      'seed',
    );
    context.state.attempts.push({
      completion,
      label: 'seed',
      requestId: seedId,
      write: Object.freeze({
        byteLength: receipt.byteLength,
        sequence: receipt.sequence,
      }),
    });
    if (completion.kind !== 'unknown' || completion.reason !== 'aborted') {
      context.state.fault = notProven('unexpected_outcome');
      throw new FlowFailure('fault', 'fault_not_proven');
    }
  } catch (error: unknown) {
    if (error instanceof RunnerDeadlineError) {
      context.state.fault = notProven('unexpected_outcome');
      throw new FlowFailure('seed', 'unexpected_unknown');
    }
    if (error instanceof FlowFailure || error instanceof RunnerAbortedError) {
      throw error;
    }
    throw new FlowFailure('seed', 'target_failed');
  } finally {
    lease.disarm();
  }
}

async function verifySeedEffect(context: StrategyContext): Promise<boolean> {
  const session = requireSession(context.state, 'seed');
  context.state.seed = await settleForPhase(session, context.options.signal, 'seed');
  if (context.state.seed.value === context.scenario.oracle.once) {
    return true;
  }
  context.state.conclusion = Object.freeze({
    expected: context.scenario.oracle.once,
    kind: 'violation',
    observed: context.state.seed.value,
    phase: 'seed_effect',
  });
  return false;
}

async function verifyPersistenceBoundary(context: StrategyContext): Promise<void> {
  const session = requireSession(context.state, 'boundary');
  context.state.boundary = await settleForPhase(session, context.options.signal, 'boundary');
  if (context.state.boundary.value !== context.scenario.oracle.once) {
    throw new FlowFailure('boundary', 'target_failed');
  }
}

async function concludeFromFinal(context: StrategyContext, expected: number): Promise<void> {
  const session = requireSession(context.state, 'observe');
  context.state.final = await settleForPhase(session, context.options.signal, 'observe');
  context.state.conclusion =
    context.state.final.value === expected
      ? Object.freeze({
          expected,
          kind: 'pass',
          observed: context.state.final.value,
        })
      : Object.freeze({
          expected,
          kind: 'violation',
          observed: context.state.final.value,
          phase: 'final_effect',
        });
}

async function runNormalAttempt(
  context: StrategyContext,
  requestIdValue: McpRequestId,
  label: AttemptLabel,
): Promise<AttemptEvidence> {
  const session = requireSession(context.state, 'retry');
  const handle = beginExercise(context, session, requestIdValue, 'retry');
  return observeHandle(
    handle,
    label,
    context.scenario.timeouts.requestMs,
    context.options.signal,
    'retry',
  );
}

function beginExercise(
  context: StrategyContext,
  session: ExperimentSession,
  requestIdValue: McpRequestId,
  phase: InconclusivePhase,
  progressToken?: McpProgressToken,
): McpToolCallHandle {
  assertNotAborted(context.options.signal, phase);
  try {
    return session.begin(context.run.exercise, {
      ...(context.options.signal === undefined ? {} : { signal: context.options.signal }),
      ...(progressToken === undefined ? {} : { progressToken }),
      requestId: requestIdValue,
      timeoutMs: context.scenario.timeouts.requestMs,
    });
  } catch {
    assertNotAborted(context.options.signal, phase);
    throw new FlowFailure(phase, 'target_failed');
  }
}

async function observeHandle(
  handle: McpToolCallHandle,
  label: AttemptLabel,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  phase: InconclusivePhase,
): Promise<AttemptEvidence> {
  const [writeResult, outcomeResult] = await Promise.allSettled([
    awaitBounded(handle.writeAccepted, timeoutMs, signal, phase),
    awaitBounded(handle.outcome, timeoutMs, signal, phase),
  ]);
  const completion =
    outcomeResult.status === 'fulfilled'
      ? completionFromOutcome(outcomeResult.value)
      : classifyAttemptError(outcomeResult.reason);
  return Object.freeze({
    completion: Object.freeze(completion),
    label,
    requestId: handle.requestId,
    ...(writeResult.status === 'fulfilled'
      ? {
          write: Object.freeze({
            byteLength: writeResult.value.byteLength,
            sequence: writeResult.value.sequence,
          }),
        }
      : {}),
  });
}

async function cancelAndObserveStartedPeer(
  handle: McpToolCallHandle,
  timeoutMs: number,
): Promise<AttemptEvidence> {
  let cancellation: Promise<TransportWriteReceipt | undefined>;
  try {
    cancellation = handle.cancel();
  } catch (error: unknown) {
    cancellation = Promise.reject(
      error instanceof Error
        ? error
        : new Error('The parallel peer cancellation failed.', { cause: error }),
    );
  }
  void cancellation.catch(() => undefined);

  const [, attempt] = await Promise.allSettled([
    awaitBounded(cancellation, timeoutMs, undefined, 'fault'),
    observeHandle(handle, 'parallel_a', timeoutMs, undefined, 'fault'),
  ]);
  if (attempt.status === 'fulfilled') {
    return attempt.value;
  }
  return Object.freeze({
    completion: Object.freeze({
      kind: 'unknown',
      reason: 'unexpected',
    }),
    label: 'parallel_a',
    requestId: handle.requestId,
  });
}

function requireAcceptedKnownAttempt(attempt: AttemptEvidence, phase: 'fault' | 'retry'): void {
  if (attempt.write === undefined) {
    throw new FlowFailure(phase, 'target_failed');
  }
  if (attempt.completion.kind === 'unknown') {
    throw new FlowFailure(
      phase,
      attempt.completion.reason === 'aborted' ? 'aborted' : 'unexpected_unknown',
    );
  }
}

async function callKnownTool(
  session: ExperimentSession,
  invocation: ExpandedRun['reset'],
  timeoutMs: number,
  signal: AbortSignal | undefined,
  phase: InconclusivePhase,
): Promise<ToolCallOutcome> {
  assertNotAborted(signal, phase);
  try {
    return await session.call(invocation, {
      ...(signal === undefined ? {} : { signal }),
      timeoutMs,
    });
  } catch (error: unknown) {
    const completion = classifyAttemptError(error);
    throw new FlowFailure(
      phase,
      completion.kind === 'unknown' && completion.reason === 'aborted'
        ? 'aborted'
        : 'target_failed',
    );
  }
}

async function settleForPhase(
  session: ExperimentSession,
  signal: AbortSignal | undefined,
  phase: InconclusivePhase,
  observeUntilDeadline = true,
): Promise<SettledProbe> {
  assertNotAborted(signal, phase);
  try {
    return await session.settle(
      signal,
      observeUntilDeadline ? { observeUntilDeadline: true } : undefined,
    );
  } catch (error: unknown) {
    if (error instanceof ProbeAbortedError || signal?.aborted === true) {
      throw new FlowFailure(phase, 'aborted');
    }
    if (error instanceof ProbeSettleTimeoutError) {
      throw new FlowFailure(phase, 'probe_unsettled');
    }
    throw new FlowFailure(phase, 'probe_failed');
  }
}

async function openAdditionalSession(context: StrategyContext): Promise<ExperimentSession> {
  if (!context.state.canSpawn) {
    throw new FlowFailure('open', 'termination_unproven');
  }
  assertNotAborted(context.options.signal, 'open');
  try {
    const session = await context.sessions.open({
      run: context.run,
      scenario: context.scenario,
      ...(context.options.signal === undefined ? {} : { signal: context.options.signal }),
    });
    context.state.openedAny = true;
    return session;
  } catch (error: unknown) {
    const flow = normalizeFlowFailure(error, context.options.signal);
    if (flow.reason === 'termination_unproven') {
      context.state.canSpawn = false;
    }
    throw flow;
  }
}

async function closeCurrentSession(
  state: MutableExperimentState,
  phase: InconclusivePhase,
): Promise<SafeProcessEvidence> {
  const session = requireSession(state, phase);
  state.session = undefined;
  let process: SafeProcessEvidence;
  try {
    process = await session.close();
  } catch {
    state.canSpawn = false;
    throw new FlowFailure(phase, 'termination_unproven');
  }
  if (!isConfirmedProcessTermination(process)) {
    state.canSpawn = false;
    state.unconfirmedProcess = process;
    throw new FlowFailure(phase, 'termination_unproven');
  }
  return process;
}

async function cleanupExperiment(
  state: MutableExperimentState,
  run: ExpandedRun,
  scenario: Scenario,
  sessions: ExperimentSessionFactory,
): Promise<CleanupEvidence> {
  if (!state.openedAny) {
    return state.canSpawn
      ? Object.freeze({ kind: 'not_needed' })
      : Object.freeze({
          kind: 'failed',
          phase: 'close',
          ...(state.unconfirmedProcess === undefined ? {} : { process: state.unconfirmedProcess }),
        });
  }

  const currentSession = state.session;
  state.session = undefined;
  if (
    currentSession !== undefined &&
    !state.requiresFreshCleanup &&
    scenario.persistence === 'process'
  ) {
    return cleanAndCloseSession(state, currentSession, run, scenario, false);
  }

  if (currentSession !== undefined) {
    const closed = await closeCleanupSession(state, currentSession);
    if (closed.kind === 'failed') {
      return closed;
    }
  }

  if (!state.canSpawn) {
    return Object.freeze({
      kind: 'failed',
      phase: 'close',
      ...(state.unconfirmedProcess === undefined ? {} : { process: state.unconfirmedProcess }),
    });
  }

  let cleanupSession: ExperimentSession;
  try {
    cleanupSession = await sessions.open({ run, scenario });
  } catch (error: unknown) {
    if (error instanceof ExperimentSessionError && error.reason !== 'open_failed') {
      state.canSpawn = false;
    }
    return Object.freeze({
      kind: 'failed',
      phase: 'open',
    });
  }

  return cleanAndCloseSession(
    state,
    cleanupSession,
    run,
    scenario,
    scenario.persistence === 'external',
  );
}

async function cleanAndCloseSession(
  state: MutableExperimentState,
  session: ExperimentSession,
  run: ExpandedRun,
  scenario: Scenario,
  verifyDurableConclusion: boolean,
): Promise<CleanupEvidence> {
  let durableFailure: 'settle' | undefined;
  if (verifyDurableConclusion && state.conclusion.kind === 'pass') {
    try {
      const durable = await session.settle(undefined, {
        observeUntilDeadline: true,
      });
      state.final = durable;
      if (durable.value !== state.conclusion.expected) {
        state.conclusion = Object.freeze({
          expected: state.conclusion.expected,
          kind: 'violation',
          observed: durable.value,
          phase: 'final_effect',
        });
      }
    } catch {
      durableFailure = 'settle';
    }
  }
  const failurePhase = await resetAndVerifyCleanup(session, run, scenario);
  const closed = await closeCleanupSession(state, session);
  if (closed.kind === 'failed') {
    return closed;
  }
  if (durableFailure !== undefined || failurePhase !== undefined) {
    return Object.freeze({
      kind: 'failed',
      phase: durableFailure ?? failurePhase ?? 'settle',
      process: closed.process,
    });
  }
  return Object.freeze({
    kind: 'clean',
    process: closed.process,
  });
}

async function resetAndVerifyCleanup(
  session: ExperimentSession,
  run: ExpandedRun,
  scenario: Scenario,
): Promise<'reset' | 'settle' | undefined> {
  try {
    const reset = await session.call(run.reset, {
      timeoutMs: scenario.timeouts.requestMs,
    });
    if (reset.kind !== 'success') {
      return 'reset';
    }
    try {
      const settled = await session.settle(undefined, {
        observeUntilDeadline: true,
      });
      return settled.value === scenario.oracle.baseline ? undefined : 'settle';
    } catch {
      return 'settle';
    }
  } catch {
    return 'reset';
  }
}

async function closeCleanupSession(
  state: MutableExperimentState,
  session: ExperimentSession,
): Promise<
  | { readonly kind: 'closed'; readonly process: SafeProcessEvidence }
  | Extract<CleanupEvidence, { readonly kind: 'failed' }>
> {
  try {
    const process = await session.close();
    if (!isConfirmedProcessTermination(process)) {
      state.canSpawn = false;
      state.unconfirmedProcess = process;
      return Object.freeze({
        kind: 'failed',
        phase: 'close',
        process,
      });
    }
    return Object.freeze({
      kind: 'closed',
      process,
    });
  } catch {
    state.canSpawn = false;
    return Object.freeze({
      kind: 'failed',
      phase: 'close',
    });
  }
}

function isConfirmedProcessTermination(process: SafeProcessEvidence): boolean {
  return (
    process.directProcessTermination === 'confirmed' &&
    process.closeObserved &&
    process.exitObserved &&
    !process.stdioDetached
  );
}

function requireSession(
  state: MutableExperimentState,
  phase: InconclusivePhase,
): ExperimentSession {
  if (state.session === undefined) {
    throw new FlowFailure(phase, 'target_failed');
  }
  return state.session;
}

function completionFromOutcome(outcome: ToolCallOutcome): AttemptCompletion {
  return Object.freeze({ kind: outcome.kind });
}

function classifyAttemptError(error: unknown): AttemptCompletion {
  if (error instanceof McpRemoteError) {
    return Object.freeze({
      kind: 'remote_rejected',
      remoteCode: error.remoteCode,
    });
  }
  if (error instanceof McpRequestAbortedError || error instanceof RunnerAbortedError) {
    return Object.freeze({ kind: 'unknown', reason: 'aborted' });
  }
  if (error instanceof McpRequestTimeoutError || error instanceof RunnerDeadlineError) {
    return Object.freeze({ kind: 'unknown', reason: 'timeout' });
  }
  if (error instanceof McpTransportError) {
    return Object.freeze({ kind: 'unknown', reason: 'transport' });
  }
  if (error instanceof McpInFlightOutcomeUnknownError) {
    return Object.freeze({
      kind: 'unknown',
      reason: 'in_flight_interrupted',
    });
  }
  if (error instanceof McpClientClosedError) {
    return Object.freeze({ kind: 'unknown', reason: 'client_closed' });
  }
  if (error instanceof McpProtocolError) {
    return Object.freeze({ kind: 'unknown', reason: 'protocol' });
  }
  return Object.freeze({ kind: 'unknown', reason: 'unexpected' });
}

function normalizeFlowFailure(error: unknown, signal: AbortSignal | undefined): FlowFailure {
  if (error instanceof FlowFailure) {
    return error;
  }
  if (error instanceof ExperimentSessionError && error.reason !== 'open_failed') {
    return new FlowFailure('open', 'termination_unproven');
  }
  if (error instanceof RunnerAbortedError) {
    return new FlowFailure(error.phase, 'aborted');
  }
  if (signal?.aborted === true) {
    return new FlowFailure('open', 'aborted');
  }
  return new FlowFailure('open', 'target_failed');
}

function inconclusive(phase: InconclusivePhase, reason: InconclusiveReason): ExperimentConclusion {
  return Object.freeze({
    kind: 'inconclusive',
    phase,
    reason,
  });
}

function notProven(
  reason:
    'completed_before_fault' | 'missing_progress' | 'unexpected_outcome' | 'write_not_accepted',
): FaultEvidence {
  return Object.freeze({
    kind: 'not_proven',
    reason,
  });
}

function requestId(run: ExpandedRun, label: string): string {
  return `${run.runId}:${label}`;
}

function safeIdFragment(value: string): string {
  const fragment = value.replaceAll(/[^A-Za-z0-9._-]/gu, '-').slice(0, 32);
  return fragment.length === 0 ? 'halfack' : fragment;
}

function assertNotAborted(signal: AbortSignal | undefined, phase: InconclusivePhase): void {
  if (signal?.aborted === true) {
    throw new FlowFailure(phase, 'aborted');
  }
}

async function awaitBounded<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  phase: InconclusivePhase,
): Promise<T> {
  if (signal?.aborted === true) {
    throw new RunnerAbortedError(phase);
  }
  const boundary = createDeferred<never>();
  const timer = setTimeout(() => {
    boundary.reject(new RunnerDeadlineError());
  }, timeoutMs);
  const onAbort = (): void => {
    boundary.reject(new RunnerAbortedError(phase));
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    return await Promise.race([promise, boundary.promise]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (error: Error) => void;
  readonly resolve: (value: T) => void;
} {
  let rejectPromise!: (error: Error) => void;
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
