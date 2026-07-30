import { describe, expect, it } from 'vitest';
import { TransportCapacityError, TransportClosedError } from '../../src/transport/errors.js';
import { BoundedMessageQueue } from '../../src/transport/message-queue.js';

function createQueue(maxPendingReceives = 2): BoundedMessageQueue {
  return new BoundedMessageQueue({
    maxBytes: 1_024,
    maxMessages: 8,
    maxPendingReceives,
  });
}

describe('BoundedMessageQueue', () => {
  it('bounds pending receive calls as well as queued messages', async () => {
    const queue = createQueue();
    const first = queue.receive();
    const second = queue.receive();

    await expect(queue.receive()).rejects.toBeInstanceOf(TransportCapacityError);

    const closed = new TransportClosedError();
    queue.fail(closed);
    await expect(first).rejects.toBe(closed);
    await expect(second).rejects.toBe(closed);
  });

  it('drains complete queued messages before reporting normal closure', async () => {
    const queue = createQueue();
    queue.push({ index: 1 }, 10);
    queue.push({ index: 2 }, 10);
    queue.end();

    await expect(queue.receive()).resolves.toEqual({ index: 1 });
    await expect(queue.receive()).resolves.toEqual({ index: 2 });
    await expect(queue.receive()).rejects.toBeInstanceOf(TransportClosedError);
  });
});
