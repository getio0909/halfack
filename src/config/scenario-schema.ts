import { z } from 'zod/v4';
import {
  argumentPlaceholderIssues,
  commandPolicyIssues,
  cwdPolicyIssues,
  disallowedPlaceholderIssue,
  environmentPolicyIssues,
  isProcessWrapper,
  type PolicyIssue,
} from './security-policy.js';

export const MCP_PROTOCOL_VERSION = '2026-07-28';

export const EXPERIMENT_NAMES = [
  'suppress_completed_response',
  'retry_new_id',
  'rpc_id_reuse',
  'restart_after_suppressed_response',
  'parallel_new_ids',
  'cancel_on_progress',
  'disconnect_after_request_write_accepted',
] as const;

const MAX_ARGUMENTS = 128;
const MAX_ENVIRONMENT_NAMES = 64;
const MAX_TOOL_ARGUMENT_KEYS = 256;

const toolNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u, 'Tool name contains unsupported characters.');

const environmentNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_()]*$/u, 'Environment variable name is invalid.');

const targetArgumentSchema = z
  .string()
  .max(16_384)
  .refine((value) => !value.includes('\0'), {
    message: 'Target argument must not contain a null byte.',
  });

const toolArgumentsSchema = z
  .record(z.string().max(256), z.json())
  .refine((value) => Object.keys(value).length <= MAX_TOOL_ARGUMENT_KEYS, {
    message: `Tool arguments may contain at most ${String(MAX_TOOL_ARGUMENT_KEYS)} keys.`,
  })
  .default(() => ({}));

const toolInvocationSchema = z.strictObject({
  tool: toolNameSchema,
  arguments: toolArgumentsSchema,
});

const targetSchema = z
  .strictObject({
    transport: z.literal('stdio'),
    protocol: z.literal(MCP_PROTOCOL_VERSION),
    command: z.string().min(1).max(4_096),
    args: z
      .array(targetArgumentSchema)
      .max(MAX_ARGUMENTS)
      .default(() => []),
    cwd: z.string().max(4_096).default('.'),
    envAllowlist: z
      .array(environmentNameSchema)
      .max(MAX_ENVIRONMENT_NAMES)
      .default(() => []),
  })
  .superRefine((target, context) => {
    addPolicyIssues(context, commandPolicyIssues(target.command));
    addPolicyIssues(context, cwdPolicyIssues(target.cwd));
    addPolicyIssues(context, environmentPolicyIssues(target.envAllowlist));
  });

const settleSchema = z
  .strictObject({
    timeoutMs: z.number().int().min(100).max(120_000).default(2_000),
    intervalMs: z.number().int().min(10).max(10_000).default(100),
    stableSamples: z.number().int().min(1).max(100).default(2),
  })
  .superRefine((settle, context) => {
    if (settle.intervalMs >= settle.timeoutMs) {
      context.addIssue({
        code: 'custom',
        message: 'Settle interval must be shorter than its timeout.',
        path: ['intervalMs'],
      });
    }
    const stableWindowMs = (settle.stableSamples - 1) * settle.intervalMs;
    if (stableWindowMs >= settle.timeoutMs) {
      context.addIssue({
        code: 'custom',
        message: 'Stable sample window must fit entirely within the settle timeout.',
        path: ['stableSamples'],
      });
    }
  })
  .default(() => ({
    intervalMs: 100,
    stableSamples: 2,
    timeoutMs: 2_000,
  }));

const probeSchema = toolInvocationSchema.extend({
  pointer: z.string().min(1).max(1_024).refine(isStructuredContentPointer, {
    message: 'Probe pointer must be an RFC 6901 path rooted at /structuredContent.',
  }),
  settle: settleSchema,
});

const oracleValueSchema = z
  .number()
  .refine((value) => Number.isSafeInteger(value) && !Object.is(value, -0), {
    message: 'Oracle value must be a safe integer other than negative zero.',
  });

const oracleSchema = z.strictObject({
  baseline: oracleValueSchema,
  once: oracleValueSchema,
  cancelledEffect: oracleValueSchema.optional(),
});

const safetySchema = z.strictObject({
  disposable: z.literal(true),
  processBoundary: z.literal('single-process'),
});

const timeoutsSchema = z
  .strictObject({
    requestMs: z.number().int().min(100).max(120_000).default(3_000),
    shutdownMs: z.number().int().min(100).max(30_000).default(1_000),
  })
  .default(() => ({
    requestMs: 3_000,
    shutdownMs: 1_000,
  }));

export const scenarioSchema = z
  .strictObject({
    schema: z.literal('halfack/v1'),
    name: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, 'Scenario name must be a safe identifier.'),
    description: z.string().min(1).max(1_000).optional(),
    target: targetSchema,
    persistence: z.enum(['external', 'process']),
    exercise: toolInvocationSchema,
    reset: toolInvocationSchema,
    probe: probeSchema,
    oracle: oracleSchema,
    experiments: z
      .array(z.enum(EXPERIMENT_NAMES))
      .min(1)
      .max(EXPERIMENT_NAMES.length)
      .refine((values) => new Set(values).size === values.length, {
        message: 'Experiments must be unique.',
      }),
    safety: safetySchema,
    timeouts: timeoutsSchema,
  })
  .superRefine((scenario, context) => {
    if (scenario.oracle.baseline === scenario.oracle.once) {
      context.addIssue({
        code: 'custom',
        message: 'Oracle baseline and once values must differ.',
        path: ['oracle', 'once'],
      });
    }

    if (
      scenario.experiments.includes('cancel_on_progress') &&
      scenario.oracle.cancelledEffect === undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Cancellation experiments require a cancelled-effect oracle value.',
        path: ['oracle', 'cancelledEffect'],
      });
    }

    const hasRpcIdReuseExperiment = scenario.experiments.includes('rpc_id_reuse');
    const hasRestartExperiment = scenario.experiments.includes('restart_after_suppressed_response');
    const hasDisconnectExperiment = scenario.experiments.includes(
      'disconnect_after_request_write_accepted',
    );
    const requiresExternalProcessBoundary =
      hasRpcIdReuseExperiment || hasRestartExperiment || hasDisconnectExperiment;
    if (requiresExternalProcessBoundary && scenario.persistence !== 'external') {
      context.addIssue({
        code: 'custom',
        message:
          'RPC-ID reuse, restart, and disconnect experiments require persistence to be declared external.',
        path: ['persistence'],
      });
    }

    if (requiresExternalProcessBoundary && isProcessWrapper(scenario.target.command)) {
      context.addIssue({
        code: 'custom',
        message:
          'RPC-ID reuse, restart, and disconnect experiments require a direct executable, not a process wrapper.',
        path: ['target', 'command'],
      });
    }

    addInvocationPlaceholderIssues(context, scenario.exercise.arguments, ['exercise', 'arguments']);
    addInvocationPlaceholderIssues(context, scenario.reset.arguments, ['reset', 'arguments']);
    addInvocationPlaceholderIssues(context, scenario.probe.arguments, ['probe', 'arguments']);

    const placeholderForbiddenValues: readonly (readonly [
      readonly (number | string)[],
      string | undefined,
    ])[] = [
      [['description'], scenario.description],
      [['target', 'command'], scenario.target.command],
      [['target', 'cwd'], scenario.target.cwd],
      [['exercise', 'tool'], scenario.exercise.tool],
      [['reset', 'tool'], scenario.reset.tool],
      [['probe', 'tool'], scenario.probe.tool],
      [['probe', 'pointer'], scenario.probe.pointer],
      ...scenario.target.args.map((value, index) => [['target', 'args', index], value] as const),
      ...scenario.target.envAllowlist.map(
        (value, index) => [['target', 'envAllowlist', index], value] as const,
      ),
    ];

    for (const [issuePath, value] of placeholderForbiddenValues) {
      if (!value?.includes('${')) {
        continue;
      }
      const issue =
        disallowedPlaceholderIssue(value, issuePath) ??
        ({
          message: 'Placeholders are allowed only in tool argument values.',
          path: issuePath,
        } satisfies PolicyIssue);
      context.addIssue({
        code: 'custom',
        message: issue.message,
        path: [...issue.path],
      });
    }
  });

export type Scenario = z.output<typeof scenarioSchema>;
export type ScenarioInput = z.input<typeof scenarioSchema>;
export type ExperimentName = (typeof EXPERIMENT_NAMES)[number];

function addPolicyIssues(context: z.RefinementCtx, issues: readonly PolicyIssue[]): void {
  for (const issue of issues) {
    context.addIssue({
      code: 'custom',
      message: issue.message,
      path: [...issue.path],
    });
  }
}

function addInvocationPlaceholderIssues(
  context: z.RefinementCtx,
  arguments_: unknown,
  issuePath: readonly (number | string)[],
): void {
  addPolicyIssues(context, argumentPlaceholderIssues(arguments_, issuePath));
}

function isStructuredContentPointer(value: string): boolean {
  if (value !== '/structuredContent' && !value.startsWith('/structuredContent/')) {
    return false;
  }

  return !/(?:~(?![01]))/u.test(value);
}
