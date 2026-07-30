import { describe, expect, it } from 'vitest';
import {
  ArgumentExpansionError,
  expandRun,
  expandRunArguments,
} from '../../src/experiment/arguments.js';

describe('expandRunArguments', () => {
  it('replaces every embedded run-id placeholder without mutating the source', () => {
    const source = Object.freeze({
      exact: '${run.id}',
      nested: Object.freeze([
        'prefix-${run.id}-suffix',
        Object.freeze({ twice: '${run.id}/${run.id}' }),
      ]),
      untouched: 7,
    });

    const expanded = expandRunArguments(source, 'run-42');

    expect(expanded).toEqual({
      exact: 'run-42',
      nested: ['prefix-run-42-suffix', { twice: 'run-42/run-42' }],
      untouched: 7,
    });
    expect(source.exact).toBe('${run.id}');
    expect(Object.isFrozen(expanded)).toBe(true);
    const nested = expanded['nested'] as readonly unknown[];
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(nested[1])).toBe(true);
  });

  it('rejects unsafe runtime values rather than invoking accessors or following prototypes', () => {
    let accessorCalls = 0;
    const accessor: Record<string, unknown> = {};
    Object.defineProperty(accessor, 'secret', {
      enumerable: true,
      get: () => {
        accessorCalls += 1;
        return '${run.id}';
      },
    });
    const inherited = Object.create({ inherited: '${run.id}' }) as Record<string, unknown>;

    expect(() => expandRunArguments(accessor, 'run-1')).toThrow(ArgumentExpansionError);
    expect(() => expandRunArguments(inherited, 'run-1')).toThrow(ArgumentExpansionError);
    expect(accessorCalls).toBe(0);
  });

  it('rejects cycles, excessive depth, and invalid run IDs with fixed diagnostics', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    let deep: unknown = 'leaf';
    for (let index = 0; index < 34; index += 1) {
      deep = [deep];
    }

    expect(() => expandRunArguments(cycle, 'run-1')).toThrow(ArgumentExpansionError);
    expect(() => expandRunArguments({ deep }, 'run-1')).toThrow(ArgumentExpansionError);
    expect(() => expandRunArguments({}, 'line\nbreak')).toThrow(ArgumentExpansionError);
  });
});

describe('expandRun', () => {
  it('expands reset, exercise, and probe with one immutable run scope', () => {
    const run = expandRun(
      {
        exercise: {
          arguments: { token: '${run.id}' },
          tool: 'orders.create',
        },
        probe: {
          arguments: { scope: '${run.id}' },
          tool: 'orders.count',
        },
        reset: {
          arguments: { scope: '${run.id}' },
          tool: 'test.reset',
        },
      },
      'run-7',
    );

    expect(run).toEqual({
      exercise: {
        arguments: { token: 'run-7' },
        tool: 'orders.create',
      },
      probe: {
        arguments: { scope: 'run-7' },
        tool: 'orders.count',
      },
      reset: {
        arguments: { scope: 'run-7' },
        tool: 'test.reset',
      },
      runId: 'run-7',
    });
    expect(Object.isFrozen(run)).toBe(true);
    expect(Object.isFrozen(run.exercise.arguments)).toBe(true);
  });
});
