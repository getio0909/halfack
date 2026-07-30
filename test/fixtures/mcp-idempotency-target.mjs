import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const statePath = process.argv[2];
if (statePath === undefined) {
  process.stderr.write('state path is required\n');
  process.exit(64);
}

const DELAYED_COMMIT_MS = 500;
const pendingCancellations = new Map();

process.stdout.on('error', () => {
  process.exit(0);
});

const input = createInterface({
  crlfDelay: Infinity,
  input: process.stdin,
  terminal: false,
});

input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.exitCode = 65;
    input.close();
    return;
  }
  handleMessage(message);
});

function handleMessage(message) {
  if (message?.method === 'notifications/cancelled') {
    cancelPendingCommit(message.params?.requestId);
    return;
  }
  if (message?.method === 'server/discover') {
    respond(message.id, {
      capabilities: {
        tools: {},
      },
      supportedVersions: ['2026-07-28'],
    });
    return;
  }
  if (message?.method === 'tools/list') {
    respond(message.id, {
      tools: [tool('orders.create'), tool('orders.count'), tool('test.reset')],
    });
    return;
  }
  if (message?.method !== 'tools/call') {
    reject(message?.id, -32601, 'Method not supported.');
    return;
  }

  const name = message.params?.name;
  const arguments_ = message.params?.arguments ?? {};
  if (name === 'test.reset') {
    const scope = stringArgument(arguments_.scope);
    const state = loadState();
    state[scope] = {
      count: 0,
      seen: false,
    };
    saveState(state);
    respond(message.id, { content: [] });
    return;
  }
  if (name === 'orders.count') {
    const scope = stringArgument(arguments_.scope);
    const pending = findPendingCommit(scope);
    if (pending !== undefined) {
      pending.probeRequestIds.push(message.id);
      return;
    }
    respondWithCount(message.id, scope);
    return;
  }
  if (name === 'orders.create') {
    const scope = stringArgument(arguments_.clientToken);
    const progressToken = message.params?._meta?.progressToken;
    if (progressToken !== undefined) {
      notifyProgress(progressToken);
      schedulePendingCommit(message.id, scope);
      return;
    }

    commitEffect(scope);
    respond(message.id, { content: [] });
    return;
  }

  reject(message.id, -32602, 'Unknown tool.');
}

function tool(name) {
  return {
    inputSchema: {
      additionalProperties: true,
      type: 'object',
    },
    name,
  };
}

function loadState() {
  if (!existsSync(statePath)) {
    return {};
  }
  const source = readFileSync(statePath, 'utf8');
  return source.length === 0 ? {} : JSON.parse(source);
}

function saveState(state) {
  writeFileSync(statePath, JSON.stringify(state), 'utf8');
}

function stringArgument(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('A non-empty scope argument is required.');
  }
  return value;
}

function requestKey(value) {
  return `${typeof value}:${String(value)}`;
}

function schedulePendingCommit(requestId, scope) {
  const key = requestKey(requestId);
  const pending = {
    probeRequestIds: [],
    requestId,
    scope,
    timer: undefined,
  };
  pendingCancellations.set(key, pending);
  pending.timer = setTimeout(() => {
    if (pendingCancellations.get(key) !== pending) {
      return;
    }
    pendingCancellations.delete(key);
    commitEffect(scope);
    respond(requestId, { content: [] });
    flushPendingProbes(pending);
  }, DELAYED_COMMIT_MS);
}

function cancelPendingCommit(requestId) {
  const key = requestKey(requestId);
  const pending = pendingCancellations.get(key);
  if (pending === undefined) {
    return;
  }
  if (pending.timer !== undefined) {
    clearTimeout(pending.timer);
  }
  pendingCancellations.delete(key);
  flushPendingProbes(pending);
}

function findPendingCommit(scope) {
  for (const pending of pendingCancellations.values()) {
    if (pending.scope === scope) {
      return pending;
    }
  }
  return undefined;
}

function flushPendingProbes(pending) {
  for (const probeRequestId of pending.probeRequestIds) {
    respondWithCount(probeRequestId, pending.scope);
  }
  pending.probeRequestIds.length = 0;
}

function commitEffect(scope) {
  const state = loadState();
  const entry = state[scope] ?? {
    count: 0,
    seen: false,
  };
  if (!entry.seen) {
    entry.count += 1;
    entry.seen = true;
    state[scope] = entry;
    saveState(state);
  }
}

function respondWithCount(id, scope) {
  const entry = loadState()[scope] ?? {
    count: 0,
    seen: false,
  };
  respond(id, {
    content: [],
    structuredContent: {
      count: entry.count,
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

function reject(id, code, message) {
  write({
    error: {
      code,
      message,
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
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
