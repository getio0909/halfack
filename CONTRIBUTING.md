# Contributing to HalfAck

Thank you for helping make failure testing for state-changing MCP tools safer and more reliable.

## Before You Start

HalfAck launches the command declared by a scenario and intentionally interrupts requests, connections, and processes. It is not a sandbox. Run it only against disposable local targets and data that you are authorized to modify.

Scenarios currently declare a single-process boundary. A target must not detach children or delegate durable effects outside that boundary. Do not weaken this contract or present process termination as proof that an undeclared process tree was stopped.

For a substantial behavior or public interface change, start a discussion before investing in an implementation. Security vulnerabilities must follow [SECURITY.md](SECURITY.md), not a public issue.

## Development Setup

You need:

- Node.js 22.13.0 or newer
- pnpm 11.5.0

Install the exact locked dependencies:

```sh
pnpm install --frozen-lockfile
```

Run the full local verification:

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm package:smoke
```

Use `pnpm format` to apply the repository's formatting rules.

## Making a Change

Keep each change focused and preserve the existing safety and evidence model.

- Add or update tests for every behavior change.
- Prefer a failing regression test before changing production code.
- Exercise error paths, cleanup failures, interrupted operations, and unsafe input.
- Keep fixtures isolated and deterministic. Never point tests at production services or persistent user data.
- Do not add placeholders, skipped tests, or incomplete error handling.
- Do not log secrets, target environment values, state contents, or untrusted protocol payloads.
- Treat a missing response as ambiguous unless independent evidence proves the durable effect.
- Preserve the distinction between a violation, an inconclusive result, a target failure, and a cleanup failure.

When changing scenario parsing, process lifecycle code, report output, or output-file handling, include adversarial tests for malformed input and filesystem or process races.

## Tests and Fixtures

Unit tests live under `test/`. The runnable demonstration under `examples/` is also exercised as a built-CLI end-to-end test.

A fixture that simulates a state-changing tool should:

1. Isolate state per run scope.
2. Persist an effect before reporting success.
3. Support deterministic observation of the resulting state.
4. Shut down cleanly and avoid spawning detached processes.
5. Contain no network, account, or production dependency.

Tests must clean up their temporary files and processes even when an assertion fails.

## Documentation

Update user-facing documentation when changing commands, scenario fields, experiment semantics, exit codes, report schemas, or safety requirements. Examples must remain runnable as copied; avoid fictional URLs, credentials, and output.

## Submitting Changes

Before submitting:

1. Review the diff for unrelated edits and generated artifacts.
2. Run every verification command listed above.
3. Explain the behavioral change, its safety implications, and the tests that prove it.
4. Call out any platform-specific behavior, especially Windows process or filesystem behavior.

Small, reviewable changes with explicit evidence are easiest to validate.
