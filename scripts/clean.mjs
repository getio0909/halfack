import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputDirectory = path.resolve(projectRoot, 'dist');

if (path.dirname(outputDirectory) !== projectRoot || path.basename(outputDirectory) !== 'dist') {
  throw new Error('Refusing to clean an unexpected build output path.');
}

rmSync(outputDirectory, {
  force: true,
  maxRetries: 3,
  recursive: true,
  retryDelay: 50,
});
