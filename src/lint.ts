// ---------------------------------------------------------------------------
// lint.ts — Post-agent lint runner and formatter
// ---------------------------------------------------------------------------
import { spawnSync } from 'bun';

export type LintResult = {
  label: string;
  available: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
};

type RunPostAgentLintProps = {
  cwd: string;
  label: string;
};

export function runPostAgentLint({ cwd, label }: RunPostAgentLintProps): LintResult {
  const proc = spawnSync(['bun', 'run', 'lint'], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const stdout = proc.stdout?.toString().trim() ?? '';
  const stderr = proc.stderr?.toString().trim() ?? '';
  const exitCode = proc.exitCode ?? -1;

  const lintCommandMissing =
    exitCode === 127 &&
    (stderr.includes('command not found: bun') ||
      stderr.includes('No such file or directory') ||
      stderr.includes('not found: bun'));

  return { label, available: !lintCommandMissing, exitCode, stdout, stderr };
}

export function formatLintSummary(result: LintResult): string {
  const stdoutPart = result.stdout || '(empty)';
  const stderrPart = result.stderr || '(empty)';

  return `[${result.label}] Post-edit lint (exit ${result.exitCode}):\n[stdout]\n${stdoutPart}\n\n[stderr]\n${stderrPart}`;
}
