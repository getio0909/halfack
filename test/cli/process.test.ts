import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
const cliPath = path.join(projectRoot, 'dist', 'cli', 'main.js');

describe('built CLI', () => {
  it('runs from an unrelated working directory', () => {
    const result = spawnSync(process.execPath, [cliPath, '--help'], {
      cwd: path.parse(projectRoot).root,
      encoding: 'utf8',
      env: {
        PATH: process.env['PATH'],
        SystemRoot: process.env['SystemRoot'],
      },
      windowsHide: true,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('HalfAck');
  });

  it('reports the same version as package.json', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
    ) as { version?: unknown };
    const result = spawnSync(process.execPath, [cliPath, '--version'], {
      encoding: 'utf8',
      windowsHide: true,
    });

    expect({
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    }).toEqual({
      status: 0,
      stderr: '',
      stdout: `${String(packageJson.version)}\n`,
    });
  });

  it('validates the tracked example from an unrelated working directory', () => {
    const scenarioPath = path.join(projectRoot, 'examples', 'duplicate-order.halfack.yml');
    const result = spawnSync(process.execPath, [cliPath, 'validate', scenarioPath], {
      cwd: path.parse(projectRoot).root,
      encoding: 'utf8',
      windowsHide: true,
    });

    expect({
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    }).toEqual({
      status: 0,
      stderr: '',
      stdout: "Valid scenario 'duplicate-order'.\n",
    });
  });
});
