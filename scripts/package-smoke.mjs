#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { access, lstat, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const maxBufferBytes = 4 * 1024 * 1024;
const npmTimeoutMs = 120_000;
const cliTimeoutMs = 180_000;
const scenarioFilename = 'duplicate-order.halfack.yml';
const expectedExperiments = Object.freeze([
  'suppress_completed_response',
  'retry_new_id',
  'rpc_id_reuse',
  'restart_after_suppressed_response',
  'parallel_new_ids',
  'cancel_on_progress',
  'disconnect_after_request_write_accepted',
]);

const temporaryDirectories = [];

async function main() {
  let smokeFailure;
  try {
    await executeSmoke();
  } catch (error) {
    smokeFailure = error;
  }

  let cleanupFailure;
  try {
    await cleanupTemporaryDirectories();
  } catch (error) {
    cleanupFailure = error;
  }

  if (smokeFailure !== undefined && cleanupFailure !== undefined) {
    throw new Error(
      `${errorMessage(smokeFailure)} Cleanup also failed: ${errorMessage(cleanupFailure)}`,
      {
        cause: new AggregateError([smokeFailure, cleanupFailure]),
      },
    );
  }
  if (smokeFailure !== undefined) {
    throw smokeFailure;
  }
  if (cleanupFailure !== undefined) {
    throw cleanupFailure;
  }

  process.stdout.write(
    `HalfAck package smoke passed (${String(expectedExperiments.length)}/${String(
      expectedExperiments.length,
    )} experiments).\n`,
  );
}

async function executeSmoke() {
  const packDirectory = await createTemporaryDirectory('halfack-package-pack-');
  const installDirectory = await createTemporaryDirectory('halfack-package-install-');
  const pack = packProject(packDirectory);
  assertPackageBoundary(pack.files, 'npm pack manifest');

  const tarballPath = await resolveTarball(packDirectory, pack.filename);
  initializeInstallation(installDirectory);
  installTarball(installDirectory, tarballPath);

  const installedPackageDirectory = path.join(installDirectory, 'node_modules', 'halfack');
  const installedFiles = await collectPackageFiles(installedPackageDirectory);
  assertPackageBoundary(installedFiles, 'installed package');

  const installedManifest = await readInstalledManifest(installedPackageDirectory);
  const binaryPath = await resolveInstalledBinary(installDirectory);
  const exampleDirectory = path.join(installedPackageDirectory, 'examples');
  const scenarioPath = path.join(exampleDirectory, scenarioFilename);

  verifyHelp(binaryPath, installDirectory);
  verifyVersion(binaryPath, installDirectory, installedManifest.version);
  verifyScenarioValidation(binaryPath, exampleDirectory, scenarioPath);
  verifyScenarioRun(binaryPath, exampleDirectory, scenarioPath, installedManifest.version);
}

function packProject(packDirectory) {
  const result = runChild(
    npmExecutable,
    ['pack', '--ignore-scripts', '--json', '--pack-destination', packDirectory],
    {
      cwd: projectRoot,
      label: 'npm pack',
      timeoutMs: npmTimeoutMs,
    },
  );

  let parsed;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error('npm pack did not return valid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error('npm pack must return exactly one package record.');
  }

  const [record] = parsed;
  if (!isRecord(record) || typeof record.filename !== 'string') {
    throw new Error('npm pack returned a malformed package record.');
  }
  if (!Array.isArray(record.files) || record.files.length === 0) {
    throw new Error('npm pack returned an empty or malformed file manifest.');
  }

  const files = record.files.map((entry) => {
    if (!isRecord(entry) || typeof entry.path !== 'string') {
      throw new Error('npm pack returned a malformed file entry.');
    }
    return normalizePackPath(entry.path);
  });

  return {
    filename: record.filename,
    files: uniqueSortedPaths(files, 'npm pack manifest'),
  };
}

async function resolveTarball(packDirectory, filename) {
  if (filename.length === 0 || filename.includes('\0') || path.basename(filename) !== filename) {
    throw new Error('npm pack returned an unsafe tarball filename.');
  }

  const resolvedPackDirectory = await realpath(packDirectory);
  const tarballPath = path.resolve(resolvedPackDirectory, filename);
  if (path.dirname(tarballPath) !== resolvedPackDirectory) {
    throw new Error('npm pack placed the tarball outside its destination.');
  }

  const metadata = await lstat(tarballPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('npm pack did not create a regular tarball file.');
  }
  return tarballPath;
}

function initializeInstallation(installDirectory) {
  runChild(npmExecutable, ['init', '--yes'], {
    cwd: installDirectory,
    label: 'npm init',
    timeoutMs: npmTimeoutMs,
  });
}

function installTarball(installDirectory, tarballPath) {
  runChild(
    npmExecutable,
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-save', tarballPath],
    {
      cwd: installDirectory,
      label: 'npm install packed tarball',
      timeoutMs: npmTimeoutMs,
    },
  );
}

async function readInstalledManifest(installedPackageDirectory) {
  const manifestPath = path.join(installedPackageDirectory, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error('The installed package.json is missing or invalid.');
  }

  if (
    !isRecord(manifest) ||
    manifest.name !== 'halfack' ||
    typeof manifest.version !== 'string' ||
    manifest.version.length === 0 ||
    !isRecord(manifest.bin) ||
    typeof manifest.bin.halfack !== 'string'
  ) {
    throw new Error('The installed package manifest does not expose the HalfAck binary.');
  }
  return {
    version: manifest.version,
  };
}

async function resolveInstalledBinary(installDirectory) {
  const binaryName = process.platform === 'win32' ? 'halfack.cmd' : 'halfack';
  const binaryPath = path.join(installDirectory, 'node_modules', '.bin', binaryName);
  const metadata = await lstat(binaryPath);
  if (process.platform === 'win32') {
    if (!metadata.isFile()) {
      throw new Error('The installed HalfAck command shim is not a regular file.');
    }
  } else if (!metadata.isFile() && !metadata.isSymbolicLink()) {
    throw new Error('The installed HalfAck command shim is not executable content.');
  }
  await access(binaryPath, fsConstants.X_OK);
  return binaryPath;
}

function verifyHelp(binaryPath, cwd) {
  const result = runCli(binaryPath, ['--help'], {
    cwd,
    label: 'installed halfack --help',
  });
  assertEmptyStderr(result.stderr, 'halfack --help');
  if (
    !result.stdout.startsWith('HalfAck') ||
    !result.stdout.includes('\nUsage:\n') ||
    !result.stdout.includes('halfack run <scenario.yml>') ||
    !result.stdout.endsWith('\n')
  ) {
    throw new Error('The installed HalfAck help output is incomplete.');
  }
}

function verifyVersion(binaryPath, cwd, expectedVersion) {
  const result = runCli(binaryPath, ['--version'], {
    cwd,
    label: 'installed halfack --version',
  });
  assertEmptyStderr(result.stderr, 'halfack --version');
  if (result.stdout !== `${expectedVersion}\n`) {
    throw new Error('The installed HalfAck version does not match package.json.');
  }
}

function verifyScenarioValidation(binaryPath, cwd, scenarioPath) {
  const result = runCli(binaryPath, ['validate', scenarioPath], {
    cwd,
    label: 'installed halfack validate example',
  });
  assertEmptyStderr(result.stderr, 'halfack validate');
  if (result.stdout !== "Valid scenario 'duplicate-order'.\n") {
    throw new Error('The installed HalfAck command did not validate the packaged example.');
  }
}

function verifyScenarioRun(binaryPath, cwd, scenarioPath, expectedVersion) {
  const result = runCli(binaryPath, ['run', scenarioPath, '--format=json'], {
    acceptNonZero: true,
    cwd,
    label: 'installed halfack run example',
    timeoutMs: cliTimeoutMs,
  });
  assertEmptyStderr(result.stderr, 'halfack run');

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error('The installed HalfAck run did not emit valid JSON.');
  }
  if (!isRecord(report) || report.schema !== 'halfack/report/v1') {
    throw new Error('The installed HalfAck run emitted an unexpected report envelope.');
  }
  if (
    !isRecord(report.tool) ||
    report.tool.name !== 'halfack' ||
    report.tool.version !== expectedVersion
  ) {
    throw new Error('The installed HalfAck report has inconsistent tool metadata.');
  }
  if (!isRecord(report.suite)) {
    throw new Error('The installed HalfAck report is missing its suite.');
  }

  const { suite } = report;
  if (result.status !== 0) {
    throw new Error(
      `The packaged example command returned exit ${String(result.status)}. ${summarizeSuite(
        suite,
      )}`,
    );
  }
  if (suite.scenario !== 'duplicate-order' || suite.status !== 'pass' || suite.halted !== false) {
    throw new Error(
      `The packaged example suite did not complete with PASS status. ${summarizeSuite(suite)}`,
    );
  }
  if (
    !isRecord(suite.counts) ||
    suite.counts.passed !== expectedExperiments.length ||
    suite.counts.violations !== 0 ||
    suite.counts.inconclusive !== 0
  ) {
    throw new Error('The packaged example suite returned unexpected result counts.');
  }
  if (!Array.isArray(suite.results) || suite.results.length !== expectedExperiments.length) {
    throw new Error('The packaged example suite did not return all seven experiments.');
  }

  for (const [index, expectedExperiment] of expectedExperiments.entries()) {
    const resultEntry = suite.results[index];
    if (
      !isRecord(resultEntry) ||
      resultEntry.experiment !== expectedExperiment ||
      !isRecord(resultEntry.conclusion) ||
      resultEntry.conclusion.kind !== 'pass' ||
      resultEntry.conclusion.expected !== resultEntry.conclusion.observed ||
      !isRecord(resultEntry.cleanup) ||
      resultEntry.cleanup.kind === 'failed'
    ) {
      throw new Error(
        `Packaged experiment ${String(index + 1)} did not produce strict PASS evidence.`,
      );
    }
  }
}

function runCli(binaryPath, arguments_, options) {
  return runChild(binaryPath, arguments_, {
    acceptNonZero: options.acceptNonZero,
    cwd: options.cwd,
    label: options.label,
    timeoutMs: options.timeoutMs ?? cliTimeoutMs,
  });
}

function runChild(command, arguments_, options) {
  const invocation = createChildInvocation(command, arguments_);
  const result = spawnSync(invocation.command, invocation.arguments, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
    },
    maxBuffer: maxBufferBytes,
    timeout: options.timeoutMs,
    windowsHide: true,
  });

  if (result.error !== undefined) {
    const code = typeof result.error.code === 'string' ? ` (${result.error.code})` : '';
    throw new Error(
      `${options.label} could not run${code}.${renderChildOutput(result.stdout, result.stderr)}`,
    );
  }
  if (result.status === null) {
    const termination =
      result.signal === null ? 'without an exit status' : `with signal ${String(result.signal)}`;
    throw new Error(
      `${options.label} terminated ${termination}.${renderChildOutput(
        result.stdout,
        result.stderr,
      )}`,
    );
  }
  if (result.status !== 0 && options.acceptNonZero !== true) {
    const termination =
      result.signal === null ? `exit ${String(result.status)}` : `signal ${String(result.signal)}`;
    throw new Error(
      `${options.label} failed with ${termination}.${renderChildOutput(
        result.stdout,
        result.stderr,
      )}`,
    );
  }

  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function summarizeSuite(suite) {
  const summary = [
    `suite=${typeof suite.status === 'string' ? suite.status : 'unknown'}`,
    `halted=${typeof suite.halted === 'boolean' ? String(suite.halted) : 'unknown'}`,
  ];

  if (isRecord(suite.counts)) {
    summary.push(
      `counts(pass=${renderCount(suite.counts.passed)}, violation=${renderCount(
        suite.counts.violations,
      )}, inconclusive=${renderCount(suite.counts.inconclusive)})`,
    );
  }

  if (Array.isArray(suite.results)) {
    const failures = [];
    for (const entry of suite.results) {
      if (!isRecord(entry)) {
        failures.push('malformed-result');
        continue;
      }

      const experiment =
        typeof entry.experiment === 'string' ? entry.experiment : 'unknown-experiment';
      const conclusion =
        isRecord(entry.conclusion) && typeof entry.conclusion.kind === 'string'
          ? entry.conclusion.kind
          : 'unknown-conclusion';
      const cleanup =
        isRecord(entry.cleanup) && typeof entry.cleanup.kind === 'string'
          ? entry.cleanup.kind
          : 'unknown-cleanup';
      if (conclusion !== 'pass' || cleanup === 'failed') {
        failures.push(`${experiment}:${conclusion}/cleanup-${cleanup}`);
      }
    }
    if (failures.length > 0) {
      summary.push(`failures=${failures.join(',')}`);
    }
  }

  return summary.join('; ');
}

function renderCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : 'unknown';
}

function createChildInvocation(command, arguments_) {
  if (process.platform !== 'win32' || !/\.(?:bat|cmd)$/iu.test(command)) {
    return {
      arguments: arguments_,
      command,
    };
  }

  return {
    arguments: ['/d', '/s', '/c', command, ...arguments_],
    command: process.env.ComSpec || 'cmd.exe',
  };
}

function renderChildOutput(stdout, stderr) {
  const rendered = [];
  const safeStdout = sanitizeDiagnostic(stdout);
  const safeStderr = sanitizeDiagnostic(stderr);
  if (safeStdout.length > 0) {
    rendered.push(`stdout:\n${safeStdout}`);
  }
  if (safeStderr.length > 0) {
    rendered.push(`stderr:\n${safeStderr}`);
  }
  return rendered.length === 0 ? '' : `\n${rendered.join('\n')}`;
}

function sanitizeDiagnostic(value) {
  const maximumCharacters = 4_096;
  let safe = '';
  for (const character of String(value)) {
    const codePoint = character.codePointAt(0);
    if (codePoint === 0) {
      safe += '\\0';
    } else if (
      codePoint !== undefined &&
      ((codePoint >= 1 && codePoint <= 8) ||
        codePoint === 11 ||
        codePoint === 12 ||
        (codePoint >= 14 && codePoint <= 31) ||
        (codePoint >= 127 && codePoint <= 159))
    ) {
      safe += '?';
    } else {
      safe += character;
    }
  }
  safe = safe.trim();
  if (safe.length <= maximumCharacters) {
    return safe;
  }
  return `${safe.slice(0, maximumCharacters)}\n[output truncated]`;
}

function assertEmptyStderr(stderr, command) {
  if (stderr !== '') {
    throw new Error(`${command} wrote unexpected stderr.${renderChildOutput('', stderr)}`);
  }
}

function assertPackageBoundary(files, source) {
  const normalized = uniqueSortedPaths(files, source);
  const requiredFiles = [
    'CONTRIBUTING.md',
    'LICENSE',
    'README.md',
    'SECURITY.md',
    'dist/cli/main.js',
    `examples/${scenarioFilename}`,
    'examples/server.mjs',
    'package.json',
  ];

  for (const requiredFile of requiredFiles) {
    if (!normalized.includes(requiredFile)) {
      throw new Error(`${source} is missing required file '${requiredFile}'.`);
    }
  }
  if (!normalized.some((file) => file.startsWith('dist/'))) {
    throw new Error(`${source} does not contain the dist directory.`);
  }
  if (!normalized.some((file) => file.startsWith('examples/'))) {
    throw new Error(`${source} does not contain the examples directory.`);
  }

  for (const file of normalized) {
    const [root = ''] = file.split('/');
    if (root === 'src' || root === 'test' || root === 'tests') {
      throw new Error(`${source} unexpectedly contains '${root}/'.`);
    }
  }
}

function normalizePackPath(file) {
  if (
    file.length === 0 ||
    file.includes('\0') ||
    file.includes('\\') ||
    file.startsWith('/') ||
    /^[a-zA-Z]:/u.test(file)
  ) {
    throw new Error('npm pack returned an unsafe file path.');
  }
  const normalized = path.posix.normalize(file);
  if (
    normalized !== file ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('./')
  ) {
    throw new Error('npm pack returned a non-canonical file path.');
  }
  return normalized;
}

function uniqueSortedPaths(files, source) {
  const normalized = [...files].sort((left, right) => left.localeCompare(right, 'en'));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${source} contains duplicate file paths.`);
  }
  return normalized;
}

async function collectPackageFiles(rootDirectory) {
  const files = [];
  await walkDirectory(rootDirectory, '', files);
  return uniqueSortedPaths(files, 'installed package');
}

async function walkDirectory(rootDirectory, relativeDirectory, files) {
  const absoluteDirectory = path.join(rootDirectory, relativeDirectory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));

  for (const entry of entries) {
    const relativePath = relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name;
    const portablePath = relativePath.split(path.sep).join('/');

    if (entry.isDirectory()) {
      await walkDirectory(rootDirectory, relativePath, files);
      continue;
    }
    if (entry.isFile()) {
      files.push(portablePath);
      continue;
    }
    throw new Error(`The installed package contains unsupported entry '${portablePath}'.`);
  }
}

async function createTemporaryDirectory(prefix) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function cleanupTemporaryDirectories() {
  const cleanupResults = await Promise.allSettled(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100,
      }),
    ),
  );
  const failed = cleanupResults.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') {
    throw new Error('Package smoke temporary files could not be removed.', {
      cause: failed.reason,
    });
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : 'Unknown package smoke failure.';
}

main().catch((error) => {
  process.stderr.write(
    `HalfAck package smoke failed: ${sanitizeDiagnostic(errorMessage(error))}\n`,
  );
  process.exitCode = 1;
});
