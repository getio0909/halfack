import { NdjsonProtocolError } from './errors.js';

export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

export interface NdjsonDecoderOptions {
  readonly maxFrameBytes?: number;
}

export interface DecodedNdjsonFrame {
  readonly byteLength: number;
  readonly message: Record<string, unknown>;
}

export type NdjsonFrameConsumer = (frame: DecodedNdjsonFrame) => void;

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const ACCUMULATOR_BLOCK_BYTES = 64 * 1024;

export class NdjsonDecoder {
  readonly #blocks: Buffer[] = [];
  readonly #maxFrameBytes: number;
  #bufferedBytes = 0;
  #failure: NdjsonProtocolError | undefined;
  #finished = false;
  #tail: Buffer | undefined;
  #tailLength = 0;

  public constructor(options: NdjsonDecoderOptions = {}) {
    const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    if (
      !Number.isSafeInteger(maxFrameBytes) ||
      maxFrameBytes < 1 ||
      maxFrameBytes >= Number.MAX_SAFE_INTEGER
    ) {
      throw new RangeError('maxFrameBytes must be a positive safe integer.');
    }
    this.#maxFrameBytes = maxFrameBytes;
  }

  public get bufferedBlockCount(): number {
    return this.#blocks.length + (this.#tail === undefined ? 0 : 1);
  }

  public get bufferedByteLength(): number {
    return this.#bufferedBytes;
  }

  public push(chunk: Uint8Array): readonly DecodedNdjsonFrame[] {
    const frames: DecodedNdjsonFrame[] = [];
    this.pushEach(chunk, (frame) => {
      frames.push(frame);
    });
    return frames;
  }

  public pushEach(chunk: Uint8Array, consumer: NdjsonFrameConsumer): void {
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    if (this.#finished) {
      throw new NdjsonProtocolError('Cannot decode target output after the stream has finished.');
    }
    if (!(chunk instanceof Uint8Array)) {
      this.#fail(new NdjsonProtocolError('Target stdout produced a non-binary data chunk.'));
    }
    if (typeof consumer !== 'function') {
      throw new TypeError('NDJSON frame consumer must be a function.');
    }
    if (chunk.byteLength === 0) {
      return;
    }

    try {
      this.#decodeChunk(chunk, consumer);
    } catch (error: unknown) {
      if (error instanceof FrameConsumerFailure) {
        throw error.consumerCause instanceof Error
          ? error.consumerCause
          : new TypeError('NDJSON frame consumer failed.', { cause: error.consumerCause });
      }
      if (error instanceof NdjsonProtocolError) {
        this.#fail(error);
      }
      this.#fail(
        new NdjsonProtocolError('Target stdout could not be decoded safely.', { cause: error }),
      );
    }
  }

  public finish(): void {
    if (this.#failure !== undefined) {
      throw this.#failure;
    }
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    if (this.#bufferedBytes !== 0) {
      this.#fail(new NdjsonProtocolError('Target stdout ended with an incomplete MCP frame.'));
    }
  }

  #decodeChunk(chunk: Uint8Array, consumer: NdjsonFrameConsumer): void {
    const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let offset = 0;

    while (offset < buffer.byteLength) {
      const newlineIndex = buffer.indexOf(NEWLINE, offset);
      if (newlineIndex === -1) {
        this.#append(buffer.subarray(offset));
        break;
      }

      const segment = buffer.subarray(offset, newlineIndex);
      const frame =
        this.#bufferedBytes === 0
          ? this.#completeDirectFrame(segment)
          : this.#completeBufferedFrame(segment);
      try {
        consumer(frame);
      } catch (error: unknown) {
        throw new FrameConsumerFailure(error);
      }
      offset = newlineIndex + 1;
    }
  }

  #append(segment: Buffer): void {
    if (segment.byteLength === 0) {
      return;
    }

    const nextSize = this.#bufferedBytes + segment.byteLength;
    const isPotentialCrLf =
      nextSize === this.#maxFrameBytes + 1 && segment.at(-1) === CARRIAGE_RETURN;
    if (nextSize > this.#maxFrameBytes && !isPotentialCrLf) {
      throw new NdjsonProtocolError(
        `Target stdout frame exceeds the ${String(this.#maxFrameBytes)} bytes limit.`,
      );
    }

    let offset = 0;
    while (offset < segment.byteLength) {
      if (this.#tail === undefined) {
        const remainingCapacity = this.#maxFrameBytes + 1 - this.#bufferedBytes;
        this.#tail = Buffer.allocUnsafe(Math.min(ACCUMULATOR_BLOCK_BYTES, remainingCapacity));
        this.#tailLength = 0;
      }

      const writableBytes = this.#tail.byteLength - this.#tailLength;
      const copyBytes = Math.min(writableBytes, segment.byteLength - offset);
      segment.copy(this.#tail, this.#tailLength, offset, offset + copyBytes);
      this.#tailLength += copyBytes;
      this.#bufferedBytes += copyBytes;
      offset += copyBytes;

      if (this.#tailLength === this.#tail.byteLength) {
        this.#blocks.push(this.#tail);
        this.#tail = undefined;
        this.#tailLength = 0;
      }
    }
  }

  #completeBufferedFrame(finalSegment: Buffer): DecodedNdjsonFrame {
    this.#append(finalSegment);
    if (this.#bufferedBytes === 0) {
      throw new NdjsonProtocolError('Target stdout contained an empty MCP frame.');
    }

    const parts = [...this.#blocks];
    if (this.#tail !== undefined && this.#tailLength !== 0) {
      parts.push(this.#tail.subarray(0, this.#tailLength));
    }

    let bytes: Buffer;
    if (parts.length === 1) {
      const onlyPart = parts.at(0);
      if (onlyPart === undefined) {
        throw new NdjsonProtocolError('Target stdout decoder lost buffered frame data.');
      }
      bytes = onlyPart;
    } else {
      bytes = Buffer.concat(parts, this.#bufferedBytes);
    }

    const hasCrLfDelimiter = bytes.at(-1) === CARRIAGE_RETURN;
    const wireByteLength = this.#bufferedBytes - (hasCrLfDelimiter ? 1 : 0);
    this.#resetBuffer();

    if (hasCrLfDelimiter) {
      bytes = bytes.subarray(0, -1);
    }
    return this.#decodeFrame(bytes, wireByteLength);
  }

  #completeDirectFrame(segment: Buffer): DecodedNdjsonFrame {
    const hasCrLfDelimiter = segment.at(-1) === CARRIAGE_RETURN;
    const bytes = hasCrLfDelimiter ? segment.subarray(0, -1) : segment;
    if (bytes.byteLength > this.#maxFrameBytes) {
      throw new NdjsonProtocolError(
        `Target stdout frame exceeds the ${String(this.#maxFrameBytes)} bytes limit.`,
      );
    }
    return this.#decodeFrame(bytes, bytes.byteLength);
  }

  #decodeFrame(bytes: Buffer, wireByteLength: number): DecodedNdjsonFrame {
    if (bytes.byteLength === 0) {
      throw new NdjsonProtocolError('Target stdout contained an empty MCP frame.');
    }

    let source: string;
    try {
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (error: unknown) {
      throw new NdjsonProtocolError('Target stdout frame is not valid UTF-8.', {
        cause: error,
      });
    }

    if (source.trim().length === 0) {
      throw new NdjsonProtocolError('Target stdout frame must contain a JSON object.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(source) as unknown;
    } catch (error: unknown) {
      throw new NdjsonProtocolError('Target stdout frame is not valid JSON.', {
        cause: error,
      });
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new NdjsonProtocolError('Target stdout frame must contain a JSON object.');
    }

    return {
      byteLength: wireByteLength,
      message: parsed as Record<string, unknown>,
    };
  }

  #fail(error: NdjsonProtocolError): never {
    this.#failure = error;
    this.#resetBuffer();
    throw error;
  }

  #resetBuffer(): void {
    this.#blocks.length = 0;
    this.#bufferedBytes = 0;
    this.#tail = undefined;
    this.#tailLength = 0;
  }
}

class FrameConsumerFailure extends Error {
  public constructor(public readonly consumerCause: unknown) {
    super('NDJSON frame consumer failed.');
  }
}
