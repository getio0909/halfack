import { describe, expect, it } from 'vitest';
import {
  JsonPointerError,
  resolveStructuredContentPointer,
} from '../../src/oracle/json-pointer.js';

describe('resolveStructuredContentPointer', () => {
  it('resolves the structured content root and nested object members', () => {
    const result = {
      structuredContent: {
        count: 3,
        nested: { value: 7 },
      },
    };

    expect(resolveStructuredContentPointer(result, '/structuredContent')).toEqual(
      result.structuredContent,
    );
    expect(resolveStructuredContentPointer(result, '/structuredContent/nested/value')).toBe(7);
  });

  it('decodes RFC 6901 escapes in the required order', () => {
    const result = {
      structuredContent: {
        'a/b': {
          '~key': 11,
          '~1': 13,
        },
      },
    };

    expect(resolveStructuredContentPointer(result, '/structuredContent/a~1b/~0key')).toBe(11);
    expect(resolveStructuredContentPointer(result, '/structuredContent/a~1b/~01')).toBe(13);
  });

  it('supports an empty object member token', () => {
    expect(
      resolveStructuredContentPointer({ structuredContent: { '': 17 } }, '/structuredContent/'),
    ).toBe(17);
  });

  it('distinguishes object keys from canonical array indices', () => {
    expect(
      resolveStructuredContentPointer(
        { structuredContent: { '01': 'object-member' } },
        '/structuredContent/01',
      ),
    ).toBe('object-member');
    expect(
      resolveStructuredContentPointer(
        { structuredContent: ['zero', 'one'] },
        '/structuredContent/1',
      ),
    ).toBe('one');
  });

  it.each([
    ['a pointer outside structuredContent', '/content/count', 'invalid_syntax'],
    ['an invalid escape', '/structuredContent/a~2b', 'invalid_syntax'],
    ['a leading-zero array index', '/structuredContent/01', 'invalid_array_index'],
    ['the array append token', '/structuredContent/-', 'invalid_array_index'],
    ['a signed array index', '/structuredContent/+1', 'invalid_array_index'],
    [
      'an unsafe array index',
      `/structuredContent/${String(Number.MAX_SAFE_INTEGER + 1)}`,
      'invalid_array_index',
    ],
  ] as const)('rejects %s', (_label, pointer, reason) => {
    const value = {
      structuredContent: ['zero', 'one'],
    };

    let caught: unknown;
    try {
      resolveStructuredContentPointer(value, pointer);
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(JsonPointerError);
    expect(caught).toMatchObject({ reason });
  });

  it('distinguishes a missing member, an out-of-bounds index, and a scalar traversal', () => {
    expect(() =>
      resolveStructuredContentPointer({ structuredContent: {} }, '/structuredContent/missing'),
    ).toThrow(expect.objectContaining({ reason: 'missing_member' }));
    expect(() =>
      resolveStructuredContentPointer({ structuredContent: ['zero'] }, '/structuredContent/1'),
    ).toThrow(expect.objectContaining({ reason: 'array_index_out_of_bounds' }));
    expect(() =>
      resolveStructuredContentPointer({ structuredContent: null }, '/structuredContent/value'),
    ).toThrow(expect.objectContaining({ reason: 'non_container' }));
  });

  it('never traverses inherited properties or executes accessors', () => {
    const inherited = Object.create({ secret: 19 }) as Record<string, unknown>;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'secret', {
      enumerable: true,
      get: () => {
        throw new Error('canary-accessor-executed');
      },
    });

    expect(() =>
      resolveStructuredContentPointer(
        { structuredContent: inherited },
        '/structuredContent/secret',
      ),
    ).toThrow(expect.objectContaining({ reason: 'missing_member' }));
    expect(() =>
      resolveStructuredContentPointer({ structuredContent: accessor }, '/structuredContent/secret'),
    ).toThrow(expect.objectContaining({ reason: 'unsupported_member' }));
  });

  it('can read an own __proto__ JSON member without following the prototype chain', () => {
    const structuredContent = JSON.parse('{"__proto__":{"count":23}}') as unknown;

    expect(
      resolveStructuredContentPointer({ structuredContent }, '/structuredContent/__proto__/count'),
    ).toBe(23);
  });

  it('does not expose remote values in resolution errors', () => {
    let caught: unknown;
    try {
      resolveStructuredContentPointer(
        { structuredContent: { visible: 'canary-remote-value' } },
        '/structuredContent/missing',
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(JsonPointerError);
    expect((caught as Error).message).not.toContain('canary');
    expect(JSON.stringify(caught)).not.toContain('canary');
  });
});
