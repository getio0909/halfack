import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const projectRoot = path.resolve(import.meta.dirname, '..');
const exampleDirectory = path.join(projectRoot, 'examples');
const serverPath = path.join(exampleDirectory, 'server.mjs');
const processTimeoutMs = 3_000;
const usageExitCode = 64;

type JsonRpcId = number | string;
type JsonObject = Record<string, unknown>;

interface ProcessResult {
  readonly signal: NodeJS.Signals | null;
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface MessageWaiter {
  readonly predicate: (message: JsonObject) => boolean;
  readonly reject: (error: Error) => void;
  readonly resolve: (message: JsonObject) => void;
  readonly timer: NodeJS.Timeout;
}

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

const clients: RpcProcess[] = [];
const temporaryDirectories: string[] = [];

class RpcProcess {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #exit: Promise<ProcessExit>;
  readonly #lines: Interface;
  readonly #messages: JsonObject[] = [];
  readonly #stderr: string[] = [];
  readonly #waiters = new Set<MessageWaiter>();
  #closed = false;
  #nextRequestId = 1;

  constructor(stateDirectory: string, cwd: string) {
    this.#child = spawn(process.execPath, [serverPath, '--state-dir', stateDirectory], {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (chunk: string) => {
      this.#stderr.push(chunk);
    });
    this.#child.stdin.on('error', () => {
      // A close race is reported through the process exit and pending RPC promises.
    });
    this.#lines = createInterface({
      crlfDelay: Infinity,
      input: this.#child.stdout,
      terminal: false,
    });
    this.#lines.on('line', (line) => {
      const message = parseJsonObject(line);
      if (message !== undefined) {
        this.#accept(message);
      }
    });
    this.#exit = new Promise<ProcessExit>((resolve) => {
      this.#child.once('error', (error) => {
        this.#rejectWaiters(
          new Error(`Example server could not start: ${error.message}`, {
            cause: error,
          }),
        );
      });
      this.#child.once('close', (code, signal) => {
        this.#closed = true;
        this.#rejectWaiters(
          new Error(
            `Example server closed before replying (code=${String(code)}, signal=${String(signal)}, stderr=${this.stderr.trim()}).`,
          ),
        );
        resolve({
          code,
          signal,
        });
      });
    });
  }

  get stderr(): string {
    return this.#stderr.join('');
  }

  async dispose(): Promise<void> {
    this.#lines.close();
    if (!this.#child.stdin.destroyed) {
      this.#child.stdin.end();
    }
    if (this.#closed) {
      await this.#exit;
      return;
    }

    const closedGracefully = await settlesWithin(this.#exit, 300);
    if (closedGracefully) {
      return;
    }

    this.#child.kill();
    await settlesWithin(this.#exit, 1_000);
  }

  async request(
    method: string,
    params: JsonObject,
    requestId: JsonRpcId = this.#nextRequestId++,
  ): Promise<JsonObject> {
    const response = this.waitForMessage(
      (message) => message['id'] === requestId,
      `response to ${method}`,
    );
    await this.send({
      id: requestId,
      jsonrpc: '2.0',
      method,
      params,
    });
    return response;
  }

  async send(message: JsonObject): Promise<void> {
    if (this.#closed || this.#child.stdin.destroyed) {
      throw new Error(`Example server is closed: ${this.stderr.trim()}`);
    }
    const line = `${JSON.stringify(message)}\n`;
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.write(line, 'utf8', (error) => {
        if (error === null || error === undefined) {
          resolve();
          return;
        }
        reject(
          new Error(`Could not write to example server: ${error.message}`, {
            cause: error,
          }),
        );
      });
    });
  }

  waitForMessage(
    predicate: (message: JsonObject) => boolean,
    description: string,
    timeoutMs = processTimeoutMs,
  ): Promise<JsonObject> {
    const queuedIndex = this.#messages.findIndex(predicate);
    if (queuedIndex !== -1) {
      const queued = this.#messages.splice(queuedIndex, 1)[0];
      if (queued === undefined) {
        return Promise.reject(new Error('Queued message disappeared unexpectedly.'));
      }
      return Promise.resolve(queued);
    }
    if (this.#closed) {
      return Promise.reject(new Error(`Example server is already closed: ${this.stderr.trim()}`));
    }

    return new Promise<JsonObject>((resolve, reject) => {
      const waiter: MessageWaiter = {
        predicate,
        reject,
        resolve,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter);
          reject(new Error(`Timed out waiting for ${description}; stderr=${this.stderr.trim()}.`));
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  #accept(message: JsonObject): void {
    for (const waiter of this.#waiters) {
      if (waiter.predicate(message)) {
        clearTimeout(waiter.timer);
        this.#waiters.delete(waiter);
        waiter.resolve(message);
        return;
      }
    }
    this.#messages.push(message);
  }

  #rejectWaiters(error: Error): void {
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#waiters.clear();
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(source: string): JsonObject | undefined {
  try {
    const parsed: unknown = JSON.parse(source);
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function executeServer(
  arguments_: readonly string[],
  options: {
    readonly cwd: string;
    readonly input?: string;
  },
): ProcessResult {
  const result = spawnSync(process.execPath, [serverPath, ...arguments_], {
    cwd: options.cwd,
    encoding: 'utf8',
    env: process.env,
    input: options.input,
    maxBuffer: 1024 * 1024,
    timeout: processTimeoutMs,
    windowsHide: true,
  });
  if (result.error !== undefined) {
    throw new Error(`Example server execution failed: ${result.error.message}`, {
      cause: result.error,
    });
  }
  return {
    signal: result.signal,
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

async function createTemporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function startServer(stateDirectory: string, cwd?: string): Promise<RpcProcess> {
  const client = new RpcProcess(
    stateDirectory,
    cwd ?? (await createTemporaryDirectory('halfack-server-cwd-')),
  );
  clients.push(client);
  return client;
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          resolve(false);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function successfulResult(message: JsonObject): unknown {
  if ('error' in message) {
    throw new Error(`RPC returned an error: ${JSON.stringify(message['error'])}`);
  }
  if (!('result' in message)) {
    throw new Error(`RPC response has no result: ${JSON.stringify(message)}`);
  }
  return message['result'];
}

function readCount(message: JsonObject): number {
  const result = successfulResult(message);
  if (!isJsonObject(result)) {
    throw new Error('Count result is not an object.');
  }
  const structuredContent = result['structuredContent'];
  if (!isJsonObject(structuredContent)) {
    throw new Error('Count result has no structured content.');
  }
  const count = structuredContent['count'];
  if (typeof count !== 'number') {
    throw new Error('Count result is not numeric.');
  }
  return count;
}

function createParameters(scope: string, progressToken?: string): JsonObject {
  const params: JsonObject = {
    arguments: {
      clientToken: scope,
    },
    name: 'orders.create',
  };
  if (progressToken !== undefined) {
    params['_meta'] = {
      progressToken,
    };
  }
  return params;
}

function countParameters(scope: string): JsonObject {
  return {
    arguments: {
      scope,
    },
    name: 'orders.count',
  };
}

function hasSuccessfulResponse(stdout: string, requestId: JsonRpcId): boolean {
  const response = responseFor(stdout, requestId);
  return response !== undefined && 'result' in response && !('error' in response);
}

function responseFor(stdout: string, requestId: JsonRpcId): JsonObject | undefined {
  return stdout
    .split(/\r?\n/u)
    .map(parseJsonObject)
    .find((message) => message?.['id'] === requestId);
}

async function listTree(directory: string, relativeDirectory = ''): Promise<readonly string[]> {
  const absoluteDirectory = path.join(directory, relativeDirectory);
  const entries = await readdir(absoluteDirectory, {
    withFileTypes: true,
  });
  const names: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      names.push(`directory:${relativePath}`);
      names.push(...(await listTree(directory, relativePath)));
    } else {
      const content = await readFile(path.join(directory, relativePath));
      const digest = createHash('sha256').update(content).digest('hex');
      names.push(`file:${relativePath}:${digest}`);
    }
  }
  return names;
}

afterEach(async () => {
  await Promise.all(
    clients.splice(0).map(async (client) => {
      await client.dispose();
    }),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, {
        force: true,
        recursive: true,
      });
    }),
  );
});

describe('examples/server.mjs command line', { concurrent: false }, () => {
  it('prints help successfully without requiring or creating a state directory', async () => {
    const cwd = await createTemporaryDirectory('halfack-server-help-');
    const before = await readdir(cwd);
    const result = executeServer(['--help'], {
      cwd,
    });
    const after = await readdir(cwd);

    expect({
      after,
      before,
      mentionsStateDirectory: result.stdout.includes('--state-dir'),
      signal: result.signal,
      status: result.status,
      stderr: result.stderr,
    }).toEqual({
      after: [],
      before: [],
      mentionsStateDirectory: true,
      signal: null,
      status: 0,
      stderr: '',
    });
  });

  it.each([
    {
      arguments: ['--unknown-option'],
      label: 'an unknown option',
    },
    {
      arguments: ['--state-dir', 'first', '--state-dir=second'],
      label: 'duplicate state directories',
    },
    {
      arguments: ['--state-dir', ''],
      label: 'an empty state directory',
    },
  ])('rejects $label as usage errors', async ({ arguments: arguments_ }) => {
    const cwd = await createTemporaryDirectory('halfack-server-usage-');
    const result = executeServer(arguments_, {
      cwd,
    });

    expect({
      signal: result.signal,
      status: result.status,
      stderrIsNonempty: result.stderr.trim().length > 0,
      stdout: result.stdout,
    }).toEqual({
      signal: null,
      status: usageExitCode,
      stderrIsNonempty: true,
      stdout: '',
    });
  });

  it('rejects a NUL-containing state directory before touching the filesystem', async () => {
    const cwd = await createTemporaryDirectory('halfack-server-nul-');
    const source = [
      `process.argv = [process.execPath, ${JSON.stringify(serverPath)}, '--state-dir', String.fromCharCode(0)];`,
      `await import(${JSON.stringify(pathToFileURL(serverPath).href)});`,
    ].join('\n');
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
      cwd,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 1024 * 1024,
      timeout: processTimeoutMs,
      windowsHide: true,
    });
    if (result.error !== undefined) {
      throw new Error(`NUL argument probe failed: ${result.error.message}`, {
        cause: result.error,
      });
    }

    expect({
      directoryEntries: await readdir(cwd),
      signal: result.signal,
      status: result.status,
      stderrIsNonempty: result.stderr.trim().length > 0,
      stdout: result.stdout,
    }).toEqual({
      directoryEntries: [],
      signal: null,
      status: usageExitCode,
      stderrIsNonempty: true,
      stdout: '',
    });
  });
});

describe('examples/server.mjs MCP behavior', { concurrent: false }, () => {
  it('starts from an unrelated cwd and exposes discovery plus the three example tools', async () => {
    const stateDirectory = await createTemporaryDirectory('halfack-server-state-');
    const unrelatedCwd = await createTemporaryDirectory('halfack-server-unrelated-');
    const client = await startServer(stateDirectory, unrelatedCwd);

    const discovery = successfulResult(await client.request('server/discover', {}));
    const listing = successfulResult(await client.request('tools/list', {}));
    if (!isJsonObject(discovery) || !isJsonObject(listing)) {
      throw new Error('Discovery and listing results must be objects.');
    }
    const tools = listing['tools'];
    if (!Array.isArray(tools)) {
      throw new Error('Tool listing must contain an array.');
    }

    expect({
      capabilities: discovery['capabilities'],
      supportedVersions: discovery['supportedVersions'],
      toolNames: tools.map((tool) => (isJsonObject(tool) ? tool['name'] : undefined)),
    }).toEqual({
      capabilities: {
        tools: {},
      },
      supportedVersions: ['2026-07-28'],
      toolNames: ['orders.create', 'orders.count', 'test.reset'],
    });
  });

  it('deduplicates simultaneous creates from two independent processes sharing one scope', async () => {
    const stateDirectory = await createTemporaryDirectory('halfack-server-shared-');
    const first = await startServer(stateDirectory);
    const second = await startServer(stateDirectory);
    const scope = `parallel-${randomUUID()}`;

    const [firstCreate, secondCreate] = await Promise.all([
      first.request('tools/call', createParameters(scope)),
      second.request('tools/call', createParameters(scope)),
    ]);
    successfulResult(firstCreate);
    successfulResult(secondCreate);
    const count = readCount(await first.request('tools/call', countParameters(scope)));

    expect({
      count,
      firstStderr: first.stderr,
      secondStderr: second.stderr,
    }).toEqual({
      count: 1,
      firstStderr: '',
      secondStderr: '',
    });
  });

  it('cancels only the matching delayed create and remains at zero after its commit window', async () => {
    const stateDirectory = await createTemporaryDirectory('halfack-server-cancel-');
    const client = await startServer(stateDirectory);
    const scope = `cancel-${randomUUID()}`;
    const requestId = 41;
    const progressToken = `progress-${randomUUID()}`;
    const progress = client.waitForMessage((message) => {
      const params = message['params'];
      return (
        message['method'] === 'notifications/progress' &&
        isJsonObject(params) &&
        params['progressToken'] === progressToken
      );
    }, 'matching progress notification');

    await client.send({
      id: requestId,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: createParameters(scope, progressToken),
    });
    await progress;
    await client.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: {
        reason: 'black-box cancellation probe',
        requestId,
      },
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 650);
    });

    expect(readCount(await client.request('tools/call', countParameters(scope)))).toBe(0);
  });

  it('commits a progress-reporting create when no cancellation arrives', async () => {
    const stateDirectory = await createTemporaryDirectory('halfack-server-commit-');
    const client = await startServer(stateDirectory);
    const scope = `commit-${randomUUID()}`;
    const progressToken = `progress-${randomUUID()}`;
    const progress = client.waitForMessage((message) => {
      const params = message['params'];
      return (
        message['method'] === 'notifications/progress' &&
        isJsonObject(params) &&
        params['progressToken'] === progressToken
      );
    }, 'progress notification');
    const created = client.request('tools/call', createParameters(scope, progressToken), 51);

    await progress;
    successfulResult(await created);

    expect(readCount(await client.request('tools/call', countParameters(scope)))).toBe(1);
  });

  it('ignores cancellation for another request while committing the matching create', async () => {
    const stateDirectory = await createTemporaryDirectory('halfack-server-other-cancel-');
    const client = await startServer(stateDirectory);
    const scope = `other-cancel-${randomUUID()}`;
    const requestId = 'create-request';
    const progressToken = `progress-${randomUUID()}`;
    const progress = client.waitForMessage((message) => {
      const params = message['params'];
      return (
        message['method'] === 'notifications/progress' &&
        isJsonObject(params) &&
        params['progressToken'] === progressToken
      );
    }, 'progress notification before unrelated cancellation');
    const created = client.request('tools/call', createParameters(scope, progressToken), requestId);

    await progress;
    await client.send({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: {
        requestId: 'some-other-request',
      },
    });
    successfulResult(await created);

    expect(readCount(await client.request('tools/call', countParameters(scope)))).toBe(1);
  });

  it('never acknowledges an effect when the state directory is unusable', async () => {
    const cwd = await createTemporaryDirectory('halfack-server-bad-state-cwd-');
    const parent = await createTemporaryDirectory('halfack-server-bad-state-');
    const blockingFile = path.join(parent, 'not-a-directory');
    await writeFile(blockingFile, 'blocking file', 'utf8');
    const impossibleDirectory = path.join(blockingFile, 'child');
    const requestId = 61;
    const input = `${JSON.stringify({
      id: requestId,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: createParameters(`unwritable-${randomUUID()}`),
    })}\n`;

    const result = executeServer(['--state-dir', impossibleDirectory], {
      cwd,
      input,
    });

    expect({
      acknowledged: hasSuccessfulResponse(result.stdout, requestId),
      signal: result.signal,
      statusIsFailure: result.status !== 0,
    }).toEqual({
      acknowledged: false,
      signal: null,
      statusIsFailure: true,
    });
  });

  it('fails closed instead of acknowledging an effect over a corrupted marker entry', async () => {
    const cwd = await createTemporaryDirectory('halfack-server-corrupt-cwd-');
    const stateDirectory = await createTemporaryDirectory('halfack-server-corrupt-state-');
    const scope = `corrupt-${randomUUID()}`;
    const stateFilename = `${createHash('sha256').update(scope).digest('hex')}.order`;
    const statePath = path.join(stateDirectory, stateFilename);
    await mkdir(statePath);
    const requestId = 71;
    const input = `${JSON.stringify({
      id: requestId,
      jsonrpc: '2.0',
      method: 'tools/call',
      params: createParameters(scope),
    })}\n`;

    const result = executeServer(['--state-dir', stateDirectory], {
      cwd,
      input,
    });
    const response = responseFor(result.stdout, requestId);
    const error = response?.['error'];

    expect({
      acknowledged: hasSuccessfulResponse(result.stdout, requestId),
      errorCode: isJsonObject(error) ? error['code'] : undefined,
      markerIsStillDirectory: (await lstat(statePath)).isDirectory(),
      stateEntries: await readdir(stateDirectory),
    }).toEqual({
      acknowledged: false,
      errorCode: -32603,
      markerIsStillDirectory: true,
      stateEntries: [stateFilename],
    });
  });

  it('keeps the tracked examples directory byte-for-byte free of runtime state', async () => {
    const before = await listTree(exampleDirectory);
    const stateDirectory = await createTemporaryDirectory('halfack-server-external-state-');
    const client = await startServer(stateDirectory);
    const scope = `clean-${randomUUID()}`;

    successfulResult(await client.request('tools/call', createParameters(scope)));
    expect(readCount(await client.request('tools/call', countParameters(scope)))).toBe(1);
    await client.dispose();

    expect(await listTree(exampleDirectory)).toEqual(before);
  });
});
