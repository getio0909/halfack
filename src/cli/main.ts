#!/usr/bin/env node

import { runCli, type CliIo } from './run.js';

const io: CliIo = {
  writeError: (value) => {
    process.stderr.write(value);
  },
  writeOutput: (value) => {
    process.stdout.write(value);
  },
};

const controller = new AbortController();
const abort = (): void => {
  controller.abort();
};
process.once('SIGINT', abort);
process.once('SIGTERM', abort);

try {
  process.exitCode = await runCli(process.argv.slice(2), io, {
    signal: controller.signal,
  });
} catch {
  process.stderr.write('HALFACK_INTERNAL: HalfAck failed unexpectedly.\n');
  process.exitCode = 70;
} finally {
  process.off('SIGINT', abort);
  process.off('SIGTERM', abort);
}
