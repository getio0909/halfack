import type { ExperimentName } from '../config/scenario-schema.js';
import type { McpRequestId, McpProgressToken } from '../mcp/raw-client.js';
import type { SettledProbe } from '../oracle/settle.js';
import type { ProcessTermination } from '../transport/stdio-process.js';

export type AttemptCompletion =
  | {
      readonly kind: 'remote_rejected';
      readonly remoteCode: number;
    }
  | {
      readonly kind: 'success' | 'tool_error';
    }
  | {
      readonly kind: 'unknown';
      readonly reason:
        | 'aborted'
        | 'client_closed'
        | 'in_flight_interrupted'
        | 'protocol'
        | 'timeout'
        | 'transport'
        | 'unexpected';
    };

export type AttemptLabel =
  'cancelled_attempt' | 'disconnected_attempt' | 'parallel_a' | 'parallel_b' | 'retry' | 'seed';

export interface AttemptEvidence {
  readonly completion: AttemptCompletion;
  readonly label: AttemptLabel;
  readonly requestId: McpRequestId;
  readonly write?: {
    readonly byteLength: number;
    readonly sequence: number;
  };
}

export interface SafeProcessEvidence {
  readonly closeObserved: boolean;
  readonly code: number | null;
  readonly directProcessTermination: 'confirmed' | 'unconfirmed';
  readonly exitObserved: boolean;
  readonly processBoundary: 'declared-single-process';
  readonly signal: NodeJS.Signals | null;
  readonly stderrTotalBytes: number;
  readonly stderrTruncated: boolean;
  readonly stdioDetached: boolean;
  readonly termination: ProcessTermination;
}

export type FaultNotProvenReason =
  'completed_before_fault' | 'missing_progress' | 'unexpected_outcome' | 'write_not_accepted';

export type FaultEvidence =
  | {
      readonly firstId: McpRequestId;
      readonly kind: 'disconnect_after_request_write_accepted';
      readonly localDelivery: 'accepted';
      readonly oldProcess: SafeProcessEvidence;
      readonly responseIntercepted: boolean;
      readonly retryId: McpRequestId;
      readonly write: {
        readonly byteLength: number;
        readonly sequence: number;
      };
    }
  | {
      readonly firstId: McpRequestId;
      readonly kind: 'restart_after_suppressed_response';
      readonly oldProcess: SafeProcessEvidence;
      readonly retryId: McpRequestId;
    }
  | {
      readonly firstId: McpRequestId;
      readonly kind: 'retry_new_id';
      readonly retryId: McpRequestId;
    }
  | {
      readonly ids: readonly [McpRequestId, McpRequestId];
      readonly kind: 'parallel_new_ids';
    }
  | {
      readonly cancellationWrite: {
        readonly byteLength: number;
        readonly sequence: number;
      };
      readonly kind: 'cancel_on_progress';
      readonly progress: number;
      readonly progressToken: McpProgressToken;
      readonly requestId: McpRequestId;
    }
  | {
      readonly kind: 'not_proven';
      readonly reason: FaultNotProvenReason;
    }
  | {
      readonly kind: 'rpc_id_reuse';
      readonly oldProcess: SafeProcessEvidence;
      readonly reusedId: McpRequestId;
    }
  | {
      readonly kind: 'suppress_completed_response';
      readonly seedId: McpRequestId;
    };

export type InconclusivePhase =
  'baseline' | 'boundary' | 'fault' | 'observe' | 'open' | 'reset' | 'retry' | 'seed';

export type InconclusiveReason =
  | 'aborted'
  | 'fault_not_proven'
  | 'probe_failed'
  | 'probe_unsettled'
  | 'target_failed'
  | 'termination_unproven'
  | 'unexpected_unknown';

export type ExperimentConclusion =
  | {
      readonly expected: number;
      readonly kind: 'pass';
      readonly observed: number;
    }
  | {
      readonly kind: 'inconclusive';
      readonly phase: InconclusivePhase;
      readonly reason: InconclusiveReason;
    }
  | {
      readonly expected: number;
      readonly kind: 'violation';
      readonly observed: number;
      readonly phase: 'final_effect' | 'seed_effect';
    };

export type CleanupEvidence =
  | {
      readonly kind: 'clean';
      readonly process: SafeProcessEvidence;
    }
  | {
      readonly kind: 'failed';
      readonly phase: 'close' | 'open' | 'reset' | 'settle';
      readonly process?: SafeProcessEvidence;
    }
  | {
      readonly kind: 'not_needed';
    };

export interface ExperimentResult {
  readonly attempts: readonly AttemptEvidence[];
  readonly baseline?: SettledProbe;
  readonly boundary?: SettledProbe;
  readonly cleanup: CleanupEvidence;
  readonly conclusion: ExperimentConclusion;
  readonly experiment: ExperimentName;
  readonly fault: FaultEvidence;
  readonly final?: SettledProbe;
  readonly runId: string;
  readonly seed?: SettledProbe;
}

export interface ExperimentSuiteResult {
  readonly counts: {
    readonly inconclusive: number;
    readonly passed: number;
    readonly violations: number;
  };
  readonly halted: boolean;
  readonly results: readonly ExperimentResult[];
  readonly scenario: string;
  readonly status: 'inconclusive' | 'pass' | 'violation';
}
