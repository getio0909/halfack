#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const DELAYED_COMMIT_MS = 500;
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_SCOPE_LENGTH = 256;
const HELP = `HalfAck idempotent MCP example server

Usage:
  node server.mjs [--state-dir <directory>]

Options:
  --state-dir <directory>  Persist order markers in this directory.
  --help                   Show this help.
`;

class RpcInputError extends Error {}

function failUsage(message) {
  process.stderr.write(`halfack example server: ${message}\n`);
  process.exitCode = 64;
}

function parseArguments(arguments_) {
  let stateDirectory;
  let help = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--help') {
      if (help) {
        throw new RpcInputError('--help may only be specified once.');
      }
      help = true;
      continue;
    }

    let value;
    if (argument === '--state-dir') {
      index += 1;
      value = arguments_[index];
      if (value === undefined || value.startsWith('--')) {
        throw new RpcInputError('--state-dir requires a directory.');
      }
    } else if (argument.startsWith('--state-dir=')) {
      value = argument.slice('--state-dir='.length);
    } else {
      throw new RpcInputError(`unknown option ${JSON.stringify(argument)}.`);
    }

    if (stateDirectory !== undefined) {
      throw new RpcInputError('--state-dir may only be specified once.');
    }
    if (value.length === 0 || value.includes('\0')) {
      throw new RpcInputError('--state-dir must be a non-empty filesystem path.');
    }
    stateDirectory = value;
  }

  if (help && stateDirectory !== undefined) {
    throw new RpcInputError('--help cannot be combined with --state-dir.');
  }

  return {
    help,
    stateDirectory:
      stateDirectory === undefined
        ? path.join(tmpdir(), 'halfack-example-orders-v1')
        : path.resolve(process.cwd(), stateDirectory),
  };
}

let options;
try {
  options = parseArguments(process.argv.slice(2));
} catch (error) {
  failUsage(error instanceof Error ? error.message : 'invalid command-line arguments.');
}

if (options === undefined) {
  // Argument parsing has already set a failure exit code.
} else if (options.help) {
  process.stdout.write(HELP);
} else {
  startServer(options.stateDirectory);
}

function startServer(configuredStateDirectory) {
  let stateDirectory;
  try {
    mkdirSync(configuredStateDirectory, {
      mode: 0o700,
      recursive: true,
    });
    stateDirectory = realpathSync(configuredStateDirectory);
    if (!statSync(stateDirectory).isDirectory()) {
      throw new Error('State path is not a directory.');
    }
  } catch {
    process.stderr.write('halfack example server: unable to initialize state directory\n');
    process.exitCode = 73;
    return;
  }

  const pendingByRequestKey = new Map();
  const pendingKeysByScope = new Map();
  const waitingProbesByScope = new Map();
  let inputBuffer = '';
  let stopped = false;

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (stopped) {
      return;
    }
    inputBuffer += chunk;
    consumeLines();
  });
  process.stdin.on('end', () => {
    if (stopped) {
      return;
    }
    if (inputBuffer.length > 0) {
      consumeLine(inputBuffer.endsWith('\r') ? inputBuffer.slice(0, -1) : inputBuffer);
      inputBuffer = '';
    }
    stop();
  });
  process.stdin.on('error', () => {
    failProtocol();
  });
  process.stdout.on('error', (error) => {
    stopped = true;
    clearPending();
    process.stdin.destroy();
    process.exitCode = error?.code === 'EPIPE' ? 0 : 74;
  });

  function consumeLines() {
    let newlineIndex = inputBuffer.indexOf('\n');
    while (newlineIndex >= 0 && !stopped) {
      let line = inputBuffer.slice(0, newlineIndex);
      inputBuffer = inputBuffer.slice(newlineIndex + 1);
      if (line.endsWith('\r')) {
        line = line.slice(0, -1);
      }
      consumeLine(line);
      newlineIndex = inputBuffer.indexOf('\n');
    }

    if (!stopped && Buffer.byteLength(inputBuffer, 'utf8') > MAX_INPUT_BYTES) {
      failProtocol();
    }
  }

  function consumeLine(line) {
    if (line.length === 0) {
      return;
    }
    if (Buffer.byteLength(line, 'utf8') > MAX_INPUT_BYTES) {
      failProtocol();
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      failProtocol();
      return;
    }

    try {
      handleMessage(message);
    } catch (error) {
      const id = requestIdFrom(message);
      if (id === undefined) {
        if (error instanceof RpcInputError) {
          return;
        }
        failProtocol();
        return;
      }
      reject(id, error instanceof RpcInputError ? -32602 : -32603);
    }
  }

  function handleMessage(message) {
    if (
      !isPlainObject(message) ||
      message.jsonrpc !== '2.0' ||
      typeof message.method !== 'string'
    ) {
      reject(requestIdFrom(message) ?? null, -32600);
      return;
    }

    const id = requestIdFrom(message);
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    if (hasId && id === undefined) {
      reject(null, -32600);
      return;
    }

    if (!hasId) {
      if (message.method === 'notifications/cancelled') {
        handleCancellation(message.params);
      }
      return;
    }

    const key = requestKey(id);
    if (pendingByRequestKey.has(key)) {
      reject(id, -32600);
      return;
    }

    if (message.method === 'server/discover') {
      respond(id, {
        capabilities: {
          tools: {},
        },
        supportedVersions: ['2026-07-28'],
      });
      return;
    }
    if (message.method === 'tools/list') {
      respond(id, {
        tools: [
          tool(
            'orders.create',
            'Create one order per stable client token, even when a response is lost.',
            'clientToken',
          ),
          tool('orders.count', 'Read whether an order exists for a test scope.', 'scope'),
          tool('test.reset', 'Remove the order marker for a disposable test scope.', 'scope'),
        ],
      });
      return;
    }
    if (message.method !== 'tools/call') {
      reject(id, -32601);
      return;
    }

    const params = plainObject(message.params, 'tools/call params');
    const name = params.name;
    if (typeof name !== 'string') {
      throw new RpcInputError('tools/call requires a tool name.');
    }
    const arguments_ = plainObject(params.arguments ?? {}, 'tool arguments');

    if (name === 'test.reset') {
      const scope = exactScopeArgument(arguments_, 'scope');
      cancelScope(scope);
      removeMarker(scope);
      respond(id, { content: [] });
      flushProbesIfSettled(scope);
      return;
    }
    if (name === 'orders.count') {
      const scope = exactScopeArgument(arguments_, 'scope');
      if (hasPendingScope(scope)) {
        const probes = waitingProbesByScope.get(scope) ?? [];
        probes.push(id);
        waitingProbesByScope.set(scope, probes);
        return;
      }
      respondWithCount(id, scope);
      return;
    }
    if (name === 'orders.create') {
      const scope = exactScopeArgument(arguments_, 'clientToken');
      const progressToken = progressTokenFrom(params);
      if (progressToken !== undefined) {
        schedulePendingCommit(id, scope, progressToken);
        return;
      }

      commitEffect(scope);
      respond(id, { content: [] });
      return;
    }

    reject(id, -32602);
  }

  function handleCancellation(paramsValue) {
    if (!isPlainObject(paramsValue)) {
      return;
    }
    const requestId = requestIdFrom({ id: paramsValue.requestId });
    if (requestId === undefined) {
      return;
    }
    const key = requestKey(requestId);
    const pending = pendingByRequestKey.get(key);
    if (pending === undefined) {
      return;
    }

    removePending(key, pending);
    flushProbesIfSettled(pending.scope);
  }

  function schedulePendingCommit(requestId, scope, progressToken) {
    const key = requestKey(requestId);
    const pending = {
      requestId,
      scope,
      timer: undefined,
    };
    pendingByRequestKey.set(key, pending);
    const keys = pendingKeysByScope.get(scope) ?? new Set();
    keys.add(key);
    pendingKeysByScope.set(scope, keys);

    notifyProgress(progressToken);
    if (stopped || pendingByRequestKey.get(key) !== pending) {
      return;
    }

    pending.timer = setTimeout(() => {
      if (pendingByRequestKey.get(key) !== pending) {
        return;
      }
      removePending(key, pending);
      try {
        commitEffect(scope);
        respond(requestId, { content: [] });
      } catch {
        reject(requestId, -32603);
      }
      flushProbesIfSettled(scope);
    }, DELAYED_COMMIT_MS);
  }

  function cancelScope(scope) {
    const keys = pendingKeysByScope.get(scope);
    if (keys === undefined) {
      return;
    }
    for (const key of [...keys]) {
      const pending = pendingByRequestKey.get(key);
      if (pending !== undefined) {
        removePending(key, pending);
      }
    }
  }

  function removePending(key, pending) {
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
    }
    pendingByRequestKey.delete(key);
    const keys = pendingKeysByScope.get(pending.scope);
    keys?.delete(key);
    if (keys?.size === 0) {
      pendingKeysByScope.delete(pending.scope);
    }
  }

  function clearPending() {
    for (const [key, pending] of pendingByRequestKey) {
      removePending(key, pending);
    }
    waitingProbesByScope.clear();
  }

  function hasPendingScope(scope) {
    return (pendingKeysByScope.get(scope)?.size ?? 0) > 0;
  }

  function flushProbesIfSettled(scope) {
    if (hasPendingScope(scope)) {
      return;
    }
    const probes = waitingProbesByScope.get(scope);
    if (probes === undefined) {
      return;
    }
    waitingProbesByScope.delete(scope);
    for (const id of probes) {
      try {
        respondWithCount(id, scope);
      } catch {
        reject(id, -32603);
      }
    }
  }

  function markerPath(scope) {
    const digest = createHash('sha256').update(scope, 'utf8').digest('hex');
    return path.join(stateDirectory, `${digest}.order`);
  }

  function commitEffect(scope) {
    const marker = markerPath(scope);
    let descriptor;
    try {
      descriptor = openSync(
        marker,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
    } catch (error) {
      if (error?.code === 'EEXIST') {
        assertMarker(marker);
        return;
      }
      throw error;
    }

    try {
      writeSync(descriptor, 'halfack-order-v1\n', undefined, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  function removeMarker(scope) {
    const marker = markerPath(scope);
    try {
      unlinkSync(marker);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  function markerCount(scope) {
    const marker = markerPath(scope);
    try {
      assertMarker(marker);
      return 1;
    } catch (error) {
      if (error?.code === 'ENOENT') {
        return 0;
      }
      throw error;
    }
  }

  function assertMarker(marker) {
    if (!lstatSync(marker).isFile()) {
      throw new Error('Invalid order marker.');
    }
  }

  function respondWithCount(id, scope) {
    respond(id, {
      content: [],
      structuredContent: {
        count: markerCount(scope),
      },
    });
  }

  function respond(id, result) {
    write({
      id,
      jsonrpc: '2.0',
      result,
    });
  }

  function reject(id, code) {
    const messages = {
      '-32600': 'Invalid Request',
      '-32601': 'Method not found',
      '-32602': 'Invalid params',
      '-32603': 'Internal error',
    };
    write({
      error: {
        code,
        message: messages[String(code)] ?? 'Server error',
      },
      id,
      jsonrpc: '2.0',
    });
  }

  function notifyProgress(progressToken) {
    write({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: {
        progress: 1,
        progressToken,
        total: 2,
      },
    });
  }

  function write(message) {
    if (!stopped) {
      process.stdout.write(`${JSON.stringify(message)}\n`);
    }
  }

  function failProtocol() {
    if (stopped) {
      return;
    }
    stopped = true;
    clearPending();
    inputBuffer = '';
    process.exitCode = 65;
    process.stdin.destroy();
  }

  function stop() {
    if (stopped) {
      return;
    }
    stopped = true;
    clearPending();
  }
}

function tool(name, description, requiredProperty) {
  return {
    description,
    inputSchema: {
      additionalProperties: false,
      properties: {
        [requiredProperty]: {
          description: 'A stable, non-empty identifier for one disposable test scope.',
          maxLength: MAX_SCOPE_LENGTH,
          minLength: 1,
          type: 'string',
        },
      },
      required: [requiredProperty],
      type: 'object',
    },
    name,
  };
}

function exactScopeArgument(arguments_, property) {
  const keys = Object.keys(arguments_);
  if (keys.length !== 1 || keys[0] !== property) {
    throw new RpcInputError(`Tool arguments must contain only ${property}.`);
  }
  const value = arguments_[property];
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_SCOPE_LENGTH ||
    value.includes('\0')
  ) {
    throw new RpcInputError(`${property} must be a non-empty bounded string.`);
  }
  return value;
}

function progressTokenFrom(params) {
  if (params._meta === undefined) {
    return undefined;
  }
  const meta = plainObject(params._meta, 'request metadata');
  if (!Object.prototype.hasOwnProperty.call(meta, 'progressToken')) {
    return undefined;
  }
  const token = meta.progressToken;
  if (!isRequestId(token)) {
    throw new RpcInputError('progressToken must be a string or safe integer.');
  }
  return token;
}

function plainObject(value, name) {
  if (!isPlainObject(value)) {
    throw new RpcInputError(`${name} must be an object.`);
  }
  return value;
}

function isPlainObject(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function requestIdFrom(message) {
  if (!isPlainObject(message) || !Object.prototype.hasOwnProperty.call(message, 'id')) {
    return undefined;
  }
  return isRequestId(message.id) ? message.id : undefined;
}

function isRequestId(value) {
  return (
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isSafeInteger(value) && !Object.is(value, -0))
  );
}

function requestKey(value) {
  return `${typeof value}:${String(value)}`;
}
