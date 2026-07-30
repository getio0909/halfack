export const HELP_TEXT = `HalfAck — fault-injection contract testing for state-changing MCP tools

Usage:
  halfack run <scenario.yml> [--format human|json] [--output <path>]
  halfack validate <scenario.yml>
  halfack --help
  halfack --version

Commands:
  run         Execute fault experiments and emit a report
  validate    Parse and validate a scenario without starting its target

Options:
  -h, --help       Show this help
  -V, --version    Show the installed version
`;
