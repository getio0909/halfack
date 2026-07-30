import { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TransportCapacityError,
  TransportClosedError,
  TransportWriteError,
} from '../../src/transport/errors.js';
import { SerializedNdjsonWriter } from '../../src/transport/serialized-writer.js';

interface ManualWrite {
  readonly callback: (error?: Error | null) => void;
  readonly chunk: Buffer;
}

class ManualWritable extends EventEmitter {
  public readonly writes: ManualWrite[] = [];
  public returnValues: boolean[] = [];
  public throwOnWrite: Error | undefined;

  public write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean {
    if (this.throwOnWrite !== undefined) {
      throw this.throwOnWrite;
    }
    this.writes.push({ callback, chunk: Buffer.from(chunk) });
    return this.returnValues.shift() ?? true;
  }
}

const writers: SerializedNdjsonWriter[] = [];

function createWriter(
  endpoint: ManualWritable,
  overrides: Partial<{
    readonly maxFrameBytes: number;
    readonly maxQueuedBytes: number;
    readonly maxQueuedMessages: number;
  }> = {},
): SerializedNdjsonWriter {
  const writer = new SerializedNdjsonWriter(endpoint as unknown as Writable, {
    maxFrameBytes: 1_024,
    maxQueuedBytes: 4_096,
    maxQueuedMessages: 8,
    ...overrides,
  });
  writers.push(writer);
  return writer;
}

afterEach(() => {
  for (const writer of writers.splice(0)) {
    writer.dispose();
  }
});

describe('SerializedNdjsonWriter', () => {
  it('waits for both callback and drain before starting the next write', async () => {
    const endpoint = new ManualWritable();
    endpoint.returnValues = [false, true];
    const writer = createWriter(endpoint);

    const first = writer.send({ index: 1 });
    const second = writer.send({ index: 2 });
    expect(endpoint.writes).toHaveLength(1);

    endpoint.writes[0]?.callback();
    expect(endpoint.writes).toHaveLength(1);

    endpoint.emit('drain');
    expect(endpoint.writes).toHaveLength(2);
    endpoint.writes[1]?.callback();

    await expect(first).resolves.toMatchObject({ sequence: 1 });
    await expect(second).resolves.toMatchObject({ sequence: 2 });
  });

  it('also handles drain arriving before the write callback', async () => {
    const endpoint = new ManualWritable();
    endpoint.returnValues = [false, true];
    const writer = createWriter(endpoint);

    const first = writer.send({ index: 1 });
    const second = writer.send({ index: 2 });
    endpoint.emit('drain');
    expect(endpoint.writes).toHaveLength(1);

    endpoint.writes[0]?.callback();
    expect(endpoint.writes).toHaveLength(2);
    endpoint.writes[1]?.callback();

    await expect(first).resolves.toMatchObject({ sequence: 1 });
    await expect(second).resolves.toMatchObject({ sequence: 2 });
  });

  it('rejects the active and queued writes with one typed stream error', async () => {
    const endpoint = new ManualWritable();
    endpoint.returnValues = [false];
    const writer = createWriter(endpoint);
    const first = writer.send({ index: 1 });
    const second = writer.send({ index: 2 });

    endpoint.emit('error', new Error('canary-private-stream-detail'));

    const [firstResult, secondResult] = await Promise.allSettled([first, second]);
    expect(firstResult.status).toBe('rejected');
    expect(secondResult.status).toBe('rejected');
    if (firstResult.status === 'rejected' && secondResult.status === 'rejected') {
      expect(firstResult.reason).toBeInstanceOf(TransportWriteError);
      expect(secondResult.reason).toBe(firstResult.reason);
      expect((firstResult.reason as Error).message).not.toContain('canary-private-stream-detail');
    }
  });

  it('catches a synchronous writable.write failure', async () => {
    const endpoint = new ManualWritable();
    endpoint.throwOnWrite = new Error('synchronous canary');
    const writer = createWriter(endpoint);

    await expect(writer.send({ valid: true })).rejects.toBeInstanceOf(TransportWriteError);
  });

  it.each([
    [
      'circular data',
      () => {
        const value: Record<string, unknown> = {};
        value['self'] = value;
        return value;
      },
    ],
    ['BigInt data', () => ({ value: 1n })],
    ['a toJSON undefined result', () => ({ toJSON: () => undefined })],
    ['a toJSON array result', () => ({ toJSON: () => ['not', 'an', 'object'] })],
    ['a toJSON primitive result', () => ({ toJSON: () => 42 })],
  ])('rejects %s before touching the writable', async (_name, createMessage) => {
    const endpoint = new ManualWritable();
    const writer = createWriter(endpoint);

    await expect(writer.send(createMessage())).rejects.toBeInstanceOf(TransportWriteError);
    expect(endpoint.writes).toEqual([]);
  });

  it('rejects oversized outbound frames before touching the writable', async () => {
    const endpoint = new ManualWritable();
    const writer = createWriter(endpoint, { maxFrameBytes: 16 });

    await expect(writer.send({ value: 'x'.repeat(32) })).rejects.toBeInstanceOf(
      TransportCapacityError,
    );
    expect(endpoint.writes).toEqual([]);
  });

  it('bounds the outbound queue by message count', async () => {
    const endpoint = new ManualWritable();
    endpoint.returnValues = [false];
    const writer = createWriter(endpoint, { maxQueuedMessages: 2 });
    const first = writer.send({ index: 1 });
    const second = writer.send({ index: 2 });

    await expect(writer.send({ index: 3 })).rejects.toBeInstanceOf(TransportCapacityError);
    writer.abort(new TransportClosedError());
    await Promise.allSettled([first, second]);
  });

  it('finish waits for accepted writes and then rejects new writes', async () => {
    const endpoint = new ManualWritable();
    const writer = createWriter(endpoint);
    const sent = writer.send({ final: true });
    const finished = writer.finish();

    await expect(writer.send({ late: true })).rejects.toBeInstanceOf(TransportClosedError);
    endpoint.writes[0]?.callback();

    await expect(sent).resolves.toMatchObject({
      acceptedByLocalPipe: true,
      sequence: 1,
    });
    await expect(finished).resolves.toBeUndefined();
  });
});
