import { describe, expect, it } from 'vitest';
import { NdjsonDecoder, type DecodedNdjsonFrame } from '../../src/transport/ndjson-decoder.js';
import { NdjsonProtocolError } from '../../src/transport/errors.js';

const encoder = new TextEncoder();

function messages(frames: readonly DecodedNdjsonFrame[]): readonly Record<string, unknown>[] {
  return frames.map((frame) => frame.message);
}

describe('NdjsonDecoder', () => {
  it('decodes multiple newline-delimited objects from one chunk', () => {
    const decoder = new NdjsonDecoder();

    const frames = decoder.push(encoder.encode('{"first":1}\n{"second":2}\n'));

    expect(messages(frames)).toEqual([{ first: 1 }, { second: 2 }]);
    expect(frames.map((frame) => frame.byteLength)).toEqual([11, 12]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it('delivers frames incrementally and stops the current chunk at consumer capacity', () => {
    const decoder = new NdjsonDecoder();
    const capacityFailure = new Error('consumer capacity reached');
    const wire = encoder.encode('{}\n'.repeat(20_000));
    let delivered = 0;

    expect(() =>
      decoder.pushEach(wire, () => {
        delivered += 1;
        if (delivered === 257) {
          throw capacityFailure;
        }
      }),
    ).toThrow(capacityFailure);
    expect(delivered).toBe(257);
    expect(decoder.bufferedBlockCount).toBe(0);
    expect(decoder.bufferedByteLength).toBe(0);
  });

  it('reassembles a frame split across arbitrary chunks', () => {
    const decoder = new NdjsonDecoder();

    expect(decoder.push(encoder.encode('{"value":'))).toEqual([]);
    expect(messages(decoder.push(encoder.encode('"ready"}\n')))).toEqual([{ value: 'ready' }]);
  });

  it('preserves a UTF-8 code point split between chunks', () => {
    const decoder = new NdjsonDecoder();
    const wire = encoder.encode('{"emoji":"🧪"}\n');
    const splitAt = wire.indexOf(0xf0) + 2;

    expect(decoder.push(wire.subarray(0, splitAt))).toEqual([]);
    expect(messages(decoder.push(wire.subarray(splitAt)))).toEqual([{ emoji: '🧪' }]);
  });

  it('accepts CRLF framing without retaining the carriage return', () => {
    const decoder = new NdjsonDecoder();

    expect(messages(decoder.push(encoder.encode('{"ok":true}\r\n')))).toEqual([{ ok: true }]);
  });

  it('does not count the CRLF delimiter against the payload byte limit', () => {
    const source = '{"ok":true}';
    const decoder = new NdjsonDecoder({ maxFrameBytes: encoder.encode(source).byteLength });

    const frames = decoder.push(encoder.encode(`${source}\r\n`));

    expect(messages(frames)).toEqual([{ ok: true }]);
    expect(frames[0]?.byteLength).toBe(encoder.encode(source).byteLength);
  });

  it.each([
    ['an empty line', '\n', /empty/i],
    ['a whitespace-only line', ' \t\n', /JSON object/i],
    ['malformed JSON', '{"broken":}\n', /valid JSON/i],
    ['a batch array', '[{"jsonrpc":"2.0"}]\n', /JSON object/i],
    ['a primitive', '42\n', /JSON object/i],
    ['a null value', 'null\n', /JSON object/i],
  ])('rejects %s', (_name, source, expectedMessage) => {
    const decoder = new NdjsonDecoder();

    expect(() => decoder.push(encoder.encode(source))).toThrow(expectedMessage);
  });

  it('rejects invalid UTF-8 rather than inserting replacement characters', () => {
    const decoder = new NdjsonDecoder();

    expect(() => decoder.push(Uint8Array.from([0xc3, 0x28, 0x0a]))).toThrow(/UTF-8/i);
  });

  it('enforces its frame limit in bytes across chunks', () => {
    const decoder = new NdjsonDecoder({ maxFrameBytes: 12 });

    expect(decoder.push(encoder.encode('{"value":'))).toEqual([]);
    expect(() => decoder.push(encoder.encode('"toolong"}\n'))).toThrow(/12 bytes/i);
  });

  it('counts UTF-8 bytes rather than JavaScript characters', () => {
    const decoder = new NdjsonDecoder({ maxFrameBytes: 12 });

    expect(() => decoder.push(encoder.encode('{"值":"界"}\n'))).toThrow(/12 bytes/i);
  });

  it('rejects a raw newline embedded in a JSON string as broken framing', () => {
    const decoder = new NdjsonDecoder();

    expect(() => decoder.push(encoder.encode('{"line":"first\nsecond"}\n'))).toThrow(/valid JSON/i);
  });

  it('accepts a frame exactly at its byte limit', () => {
    const source = '{"ok":true}';
    const decoder = new NdjsonDecoder({ maxFrameBytes: encoder.encode(source).byteLength });

    expect(messages(decoder.push(encoder.encode(`${source}\n`)))).toEqual([{ ok: true }]);
  });

  it('uses a bounded number of accumulator blocks for one-byte chunks', () => {
    const decoder = new NdjsonDecoder({ maxFrameBytes: 200_000 });
    for (let index = 0; index < 100_000; index += 1) {
      decoder.push(Uint8Array.of(0x20));
    }

    expect(decoder.bufferedByteLength).toBe(100_000);
    expect(decoder.bufferedBlockCount).toBeLessThanOrEqual(2);
    expect(messages(decoder.push(encoder.encode('{"ok":true}\n')))).toEqual([{ ok: true }]);
    expect(decoder.bufferedBlockCount).toBe(0);
  });

  it('rejects an unterminated final frame at EOF', () => {
    const decoder = new NdjsonDecoder();
    decoder.push(encoder.encode('{"ambiguous":true}'));

    expect(() => decoder.finish()).toThrow(/incomplete/i);
  });

  it('cannot be reused after a protocol failure', () => {
    const decoder = new NdjsonDecoder();
    let firstError: unknown;
    try {
      decoder.push(encoder.encode('not-json\n'));
    } catch (error: unknown) {
      firstError = error;
    }

    expect(firstError).toBeInstanceOf(NdjsonProtocolError);
    expect(() => decoder.push(encoder.encode('{"ok":true}\n'))).toThrow(firstError);
  });

  it('finishes idempotently and rejects data after EOF', () => {
    const decoder = new NdjsonDecoder();

    decoder.finish();
    expect(() => decoder.finish()).not.toThrow();
    expect(() => decoder.push(encoder.encode('{"late":true}\n'))).toThrow(/finished/i);
  });
});
