import { ClientCapabilitiesSchema, ImplementationSchema } from '@modelcontextprotocol/core';
import { MCP_PROTOCOL_VERSION } from '../config/scenario-schema.js';
import { VERSION } from '../version.js';

export const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
export const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
export const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';

const CLIENT_INFO: Readonly<{ name: string; version: string }> = Object.freeze(
  ImplementationSchema.parse({
    name: 'halfack',
    version: VERSION,
  }),
);

const CLIENT_CAPABILITIES: Readonly<Record<string, unknown>> = Object.freeze(
  ClientCapabilitiesSchema.parse({}),
);

export interface HalfAckRequestMeta extends Record<string, unknown> {
  readonly [CLIENT_CAPABILITIES_META_KEY]: typeof CLIENT_CAPABILITIES;
  readonly [CLIENT_INFO_META_KEY]: typeof CLIENT_INFO;
  readonly [PROTOCOL_VERSION_META_KEY]: typeof MCP_PROTOCOL_VERSION;
  readonly progressToken?: number | string;
}

export function createRequestMeta(progressToken?: number | string): HalfAckRequestMeta {
  if (
    progressToken !== undefined &&
    typeof progressToken !== 'string' &&
    !Number.isSafeInteger(progressToken)
  ) {
    throw new RangeError('progressToken must be a string or safe integer.');
  }

  const base = {
    [CLIENT_CAPABILITIES_META_KEY]: CLIENT_CAPABILITIES,
    [CLIENT_INFO_META_KEY]: CLIENT_INFO,
    [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
  } satisfies HalfAckRequestMeta;
  return progressToken === undefined
    ? base
    : {
        ...base,
        progressToken,
      };
}
