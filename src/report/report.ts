import { escapeDiagnosticText } from '../domain/diagnostic.js';
import { InternalError } from '../domain/errors.js';
import type {
  AttemptCompletion,
  AttemptEvidence,
  CleanupEvidence,
  ExperimentConclusion,
  ExperimentResult,
  ExperimentSuiteResult,
  FaultEvidence,
  SafeProcessEvidence,
} from '../experiment/types.js';
import type { ProbeEvidence, ProbeSampleEvidence, SettledProbe } from '../oracle/settle.js';
import { VERSION } from '../version.js';

export const REPORT_SCHEMA = 'halfack/report/v1' as const;

const MAX_REPORT_STRING_LENGTH = 16_384;
const JSON_UNSAFE_CHARACTER =
  /[\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/gu;

export interface HalfAckReport {
  readonly generatedAt: string;
  readonly schema: typeof REPORT_SCHEMA;
  readonly suite: ExperimentSuiteResult;
  readonly tool: {
    readonly name: 'halfack';
    readonly version: string;
  };
}

export function createReport(suite: ExperimentSuiteResult, generatedAt: Date): HalfAckReport {
  if (!Number.isFinite(generatedAt.getTime())) {
    throw new InternalError('Report generation date is invalid.');
  }

  let projectedSuite: ExperimentSuiteResult;
  try {
    projectedSuite = projectSuite(suite);
    assertSuiteInvariants(projectedSuite);
  } catch (error: unknown) {
    if (error instanceof InternalError) {
      throw error;
    }
    throw new InternalError('Experiment evidence could not be reported safely.', {
      cause: error,
    });
  }

  return Object.freeze({
    generatedAt: generatedAt.toISOString(),
    schema: REPORT_SCHEMA,
    suite: projectedSuite,
    tool: Object.freeze({
      name: 'halfack',
      version: VERSION,
    }),
  });
}

export function renderHumanReport(report: HalfAckReport): string {
  const { suite } = report;
  const lines = [
    `HalfAck ${escapeDiagnosticText(report.tool.version)}`,
    `Scenario: ${escapeDiagnosticText(suite.scenario)}`,
    `Generated: ${escapeDiagnosticText(report.generatedAt)}`,
    `Status: ${suite.status.toUpperCase()}`,
    `Summary: ${String(suite.counts.passed)} passed, ${String(
      suite.counts.violations,
    )} violations, ${String(suite.counts.inconclusive)} inconclusive`,
    `Halted: ${suite.halted ? 'yes (unreported experiments were not evaluated)' : 'no'}`,
    'Experiments:',
  ];

  for (const result of suite.results) {
    lines.push(`  ${renderResultLine(result)}`);
  }

  return `${lines.join('\n')}\n`;
}

export function renderJsonReport(report: HalfAckReport): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(report, undefined, 2);
  } catch (error: unknown) {
    throw new InternalError('The JSON report could not be serialized.', {
      cause: error,
    });
  }

  return `${serialized.replace(JSON_UNSAFE_CHARACTER, escapeJsonCodeUnit)}\n`;
}

function renderResultLine(result: ExperimentResult): string {
  const conclusion = renderConclusion(result.conclusion);
  const cleanup = renderCleanup(result.cleanup);
  const truncation = renderTruncation(result);
  return `[${conclusion.label}] ${result.experiment} run=${escapeDiagnosticText(
    result.runId,
  )}${conclusion.detail}${cleanup}${truncation}`;
}

function renderConclusion(conclusion: ExperimentConclusion): {
  readonly detail: string;
  readonly label: 'INCONCLUSIVE' | 'PASS' | 'VIOLATION';
} {
  switch (conclusion.kind) {
    case 'pass':
      return {
        detail: ` expected=${String(conclusion.expected)} observed=${String(conclusion.observed)}`,
        label: 'PASS',
      };
    case 'violation':
      return {
        detail: ` expected=${String(conclusion.expected)} observed=${String(
          conclusion.observed,
        )} phase=${conclusion.phase}`,
        label: 'VIOLATION',
      };
    case 'inconclusive':
      return {
        detail: ` phase=${conclusion.phase} reason=${conclusion.reason}`,
        label: 'INCONCLUSIVE',
      };
  }
}

function renderCleanup(cleanup: CleanupEvidence): string {
  switch (cleanup.kind) {
    case 'clean':
      return ' cleanup=clean';
    case 'not_needed':
      return ' cleanup=not_needed';
    case 'failed':
      return ` CLEANUP FAILED phase=${cleanup.phase}`;
  }
}

function renderTruncation(result: ExperimentResult): string {
  const probes = [result.baseline, result.boundary, result.seed, result.final];
  const droppedSamples = probes.reduce(
    (total, probe) => total + (probe?.evidence.droppedSamples ?? 0),
    0,
  );
  return droppedSamples === 0 ? '' : ` evidence_truncated=${String(droppedSamples)}`;
}

function projectSuite(suite: ExperimentSuiteResult): ExperimentSuiteResult {
  return Object.freeze({
    counts: Object.freeze({
      inconclusive: reportCount(suite.counts.inconclusive),
      passed: reportCount(suite.counts.passed),
      violations: reportCount(suite.counts.violations),
    }),
    halted: reportBoolean(suite.halted),
    results: Object.freeze(suite.results.map(projectResult)),
    scenario: reportString(suite.scenario),
    status: reportSuiteStatus(suite.status),
  });
}

function assertSuiteInvariants(suite: ExperimentSuiteResult): void {
  const actualCounts = {
    inconclusive: 0,
    passed: 0,
    violations: 0,
  };
  const experiments = new Set<string>();
  const runIds = new Set<string>();
  let cleanupFailed = false;

  for (const result of suite.results) {
    if (experiments.has(result.experiment) || runIds.has(result.runId)) {
      throw new TypeError('Report evidence contains duplicate experiment identity.');
    }
    experiments.add(result.experiment);
    runIds.add(result.runId);

    switch (result.conclusion.kind) {
      case 'pass':
        actualCounts.passed += 1;
        if (
          result.conclusion.observed !== result.conclusion.expected ||
          result.fault.kind === 'not_proven'
        ) {
          throw new TypeError('Report evidence contains an inconsistent passing conclusion.');
        }
        break;
      case 'violation':
        actualCounts.violations += 1;
        if (result.conclusion.observed === result.conclusion.expected) {
          throw new TypeError('Report evidence contains an inconsistent violation conclusion.');
        }
        break;
      case 'inconclusive':
        actualCounts.inconclusive += 1;
        break;
    }

    if (result.cleanup.kind === 'failed') {
      cleanupFailed = true;
    } else if (
      result.cleanup.kind === 'clean' &&
      !isConfirmedDirectProcess(result.cleanup.process)
    ) {
      throw new TypeError('Report evidence contains an inconsistent cleanup conclusion.');
    }
  }

  if (
    actualCounts.inconclusive !== suite.counts.inconclusive ||
    actualCounts.passed !== suite.counts.passed ||
    actualCounts.violations !== suite.counts.violations
  ) {
    throw new TypeError('Report evidence contains inconsistent result counts.');
  }

  const expectedStatus =
    actualCounts.violations > 0
      ? 'violation'
      : actualCounts.inconclusive > 0 || cleanupFailed || suite.halted
        ? 'inconclusive'
        : 'pass';
  if (suite.status !== expectedStatus) {
    throw new TypeError('Report evidence contains an inconsistent suite status.');
  }
}

function isConfirmedDirectProcess(process: SafeProcessEvidence): boolean {
  return (
    process.directProcessTermination === 'confirmed' &&
    process.closeObserved &&
    process.exitObserved &&
    !process.stdioDetached
  );
}

function projectResult(result: ExperimentResult): ExperimentResult {
  return Object.freeze({
    attempts: Object.freeze(result.attempts.map(projectAttempt)),
    ...(result.baseline === undefined ? {} : { baseline: projectProbe(result.baseline) }),
    ...(result.boundary === undefined ? {} : { boundary: projectProbe(result.boundary) }),
    cleanup: projectCleanup(result.cleanup),
    conclusion: projectConclusion(result.conclusion),
    experiment: reportExperiment(result.experiment),
    fault: projectFault(result.fault),
    ...(result.final === undefined ? {} : { final: projectProbe(result.final) }),
    runId: reportString(result.runId),
    ...(result.seed === undefined ? {} : { seed: projectProbe(result.seed) }),
  });
}

function projectAttempt(attempt: AttemptEvidence): AttemptEvidence {
  return Object.freeze({
    completion: projectCompletion(attempt.completion),
    label: reportAttemptLabel(attempt.label),
    requestId: reportRequestId(attempt.requestId),
    ...(attempt.write === undefined
      ? {}
      : {
          write: Object.freeze({
            byteLength: reportCount(attempt.write.byteLength),
            sequence: reportCount(attempt.write.sequence),
          }),
        }),
  });
}

function projectCompletion(completion: AttemptCompletion): AttemptCompletion {
  switch (completion.kind) {
    case 'success':
    case 'tool_error':
      return Object.freeze({ kind: completion.kind });
    case 'remote_rejected':
      return Object.freeze({
        kind: completion.kind,
        remoteCode: reportSafeInteger(completion.remoteCode),
      });
    case 'unknown':
      return Object.freeze({
        kind: completion.kind,
        reason: reportUnknownReason(completion.reason),
      });
  }
}

function projectConclusion(conclusion: ExperimentConclusion): ExperimentConclusion {
  switch (conclusion.kind) {
    case 'pass':
      return Object.freeze({
        expected: reportSafeInteger(conclusion.expected),
        kind: conclusion.kind,
        observed: reportSafeInteger(conclusion.observed),
      });
    case 'violation':
      return Object.freeze({
        expected: reportSafeInteger(conclusion.expected),
        kind: conclusion.kind,
        observed: reportSafeInteger(conclusion.observed),
        phase: conclusion.phase,
      });
    case 'inconclusive':
      return Object.freeze({
        kind: conclusion.kind,
        phase: conclusion.phase,
        reason: conclusion.reason,
      });
  }
}

function projectCleanup(cleanup: CleanupEvidence): CleanupEvidence {
  switch (cleanup.kind) {
    case 'not_needed':
      return Object.freeze({ kind: cleanup.kind });
    case 'clean':
      return Object.freeze({
        kind: cleanup.kind,
        process: projectProcess(cleanup.process),
      });
    case 'failed':
      return Object.freeze({
        kind: cleanup.kind,
        phase: cleanup.phase,
        ...(cleanup.process === undefined ? {} : { process: projectProcess(cleanup.process) }),
      });
  }
}

function projectProcess(process: SafeProcessEvidence): SafeProcessEvidence {
  return Object.freeze({
    closeObserved: reportBoolean(process.closeObserved),
    code: process.code === null ? null : reportSafeInteger(process.code),
    directProcessTermination: process.directProcessTermination,
    exitObserved: reportBoolean(process.exitObserved),
    processBoundary: process.processBoundary,
    signal: reportSignal(process.signal),
    stderrTotalBytes: reportCount(process.stderrTotalBytes),
    stderrTruncated: reportBoolean(process.stderrTruncated),
    stdioDetached: reportBoolean(process.stdioDetached),
    termination: process.termination,
  });
}

function projectFault(fault: FaultEvidence): FaultEvidence {
  switch (fault.kind) {
    case 'not_proven':
      return Object.freeze({
        kind: fault.kind,
        reason: fault.reason,
      });
    case 'suppress_completed_response':
      return Object.freeze({
        kind: fault.kind,
        seedId: reportRequestId(fault.seedId),
      });
    case 'retry_new_id':
      return Object.freeze({
        firstId: reportRequestId(fault.firstId),
        kind: fault.kind,
        retryId: reportRequestId(fault.retryId),
      });
    case 'rpc_id_reuse':
      return Object.freeze({
        kind: fault.kind,
        oldProcess: projectProcess(fault.oldProcess),
        reusedId: reportRequestId(fault.reusedId),
      });
    case 'restart_after_suppressed_response':
      return Object.freeze({
        firstId: reportRequestId(fault.firstId),
        kind: fault.kind,
        oldProcess: projectProcess(fault.oldProcess),
        retryId: reportRequestId(fault.retryId),
      });
    case 'parallel_new_ids':
      return Object.freeze({
        ids: Object.freeze([reportRequestId(fault.ids[0]), reportRequestId(fault.ids[1])] as const),
        kind: fault.kind,
      });
    case 'cancel_on_progress':
      return Object.freeze({
        cancellationWrite: Object.freeze({
          byteLength: reportCount(fault.cancellationWrite.byteLength),
          sequence: reportCount(fault.cancellationWrite.sequence),
        }),
        kind: fault.kind,
        progress: reportFiniteNumber(fault.progress),
        progressToken: reportProgressToken(fault.progressToken),
        requestId: reportRequestId(fault.requestId),
      });
    case 'disconnect_after_request_write_accepted':
      return Object.freeze({
        firstId: reportRequestId(fault.firstId),
        kind: fault.kind,
        localDelivery: fault.localDelivery,
        oldProcess: projectProcess(fault.oldProcess),
        responseIntercepted: reportBoolean(fault.responseIntercepted),
        retryId: reportRequestId(fault.retryId),
        write: Object.freeze({
          byteLength: reportCount(fault.write.byteLength),
          sequence: reportCount(fault.write.sequence),
        }),
      });
  }
}

function projectProbe(probe: SettledProbe): SettledProbe {
  return Object.freeze({
    evidence: projectProbeEvidence(probe.evidence),
    kind: 'stable',
    value: reportSafeInteger(probe.value),
  });
}

function projectProbeEvidence(evidence: ProbeEvidence): ProbeEvidence {
  return Object.freeze({
    droppedSamples: reportCount(evidence.droppedSamples),
    elapsedMs: reportFiniteNumber(evidence.elapsedMs),
    lastStreak: reportCount(evidence.lastStreak),
    ...(evidence.lastValue === undefined
      ? {}
      : { lastValue: reportSafeInteger(evidence.lastValue) }),
    longestStreak: reportCount(evidence.longestStreak),
    samples: Object.freeze(evidence.samples.map(projectProbeSample)),
    totalSamples: reportCount(evidence.totalSamples),
    transitions: reportCount(evidence.transitions),
  });
}

function projectProbeSample(sample: ProbeSampleEvidence): ProbeSampleEvidence {
  return Object.freeze({
    completedOffsetMs: reportFiniteNumber(sample.completedOffsetMs),
    sequence: reportCount(sample.sequence),
    startedOffsetMs: reportFiniteNumber(sample.startedOffsetMs),
    value: reportSafeInteger(sample.value),
  });
}

function reportBoolean(value: boolean): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError('Report evidence contains an invalid boolean.');
  }
  return value;
}

function reportString(value: string): string {
  if (typeof value !== 'string' || value.length > MAX_REPORT_STRING_LENGTH) {
    throw new TypeError('Report evidence contains an invalid string.');
  }
  return value;
}

function reportFiniteNumber(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) {
    throw new TypeError('Report evidence contains an invalid number.');
  }
  return value;
}

function reportSafeInteger(value: number): number {
  if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
    throw new TypeError('Report evidence contains an invalid integer.');
  }
  return value;
}

function reportCount(value: number): number {
  const count = reportSafeInteger(value);
  if (count < 0) {
    throw new TypeError('Report evidence contains an invalid count.');
  }
  return count;
}

function reportRequestId(value: number | string): number | string {
  return typeof value === 'number' ? reportSafeInteger(value) : reportString(value);
}

function reportProgressToken(value: number | string): number | string {
  return reportRequestId(value);
}

function reportSignal(value: NodeJS.Signals | null): NodeJS.Signals | null {
  if (value !== null) {
    reportString(value);
  }
  return value;
}

function reportSuiteStatus(value: unknown): ExperimentSuiteResult['status'] {
  switch (value) {
    case 'pass':
    case 'violation':
    case 'inconclusive':
      return value;
    default:
      throw new TypeError('Report evidence contains an invalid suite status.');
  }
}

function reportExperiment(value: ExperimentResult['experiment']): ExperimentResult['experiment'] {
  return value;
}

function reportAttemptLabel(value: AttemptEvidence['label']): AttemptEvidence['label'] {
  return value;
}

function reportUnknownReason(
  value: Extract<AttemptCompletion, { readonly kind: 'unknown' }>['reason'],
): Extract<AttemptCompletion, { readonly kind: 'unknown' }>['reason'] {
  return value;
}

function escapeJsonCodeUnit(value: string): string {
  return `\\u${value.charCodeAt(0).toString(16).padStart(4, '0')}`;
}
