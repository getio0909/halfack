# Security Policy

## Reporting a Vulnerability

Do not disclose a suspected vulnerability in a public issue, pull request, discussion, log, or test fixture.

If this repository is hosted on GitHub and private vulnerability reporting is enabled, open the repository's **Security** tab, choose **Report a vulnerability**, and create a private advisory. Include:

- the affected version or commit;
- a minimal reproduction using disposable data;
- the expected and observed behavior;
- the security impact and required preconditions;
- the operating system and Node.js version; and
- any suggested mitigation, if known.

If private vulnerability reporting is unavailable, contact a maintainer through a private channel they publish on their GitHub profile. Share only enough information in the initial message to arrange encrypted or otherwise private disclosure. Do not invent or guess an address, and do not fall back to a public report.

Maintainers should acknowledge a complete private report, assess its impact, coordinate a fix and disclosure, and credit the reporter if requested. Response times are best effort until the project publishes a formal service-level commitment.

## Supported Versions

Security fixes are developed against the current main branch and, when releases exist, the latest published release. Older releases may not receive backports.

## Security Boundary

HalfAck is a fault-injection test tool, not a sandbox, authorization layer, or process supervisor. It executes the target command from a scenario with the same operating-system permissions as HalfAck. Experiments may send state-changing tool calls, close transports, cancel requests, and terminate the declared target process.

Use HalfAck only when all of the following are true:

- you own or are authorized to test the target;
- the target and its data are disposable or independently backed up;
- the scenario declares the target's real persistence behavior;
- the target stays within the declared single-process boundary and does not detach children; and
- credentials and production endpoints are absent from the target environment.

A successful cleanup result proves only the boundary HalfAck observed. It does not prove that an undeclared child, remote worker, external queue, or downstream service stopped.

## Relevant Vulnerability Classes

Private reports are especially useful for:

- command or argument injection that changes the declared target command;
- environment-variable leakage or unsafe inheritance;
- failure to terminate or account for the declared target process;
- path traversal, symlink races, or unintended overwrite of report files;
- cross-run state or identifier collisions;
- sensitive data exposure in diagnostics or reports;
- malformed protocol input that causes unbounded resource use; and
- evidence logic that incorrectly turns uncertainty into a pass.

Reports about unsafe use of an intentionally declared target command, without a boundary bypass or misleading result, may be treated as usage questions rather than vulnerabilities.
