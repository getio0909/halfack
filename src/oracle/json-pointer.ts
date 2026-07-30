export type JsonPointerFailureReason =
  | 'array_index_out_of_bounds'
  | 'invalid_array_index'
  | 'invalid_syntax'
  | 'missing_member'
  | 'non_container'
  | 'unsupported_member';

const POINTER_ERROR_MESSAGE = 'The probe pointer could not be resolved safely.';
const ARRAY_INDEX_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const INVALID_ESCAPE_PATTERN = /~(?![01])/u;

export class JsonPointerError extends Error {
  public constructor(public readonly reason: JsonPointerFailureReason) {
    super(POINTER_ERROR_MESSAGE);
    this.name = new.target.name;
  }
}

export function parseStructuredContentPointer(pointer: string): readonly string[] {
  if (
    (pointer !== '/structuredContent' && !pointer.startsWith('/structuredContent/')) ||
    INVALID_ESCAPE_PATTERN.test(pointer)
  ) {
    throw new JsonPointerError('invalid_syntax');
  }

  const tokens = pointer
    .slice(1)
    .split('/')
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
  return Object.freeze(tokens);
}

export function resolveStructuredContentPointer(document: unknown, pointer: string): unknown {
  const tokens = parseStructuredContentPointer(pointer);
  let current = document;

  for (const token of tokens) {
    if (Array.isArray(current)) {
      current = readArrayMember(current, token);
      continue;
    }
    if (current !== null && typeof current === 'object') {
      current = readObjectMember(current, token);
      continue;
    }
    throw new JsonPointerError('non_container');
  }

  return current;
}

function readArrayMember(array: readonly unknown[], token: string): unknown {
  if (!ARRAY_INDEX_PATTERN.test(token)) {
    throw new JsonPointerError('invalid_array_index');
  }

  const index = Number(token);
  if (!Number.isSafeInteger(index)) {
    throw new JsonPointerError('invalid_array_index');
  }
  if (index >= array.length) {
    throw new JsonPointerError('array_index_out_of_bounds');
  }

  const descriptor = getOwnDescriptor(array, token);
  if (descriptor === undefined) {
    throw new JsonPointerError('array_index_out_of_bounds');
  }
  if (!('value' in descriptor)) {
    throw new JsonPointerError('unsupported_member');
  }
  return descriptor.value;
}

function readObjectMember(object: object, token: string): unknown {
  const descriptor = getOwnDescriptor(object, token);
  if (descriptor === undefined) {
    throw new JsonPointerError('missing_member');
  }
  if (!('value' in descriptor)) {
    throw new JsonPointerError('unsupported_member');
  }
  return descriptor.value;
}

function getOwnDescriptor(object: object, property: PropertyKey): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(object, property);
  } catch {
    throw new JsonPointerError('unsupported_member');
  }
}
