import { TargetError } from '../domain/errors.js';
import type { Scenario } from '../config/scenario-schema.js';
import type {
  McpRequestOptions,
  McpToolCallHandle,
  McpToolCallOptions,
  ObservedServerNotification,
  ToolCallOutcome,
} from '../mcp/raw-client.js';
import { RawMcpClient } from '../mcp/raw-client.js';
import { requiredScenarioToolNames } from '../mcp/verify-scenario-tools.js';
import { createMcpProbeReader } from '../oracle/probe.js';
import { settleProbe, type SettledProbe } from '../oracle/settle.js';
import {
  StdioProcessTransport,
  TargetProcessStartError,
  type ProcessCloseSummary,
} from '../transport/stdio-process.js';
import type { DisconnectGateLease, ToolResponseGateLease } from './fault-gate.js';
import { McpFaultGateTransport } from './fault-gate.js';
import type { ExpandedInvocation, ExpandedRun } from './arguments.js';
import type { SafeProcessEvidence } from './types.js';

export class ExperimentSessionError extends TargetError {
  public constructor(
    public readonly reason: 'open_failed' | 'termination_failed' | 'termination_unproven',
  ) {
    super('The experiment session could not complete its lifecycle safely.');
  }
}

export interface OpenExperimentSessionInput {
  readonly run: ExpandedRun;
  readonly scenario: Scenario;
  readonly signal?: AbortSignal;
}

export interface ExperimentSession {
  armDisconnectAfterWriteAccepted(
    requestId: number | string,
  ): DisconnectGateLease<ProcessCloseSummary>;
  armSuccessfulToolResponse(requestId: number | string): ToolResponseGateLease;
  begin(invocation: ExpandedInvocation, options: McpToolCallOptions): McpToolCallHandle;
  call(invocation: ExpandedInvocation, options: McpRequestOptions): Promise<ToolCallOutcome>;
  close(): Promise<SafeProcessEvidence>;
  settle(signal?: AbortSignal, options?: ExperimentSettleOptions): Promise<SettledProbe>;
  subscribe(listener: (notification: ObservedServerNotification) => void): () => void;
}

export interface ExperimentSettleOptions {
  readonly observeUntilDeadline?: boolean;
}

export interface ExperimentSessionFactory {
  open(input: OpenExperimentSessionInput): Promise<ExperimentSession>;
}

export class StdioExperimentSessionFactory implements ExperimentSessionFactory {
  public async open(input: OpenExperimentSessionInput): Promise<ExperimentSession> {
    const { scenario, signal } = input;
    let transport: StdioProcessTransport | undefined;
    let gated: McpFaultGateTransport<ProcessCloseSummary> | undefined;
    let client: RawMcpClient | undefined;

    try {
      transport = await StdioProcessTransport.start({
        args: scenario.target.args,
        command: scenario.target.command,
        cwd: scenario.target.cwd,
        envAllowlist: scenario.target.envAllowlist,
        shutdownMs: scenario.timeouts.shutdownMs,
        ...(signal === undefined ? {} : { signal }),
        spawnEventTimeoutMs: scenario.timeouts.requestMs,
      });
      gated = new McpFaultGateTransport(transport);
      client = new RawMcpClient(gated, {
        requestTimeoutMs: scenario.timeouts.requestMs,
      });
      const requestOptions: McpRequestOptions = {
        ...(signal === undefined ? {} : { signal }),
        timeoutMs: scenario.timeouts.requestMs,
      };
      await client.discover(requestOptions);
      await client.requireTools(requiredScenarioToolNames(scenario), requestOptions);

      const reader = createMcpProbeReader(client, input.run.probe, scenario.probe.pointer);
      return new StdioExperimentSession(client, gated, reader, scenario);
    } catch (error: unknown) {
      if (
        error instanceof TargetProcessStartError &&
        error.directProcessTermination === 'unconfirmed'
      ) {
        throw new ExperimentSessionError('termination_unproven');
      }
      const cleanup = await closeOpenResources(client, gated, scenario);
      if (cleanup !== undefined && !isConfirmedProcessTermination(cleanup)) {
        throw new ExperimentSessionError('termination_unproven');
      }
      if (error instanceof ExperimentSessionError && error.reason !== 'open_failed') {
        throw error;
      }
      throw new ExperimentSessionError('open_failed');
    }
  }
}

class StdioExperimentSession implements ExperimentSession {
  readonly #client: RawMcpClient;
  readonly #gated: McpFaultGateTransport<ProcessCloseSummary>;
  readonly #reader: ReturnType<typeof createMcpProbeReader>;
  readonly #scenario: Scenario;
  #closePromise: Promise<SafeProcessEvidence> | undefined;

  public constructor(
    client: RawMcpClient,
    gated: McpFaultGateTransport<ProcessCloseSummary>,
    reader: ReturnType<typeof createMcpProbeReader>,
    scenario: Scenario,
  ) {
    this.#client = client;
    this.#gated = gated;
    this.#reader = reader;
    this.#scenario = scenario;
  }

  public armDisconnectAfterWriteAccepted(
    requestId: number | string,
  ): DisconnectGateLease<ProcessCloseSummary> {
    return this.#gated.armDisconnectAfterWriteAccepted(requestId);
  }

  public armSuccessfulToolResponse(requestId: number | string): ToolResponseGateLease {
    return this.#gated.armSuccessfulToolResponse(requestId);
  }

  public begin(invocation: ExpandedInvocation, options: McpToolCallOptions): McpToolCallHandle {
    return this.#client.beginToolCall(invocation.tool, invocation.arguments, options);
  }

  public call(
    invocation: ExpandedInvocation,
    options: McpRequestOptions,
  ): Promise<ToolCallOutcome> {
    return this.#client.callTool(invocation.tool, invocation.arguments, options);
  }

  public close(): Promise<SafeProcessEvidence> {
    this.#closePromise ??= this.#closeInternal();
    return this.#closePromise;
  }

  public settle(
    signal?: AbortSignal,
    options: ExperimentSettleOptions = {},
  ): Promise<SettledProbe> {
    return settleProbe(this.#reader, {
      intervalMs: this.#scenario.probe.settle.intervalMs,
      observeUntilDeadline: options.observeUntilDeadline ?? true,
      requestTimeoutMs: this.#scenario.timeouts.requestMs,
      ...(signal === undefined ? {} : { signal }),
      stableSamples: this.#scenario.probe.settle.stableSamples,
      timeoutMs: this.#scenario.probe.settle.timeoutMs,
    });
  }

  public subscribe(listener: (notification: ObservedServerNotification) => void): () => void {
    return this.#client.subscribeNotifications(listener);
  }

  async #closeInternal(): Promise<SafeProcessEvidence> {
    const processClose = this.#gated.close();
    const clientClose = this.#client.close();
    const [processResult, clientResult] = await Promise.allSettled([processClose, clientClose]);
    if (processResult.status === 'rejected' || clientResult.status === 'rejected') {
      throw new ExperimentSessionError('termination_failed');
    }
    return sanitizeProcessSummary(processResult.value, this.#scenario.safety.processBoundary);
  }
}

export function sanitizeProcessSummary(
  summary: ProcessCloseSummary,
  processBoundary: Scenario['safety']['processBoundary'],
): SafeProcessEvidence {
  return Object.freeze({
    closeObserved: summary.closeObserved,
    code: summary.code,
    directProcessTermination: summary.directProcessTermination,
    exitObserved: summary.exitObserved,
    processBoundary: `declared-${processBoundary}`,
    signal: summary.signal,
    stderrTotalBytes: summary.stderr.totalBytes,
    stderrTruncated: summary.stderr.truncated,
    stdioDetached: summary.stdioDetached,
    termination: summary.termination,
  });
}

function isConfirmedProcessTermination(summary: SafeProcessEvidence): boolean {
  return (
    summary.directProcessTermination === 'confirmed' &&
    summary.closeObserved &&
    summary.exitObserved &&
    !summary.stdioDetached
  );
}

async function closeOpenResources(
  client: RawMcpClient | undefined,
  gated: McpFaultGateTransport<ProcessCloseSummary> | undefined,
  scenario: Scenario,
): Promise<SafeProcessEvidence | undefined> {
  if (gated === undefined) {
    return undefined;
  }

  const processClose = gated.close();
  const clientClose = client?.close() ?? Promise.resolve();
  const [processResult] = await Promise.allSettled([processClose, clientClose]);
  if (processResult.status === 'rejected') {
    throw new ExperimentSessionError('termination_failed');
  }
  return sanitizeProcessSummary(processResult.value, scenario.safety.processBoundary);
}
