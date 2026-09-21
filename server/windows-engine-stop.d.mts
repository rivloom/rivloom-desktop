export interface WindowsEngineStopDiagnostic {
  phase: 'before' | 'root-check' | 'kill' | 'after' | 'result' | 'deadline' | 'unexpected';
  outcome: 'ok' | 'failed' | 'skipped';
  durationMs: number;
  code?: number | null;
  recorded?: number;
  proof?: 'taskkill' | 'observed-exit' | 'unproven';
  reason?: 'timeout' | 'output_limit' | 'command_missing' | 'command_denied' | 'command_failed' | 'invalid_inventory' | 'invalid_result' | 'root_exited' | 'survivor';
}
export function parseWindowsEngineStopDiagnostic(line: unknown): WindowsEngineStopDiagnostic | undefined;
export function windowsPowerShellEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export const windowsPowerShellPrelude: string;
