import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageSource = readFileSync(path.join(projectRoot, 'package.json'), 'utf8');
const versionSource = readFileSync(path.join(projectRoot, 'src', 'version.ts'), 'utf8');

const packageDocument = JSON.parse(packageSource);
const packageVersion = packageDocument.version;
if (typeof packageVersion !== 'string' || !isReleaseVersion(packageVersion)) {
  throw new Error('package.json must contain a valid release version.');
}

const versionMatch = /^export const VERSION = '([^']+)';\r?$/mu.exec(versionSource.trimEnd());
if (versionMatch === null) {
  throw new Error('src/version.ts must export one literal VERSION value.');
}
if (versionMatch[1] !== packageVersion) {
  throw new Error(
    `Version mismatch: package.json is ${packageVersion}, src/version.ts is ${versionMatch[1]}.`,
  );
}

process.stdout.write(`Version ${packageVersion} is consistent.\n`);

function isReleaseVersion(value) {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
    value,
  );
}
