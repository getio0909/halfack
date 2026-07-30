/**
 * Stable process exit codes. Values 0-4 are intended for automation while 70
 * follows sysexits(3)'s EX_SOFTWARE convention for unexpected internal faults.
 */
export enum ExitCode {
  Success = 0,
  ContractViolation = 1,
  Usage = 2,
  Configuration = 3,
  Target = 4,
  Internal = 70,
  Interrupted = 130,
}
