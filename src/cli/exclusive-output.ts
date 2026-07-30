import { lstat, open, realpath, rm, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { ConfigError, InternalError, UsageError } from '../domain/errors.js';

export interface ExclusiveOutput {
  readonly commit: (content: string) => Promise<void>;
  readonly discard: () => Promise<void>;
}

interface FileIdentity {
  readonly birthtimeNs: bigint;
  readonly device: bigint;
  readonly inode: bigint;
}

export async function reserveExclusiveOutput(filePath: string): Promise<ExclusiveOutput> {
  const requestedPath = path.resolve(filePath);
  const requestedParent = path.dirname(requestedPath);
  let parentPath: string;
  let parentIdentity: FileIdentity;
  try {
    parentPath = await realpath(requestedParent);
    const parentStats = await stat(parentPath, { bigint: true });
    if (!parentStats.isDirectory()) {
      throw new Error('The report parent is not a directory.');
    }
    parentIdentity = identityFrom(parentStats);
  } catch (error: unknown) {
    throw new UsageError('The report output directory could not be inspected.', { cause: error });
  }

  const destinationPath = path.join(parentPath, path.basename(requestedPath));
  let handle: FileHandle;
  try {
    handle = await open(destinationPath, 'wx', 0o600);
  } catch (error: unknown) {
    if (isNodeError(error, 'EEXIST')) {
      throw new UsageError('The report output already exists.', { cause: error });
    }
    throw new UsageError('The report output could not be reserved.', { cause: error });
  }

  try {
    const reservedStats = await handle.stat({ bigint: true });
    if (!reservedStats.isFile()) {
      throw new Error('The reserved report output is not a regular file.');
    }
    return new ReservedOutput(
      destinationPath,
      parentPath,
      parentIdentity,
      requestedParent,
      identityFrom(reservedStats),
      handle,
    );
  } catch (error: unknown) {
    await handle.close().catch(() => undefined);
    throw new UsageError('The report output could not be inspected after reservation.', {
      cause: error,
    });
  }
}

class ReservedOutput implements ExclusiveOutput {
  readonly #destinationPath: string;
  #handle: FileHandle | undefined;
  readonly #parentIdentity: FileIdentity;
  readonly #parentPath: string;
  #published = false;
  readonly #requestedParentPath: string;
  readonly #reservedIdentity: FileIdentity;

  public constructor(
    destinationPath: string,
    parentPath: string,
    parentIdentity: FileIdentity,
    requestedParentPath: string,
    reservedIdentity: FileIdentity,
    handle: FileHandle,
  ) {
    this.#destinationPath = destinationPath;
    this.#parentPath = parentPath;
    this.#parentIdentity = parentIdentity;
    this.#requestedParentPath = requestedParentPath;
    this.#reservedIdentity = reservedIdentity;
    this.#handle = handle;
  }

  public async commit(content: string): Promise<void> {
    const handle = this.#handle;
    if (handle === undefined || this.#published) {
      throw new InternalError('The report output lifecycle is invalid.');
    }

    try {
      await this.#assertReservedPath();
      await handle.writeFile(content, { encoding: 'utf8' });
      await handle.sync();
      await this.#assertReservedPath();
      await this.#closeHandle();
      this.#published = true;
    } catch (error: unknown) {
      throw new ConfigError('The report output could not be written safely.', { cause: error });
    }
  }

  public async discard(): Promise<void> {
    if (this.#published) {
      await this.#closeHandle().catch(() => undefined);
      return;
    }

    const pathStillReserved = await this.#reservedPathMatches().catch(() => false);
    await this.#closeHandle().catch(() => undefined);
    if (pathStillReserved) {
      await rm(this.#destinationPath, { force: true }).catch(() => undefined);
    }
  }

  async #assertReservedPath(): Promise<void> {
    if (!(await this.#reservedPathMatches())) {
      throw new Error('The reserved report output path changed identity.');
    }
  }

  async #closeHandle(): Promise<void> {
    const handle = this.#handle;
    if (handle === undefined) {
      return;
    }
    this.#handle = undefined;
    await handle.close();
  }

  async #reservedPathMatches(): Promise<boolean> {
    const [currentRequestedParent, parentStats, destinationStats] = await Promise.all([
      realpath(this.#requestedParentPath),
      stat(this.#parentPath, { bigint: true }),
      lstat(this.#destinationPath, { bigint: true }),
    ]);
    return (
      samePath(currentRequestedParent, this.#parentPath) &&
      parentStats.isDirectory() &&
      destinationStats.isFile() &&
      sameIdentity(identityFrom(parentStats), this.#parentIdentity) &&
      sameIdentity(identityFrom(destinationStats), this.#reservedIdentity)
    );
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
    : left === right;
}

function identityFrom(stats: {
  readonly birthtimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
}): FileIdentity {
  return Object.freeze({
    birthtimeNs: stats.birthtimeNs,
    device: stats.dev,
    inode: stats.ino,
  });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.birthtimeNs === right.birthtimeNs
  );
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
