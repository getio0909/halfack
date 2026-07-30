import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reserveExclusiveOutput } from '../../src/cli/exclusive-output.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe('exclusive report output security', () => {
  it('reserves the final path before work starts and commits through that reservation', async () => {
    const directory = await createTemporaryDirectory();
    const outputPath = path.join(directory, 'report.json');
    const report = '{"schema":"halfack/report/v1","suite":{"status":"pass"}}\n';
    const output = await reserveExclusiveOutput(outputPath);

    try {
      const stats = await lstat(outputPath);
      await expect(writeFile(outputPath, 'attacker', { flag: 'wx' })).rejects.toMatchObject({
        code: 'EEXIST',
      });

      await output.commit(report);

      expect({
        contents: await readFile(outputPath, 'utf8'),
        isFile: stats.isFile(),
        isSymbolicLink: stats.isSymbolicLink(),
      }).toEqual({
        contents: report,
        isFile: true,
        isSymbolicLink: false,
      });
    } finally {
      await output.discard();
    }
  });

  it('refuses publication if a linked parent directory changes identity', async (context) => {
    const directory = await createTemporaryDirectory();
    const safeDirectory = path.join(directory, 'safe');
    const attackerDirectory = path.join(directory, 'attacker');
    const linkedParent = path.join(directory, 'output');
    const displacedLink = path.join(directory, 'output-before-swap');
    const safeOutputPath = path.join(safeDirectory, 'report.json');
    const attackerOutputPath = path.join(attackerDirectory, 'report.json');
    const requestedOutputPath = path.join(linkedParent, 'report.json');
    await Promise.all([mkdir(safeDirectory), mkdir(attackerDirectory)]);

    try {
      await createDirectoryLink(safeDirectory, linkedParent);
    } catch (error: unknown) {
      if (isLinkPermissionError(error)) {
        context.skip(`directory links are unavailable (${error.code ?? 'unknown'})`);
        return;
      }
      throw error;
    }

    const output = await reserveExclusiveOutput(requestedOutputPath);
    const reservedBeforeSwap = await isRegularFile(safeOutputPath);
    let commitError: unknown;

    try {
      await rename(linkedParent, displacedLink);
      await createDirectoryLink(attackerDirectory, linkedParent);
      try {
        await output.commit('authentic report\n');
      } catch (error: unknown) {
        commitError = error;
      }
    } finally {
      await output.discard();
    }

    expect({
      attackerPublished: await pathExists(attackerOutputPath),
      commitRejected: commitError instanceof Error,
      reservedBeforeSwap,
    }).toEqual({
      attackerPublished: false,
      commitRejected: true,
      reservedBeforeSwap: true,
    });
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'halfack-exclusive-output-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createDirectoryLink(target: string, linkPath: string): Promise<void> {
  return symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

function isLinkPermissionError(error: unknown): error is NodeJS.ErrnoException {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM' || code === 'ENOTSUP';
}
