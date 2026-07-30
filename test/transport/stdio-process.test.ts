import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { TargetError } from '../../src/domain/errors.js';
import {
  buildAllowedEnvironment,
  StdioProcessTransport,
  TargetProcessStartError,
  type StdioProcessOptions,
} from '../../src/transport/stdio-process.js';
import {
  NdjsonProtocolError,
  TransportCapacityError,
  TransportClosedError,
} from '../../src/transport/errors.js';

const fixturePath = fileURLToPath(new URL('../fixtures/stdio-target.mjs', import.meta.url));
const openTransports: StdioProcessTransport[] = [];
const temporaryDirectories: string[] = [];

function options(mode: string, overrides: Partial<StdioProcessOptions> = {}): StdioProcessOptions {
  return {
    args: [fixturePath, mode],
    command: process.execPath,
    cwd: path.dirname(fixturePath),
    envAllowlist: ['PATH', 'SystemRoot'],
    shutdownMs: 200,
    ...overrides,
  };
}

async function start(
  mode: string,
  overrides: Partial<StdioProcessOptions> = {},
): Promise<StdioProcessTransport> {
  const transport = await StdioProcessTransport.start(options(mode, overrides));
  openTransports.push(transport);
  return transport;
}

afterEach(async () => {
  await Promise.allSettled([
    ...openTransports.splice(0).map((transport) => transport.close()),
    ...temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  ]);
});

describe('buildAllowedEnvironment', () => {
  it('copies only explicitly allowed defined variables', () => {
    const source: NodeJS.ProcessEnv = {
      ALLOWED: 'visible',
      SECRET_TOKEN: 'must-not-leak',
      UNDEFINED_VALUE: undefined,
    };

    expect(buildAllowedEnvironment(['ALLOWED', 'UNDEFINED_VALUE'], source, 'linux')).toEqual({
      ALLOWED: 'visible',
    });
  });

  it('matches Windows environment names case-insensitively without copying extras', () => {
    const source: NodeJS.ProcessEnv = {
      Path: 'C:\\safe',
      SECRET_TOKEN: 'must-not-leak',
    };

    expect(buildAllowedEnvironment(['PATH'], source, 'win32')).toEqual({
      PATH: 'C:\\safe',
    });
  });

  it('rejects duplicate Windows names that would collide in the child environment', () => {
    expect(() => buildAllowedEnvironment(['Path', 'PATH'], { Path: 'C:\\safe' }, 'win32')).toThrow(
      /duplicate/i,
    );
  });
});

describe('StdioProcessTransport', () => {
  it('passes metacharacters as literal argv/data with shell execution disabled', async () => {
    const transport = await start('echo');
    const message = { literal: 'a&b;$(whoami)|`ignored`' };

    await transport.send(message);

    expect(await transport.receive()).toEqual({ received: message });
  });

  it('serializes concurrent writes and returns local-pipe receipts in order', async () => {
    const transport = await start('echo');
    const messages = Array.from({ length: 64 }, (_, index) => ({
      index,
      payload: 'x'.repeat(2_048),
    }));

    const receipts = await Promise.all(messages.map((message) => transport.send(message)));
    const received = await Promise.all(messages.map(() => transport.receive()));

    expect(receipts.map((receipt) => receipt.sequence)).toEqual(
      Array.from({ length: messages.length }, (_, index) => index + 1),
    );
    expect(receipts.map((receipt) => receipt.acceptedByLocalPipe)).toEqual(
      Array.from({ length: messages.length }, () => true),
    );
    expect(received).toEqual(messages.map((message) => ({ received: message })));
  });

  it('drains stderr concurrently and caps the in-memory diagnostic tail', async () => {
    const transport = await start('stderr-flood', {
      limits: {
        maxStderrBytes: 1_024,
      },
    });

    await transport.send({ ping: true });
    expect(await transport.receive()).toEqual({ received: { ping: true } });
    const summary = await transport.close();

    expect(Buffer.byteLength(summary.stderr.text)).toBeLessThanOrEqual(1_024);
    expect(summary.stderr.truncated).toBe(true);
    expect(summary.stderr.totalBytes).toBe(128 * 1_024);
  });

  it('does not treat child exit as EOF while inherited stdout is still open', async () => {
    const transport = await start('inherited-stdout');

    expect(await transport.receive()).toEqual({ afterParentExit: true });
    const summary = await transport.close();

    expect(summary.code).toBe(0);
    expect(summary.stdoutEnded).toBe(true);
    expect(summary.termination).toBe('natural');
  });

  it('reports a partial final frame instead of silently discarding it', async () => {
    const transport = await start('partial');

    await expect(transport.receive()).rejects.toBeInstanceOf(NdjsonProtocolError);
  });

  it('reports invalid target UTF-8 as a protocol failure', async () => {
    const transport = await start('invalid-utf8');

    await expect(transport.receive()).rejects.toThrow(/UTF-8/i);
  });

  it('fails closed when decoded messages exceed the bounded receive queue', async () => {
    const transport = await start('queued', {
      args: [fixturePath, 'queued', '32'],
      limits: {
        maxQueuedBytes: 1_024,
        maxQueuedMessages: 2,
      },
    });

    await expect(transport.receive()).resolves.toEqual({ index: 0 });
    await expect(transport.receive()).rejects.toBeInstanceOf(TransportCapacityError);
  });

  it('closes idempotently and escalates a target that ignores stdin EOF', async () => {
    const transport = await start('ignore-eof', { shutdownMs: 50 });
    const startedAt = Date.now();

    const first = transport.close();
    const second = transport.close();
    const [firstSummary, secondSummary] = await Promise.all([first, second]);

    expect(secondSummary).toEqual(firstSummary);
    expect(firstSummary.termination).toMatch(/^(?:terminate|kill)$/u);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await expect(transport.receive()).rejects.toBeInstanceOf(TransportClosedError);
  });

  it('does not relabel an already-started close as a disconnect', async () => {
    const transport = await start('ignore-eof', { shutdownMs: 50 });

    const closing = transport.close();

    expect(() => transport.disconnect()).toThrow(TransportClosedError);
    const summary = await closing;
    expect(summary.termination).not.toBe('disconnect');
  });

  it('disconnects immediately, rejects pending I/O, and still bounds process cleanup', async () => {
    const transport = await start('ignore-eof', { shutdownMs: 50 });
    const pendingReceive = expect(transport.receive()).rejects.toBeInstanceOf(TransportClosedError);
    const startedAt = Date.now();

    const summary = await transport.disconnect();

    await pendingReceive;
    await expect(transport.send({ tooLate: true })).rejects.toBeInstanceOf(TransportClosedError);
    expect(summary.termination).toMatch(/^(?:terminate|kill)$/u);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('drops local pipes immediately without treating local acceptance as a commit', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'halfack-disconnect-'));
    temporaryDirectories.push(directory);
    const markerPath = path.join(directory, 'committed.txt');
    const transport = await start('commit-after-disconnect', {
      args: [fixturePath, 'commit-after-disconnect', markerPath],
      shutdownMs: 1_000,
    });
    await transport.send({ mutate: true });
    const pendingReceive = expect(transport.receive()).rejects.toBeInstanceOf(TransportClosedError);
    const startedAt = Date.now();

    const summary = await transport.disconnect();

    await pendingReceive;
    const marker = await readFile(markerPath, 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error instanceof Error ? error : new Error('Marker inspection failed.');
    });
    expect(marker === undefined || marker === 'committed').toBe(true);
    expect(summary.termination).toMatch(/^(?:disconnect|kill|terminate)$/u);
    expect(summary.directProcessTermination).toBe('confirmed');
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it('bounds close even while an active backpressured write cannot drain', async () => {
    const transport = await start('blocked-stdin', { shutdownMs: 50 });
    const sent = transport.send({ payload: 'x'.repeat(900 * 1_024) });
    const rejectedWrite = expect(sent).rejects.toBeInstanceOf(TransportClosedError);

    const summary = await transport.close();

    expect(summary.termination).toMatch(/terminate|kill/);
    await rejectedWrite;
  });

  it('automatically escalates cleanup after a fatal stdout protocol error', async () => {
    const transport = await start('invalid-then-hang', { shutdownMs: 50 });
    const startedAt = Date.now();

    await expect(transport.receive()).rejects.toThrow(/UTF-8/i);
    const summary = await transport.close();

    expect(summary.termination).toMatch(/^(?:terminate|kill)$/u);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('normalizes spawn failures without echoing the command', async () => {
    const command = path.join(path.dirname(fixturePath), 'definitely-missing-halfack-target');

    let caught: unknown;
    try {
      await StdioProcessTransport.start(options('echo', { command }));
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TargetError);
    expect(caught).toBeInstanceOf(TargetProcessStartError);
    expect((caught as TargetProcessStartError).directProcessTermination).toBe('not_started');
    expect((caught as Error).message).toMatch(/start target/i);
    expect((caught as Error).message).not.toContain(command);
  });

  it('rejects invalid spawn-event deadlines before creating a process', async () => {
    await expect(
      StdioProcessTransport.start(
        options('echo', {
          spawnEventTimeoutMs: 0,
        }),
      ),
    ).rejects.toBeInstanceOf(TargetError);
  });

  it('classifies a pre-aborted startup as not started', async () => {
    const controller = new AbortController();
    controller.abort();

    let caught: unknown;
    try {
      await StdioProcessTransport.start(options('echo', { signal: controller.signal }));
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(TargetProcessStartError);
    expect((caught as TargetProcessStartError).directProcessTermination).toBe('not_started');
  });

  it('clears the spawn-event deadline after a healthy long-lived process starts', async () => {
    const transport = await start('ignore-eof', {
      shutdownMs: 50,
      spawnEventTimeoutMs: 100,
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 125);
    });
    const summary = await transport.close();

    expect(summary.directProcessTermination).toBe('confirmed');
  });

  it('rejects writes after close and never labels them as remotely acknowledged', async () => {
    const transport = await start('echo');
    await transport.close();

    await expect(transport.send({ tooLate: true })).rejects.toBeInstanceOf(TransportClosedError);
  });
});
