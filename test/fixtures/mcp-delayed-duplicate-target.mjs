import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const statePath = process.argv[2];
if (statePath === undefined) {
  process.stderr.write('state path is required\n');
  process.exit(64);
}

const DELAYED_DUPLICATE_MS = 250;
const createCounts = new Map();

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

  try {
    handleMessage(message);
  } catch {
    if (isRequestId(message?.id)) {
      reject(message.id, -32_603, 'The delayed-duplicate fixture failed.');
      return;
    }
    process.exitCode = 70;
    input.close();
  }
});

function handleMessage(message) {
  if (message?.method === 'notifications/cancelled') {
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
    reject(message?.id, -32_601, 'Method not supported.');
    return;
  }

  const name = message.params?.name;
  const arguments_ = message.params?.arguments ?? {};
  if (name === 'test.reset') {
    const scope = stringArgument(arguments_.scope);
    setCount(scope, 0);
    respond(message.id, { content: [] });
    return;
  }
  if (name === 'orders.count') {
    const scope = stringArgument(arguments_.scope);
    respond(message.id, {
      content: [],
      structuredContent: {
        count: getCount(scope),
      },
    });
    return;
  }
  if (name === 'orders.create') {
    const scope = stringArgument(arguments_.clientToken);
    const callCount = (createCounts.get(scope) ?? 0) + 1;
    createCounts.set(scope, callCount);

    if (callCount === 1) {
      incrementCount(scope);
      respond(message.id, { content: [] });
      return;
    }

    respond(message.id, { content: [] });
    setTimeout(() => {
      try {
        incrementCount(scope);
      } catch {
        process.exitCode = 70;
      }
    }, DELAYED_DUPLICATE_MS);
    return;
  }

  reject(message.id, -32_602, 'Unknown tool.');
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
  if (source.length === 0) {
    return {};
  }
  const parsed = JSON.parse(source);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('The delayed-duplicate state file is invalid.');
  }
  return parsed;
}

function saveState(state) {
  writeFileSync(statePath, JSON.stringify(state), {
    encoding: 'utf8',
    flush: true,
    mode: 0o600,
  });
}

function getCount(scope) {
  const value = loadState()[scope];
  if (value === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('The delayed-duplicate counter is invalid.');
  }
  return value;
}

function setCount(scope, count) {
  const state = loadState();
  state[scope] = count;
  saveState(state);
}

function incrementCount(scope) {
  setCount(scope, getCount(scope) + 1);
}

function stringArgument(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('A non-empty scope argument is required.');
  }
  return value;
}

function isRequestId(value) {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
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

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
