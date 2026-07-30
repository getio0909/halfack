import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.argv[2] ?? 'echo';

function ignoreTerminationOnPosix() {
  if (process.platform !== 'win32') {
    process.on('SIGTERM', () => undefined);
  }
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function startEchoServer() {
  const input = createInterface({
    crlfDelay: Infinity,
    input: process.stdin,
    terminal: false,
  });

  input.on('line', (line) => {
    writeMessage({ received: JSON.parse(line) });
  });
}

switch (mode) {
  case 'echo': {
    startEchoServer();
    break;
  }
  case 'stderr-flood': {
    process.stderr.write('x'.repeat(128 * 1024));
    startEchoServer();
    break;
  }
  case 'queued': {
    const count = Number.parseInt(process.argv[3] ?? '16', 10);
    const messages = Array.from({ length: count }, (_, index) => JSON.stringify({ index }));
    process.stdout.write(`${messages.join('\n')}\n`);
    break;
  }
  case 'partial': {
    process.stdout.write('{"jsonrpc":"2.0"');
    break;
  }
  case 'invalid-utf8': {
    process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));
    break;
  }
  case 'inherited-stdout': {
    const payload = `${JSON.stringify({ afterParentExit: true })}\n`;
    const script = `setTimeout(() => process.stdout.write(${JSON.stringify(payload)}), 40)`;
    const grandchild = spawn(process.execPath, ['-e', script], {
      detached: true,
      stdio: ['ignore', 'inherit', 'ignore'],
      windowsHide: true,
    });
    grandchild.once('spawn', () => {
      grandchild.unref();
    });
    process.exitCode = 0;
    break;
  }
  case 'ignore-eof': {
    ignoreTerminationOnPosix();
    process.stdin.resume();
    setInterval(() => undefined, 1_000);
    break;
  }
  case 'blocked-stdin': {
    ignoreTerminationOnPosix();
    setInterval(() => undefined, 1_000);
    break;
  }
  case 'commit-after-disconnect': {
    const markerPath = process.argv[3];
    if (markerPath === undefined) {
      process.exitCode = 64;
      break;
    }
    const input = createInterface({
      crlfDelay: Infinity,
      input: process.stdin,
      terminal: false,
    });
    let requestReceived = false;
    input.once('line', (line) => {
      JSON.parse(line);
      requestReceived = true;
    });
    input.once('close', () => {
      if (!requestReceived) {
        process.exitCode = 65;
        return;
      }
      setTimeout(() => {
        writeFileSync(markerPath, 'committed', 'utf8');
      }, 75);
    });
    break;
  }
  case 'invalid-then-hang': {
    ignoreTerminationOnPosix();
    process.stdout.write(Buffer.from([0xc3, 0x28, 0x0a]));
    setInterval(() => undefined, 1_000);
    break;
  }
  default: {
    process.stderr.write('unknown fixture mode');
    process.exitCode = 64;
  }
}
