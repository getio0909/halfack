import path from 'node:path';

export interface PolicyIssue {
  readonly message: string;
  readonly path: readonly (number | string)[];
}

const SAFE_ENVIRONMENT_NAMES = new Set([
  'CI',
  'COLORTERM',
  'FORCE_COLOR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NODE_ENV',
  'NO_COLOR',
  'PATH',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'WINDIR',
]);

const PROCESS_WRAPPERS = new Set([
  'bash',
  'bunx',
  'cmd',
  'corepack',
  'docker',
  'docker-compose',
  'env',
  'fish',
  'npm',
  'npx',
  'pnpm',
  'podman',
  'powershell',
  'pwsh',
  'sh',
  'start',
  'tsx',
  'uvx',
  'wsl',
  'wslhost',
  'yarn',
  'zsh',
]);

const PLACEHOLDER_START = '${';
const RUN_ID_PLACEHOLDER = '${run.id}';

export function commandPolicyIssues(command: string): readonly PolicyIssue[] {
  const issues: PolicyIssue[] = [];

  if (command !== command.trim()) {
    issues.push({
      message: 'Command must not have leading or trailing whitespace.',
      path: ['command'],
    });
  }

  if (/[\0\r\n]/u.test(command)) {
    issues.push({
      message: 'Command must not contain control characters.',
      path: ['command'],
    });
  }

  const isAbsolute = path.posix.isAbsolute(command) || path.win32.isAbsolute(command);
  if (/\s/u.test(command) && !isAbsolute) {
    issues.push({
      message: 'Command must name one executable; put its arguments in target.args.',
      path: ['command'],
    });
  }

  return issues;
}

export function cwdPolicyIssues(cwd: string): readonly PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  const isAnchored = path.posix.isAbsolute(cwd) || path.win32.parse(cwd).root.length > 0;

  if (cwd !== cwd.trim() || cwd.length === 0) {
    issues.push({
      message: 'Working directory must be a non-empty relative path.',
      path: ['cwd'],
    });
  }

  if (/[\0\r\n]/u.test(cwd)) {
    issues.push({
      message: 'Working directory must not contain control characters.',
      path: ['cwd'],
    });
  }

  if (isAnchored) {
    issues.push({
      message: 'Working directory must be an unqualified path relative to the scenario file.',
      path: ['cwd'],
    });
  }

  const segments = cwd.replaceAll('\\', '/').split('/');
  if (segments.includes('..')) {
    issues.push({
      message: 'Working directory must not escape the scenario directory.',
      path: ['cwd'],
    });
  }

  return issues;
}

export function environmentPolicyIssues(names: readonly string[]): readonly PolicyIssue[] {
  const issues: PolicyIssue[] = [];
  const seen = new Set<string>();

  for (const [index, name] of names.entries()) {
    const canonicalName = name.toUpperCase();

    if (seen.has(canonicalName)) {
      issues.push({
        message: `Environment allowlist contains duplicate '${name}'.`,
        path: ['envAllowlist', index],
      });
      continue;
    }
    seen.add(canonicalName);

    if (!SAFE_ENVIRONMENT_NAMES.has(canonicalName)) {
      issues.push({
        message: `Environment variable '${name}' is not in HalfAck's safe host allowlist.`,
        path: ['envAllowlist', index],
      });
    }
  }

  return issues;
}

export function isProcessWrapper(command: string): boolean {
  const executable = command.split(/[\\/]/u).at(-1)?.toLowerCase() ?? '';
  const withoutExtension = executable.replace(/\.(?:bat|cmd|exe)$/u, '');
  return PROCESS_WRAPPERS.has(withoutExtension);
}

export function disallowedPlaceholderIssue(
  value: string,
  issuePath: readonly (number | string)[],
): PolicyIssue | undefined {
  const remaining = value.replaceAll(RUN_ID_PLACEHOLDER, '');
  if (!remaining.includes(PLACEHOLDER_START)) {
    return undefined;
  }

  return {
    message: `Unsupported placeholder; only '${RUN_ID_PLACEHOLDER}' is allowed.`,
    path: issuePath,
  };
}

export function argumentPlaceholderIssues(
  value: unknown,
  issuePath: readonly (number | string)[],
): readonly PolicyIssue[] {
  if (typeof value === 'string') {
    const issue = disallowedPlaceholderIssue(value, issuePath);
    return issue === undefined ? [] : [issue];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => argumentPlaceholderIssues(entry, [...issuePath, index]));
  }

  if (value !== null && typeof value === 'object') {
    const issues: PolicyIssue[] = [];
    for (const [key, entry] of Object.entries(value)) {
      if (key.includes(PLACEHOLDER_START)) {
        issues.push({
          message: 'Placeholders are not allowed in argument object keys.',
          path: [...issuePath, key],
        });
      }
      issues.push(...argumentPlaceholderIssues(entry, [...issuePath, key]));
    }
    return issues;
  }

  return [];
}
