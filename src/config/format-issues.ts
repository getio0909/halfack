import type { z } from 'zod/v4';
import { escapeDiagnosticText, formatDiagnosticPath } from '../domain/diagnostic.js';

const MAX_RENDERED_ISSUES = 8;

export function formatScenarioIssues(issues: readonly z.core.$ZodIssue[]): string {
  const allRendered = issues.flatMap(renderIssue);
  const rendered = allRendered.slice(0, MAX_RENDERED_ISSUES);
  const omittedCount = allRendered.length - rendered.length;
  const suffix =
    omittedCount === 0
      ? ''
      : `; ${String(omittedCount)} additional issue${omittedCount === 1 ? '' : 's'} omitted`;

  return `Scenario is invalid: ${rendered.join('; ')}${suffix}.`;
}

function renderIssue(issue: z.core.$ZodIssue): readonly string[] {
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map(
      (key) => `${formatDiagnosticPath([...issue.path, key])}: Unrecognized key`,
    );
  }

  return [
    `${formatDiagnosticPath(issue.path)}: ${escapeDiagnosticText(
      stripTerminalPeriod(issue.message),
    )}`,
  ];
}

function stripTerminalPeriod(message: string): string {
  return message.endsWith('.') ? message.slice(0, -1) : message;
}
