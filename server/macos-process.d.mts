export type MacosProcess = { pid: number; parentPid: number; group: number; session: number; uid: number; created: string | null; zombie: boolean };
export function macosProcessHelper(): string;
export function macosProcessSnapshot(value: unknown): MacosProcess[];
export function readMacosProcesses(timeoutMs?: number): Promise<MacosProcess[]>;
export function macosMediaProcessCount(): Promise<number>;
export class MacosProcessOwnership {
  leader: MacosProcess;
  root: MacosProcess;
  recorded: Map<string, MacosProcess>;
  uncertain: boolean;
  constructor(rows: MacosProcess[], groupPID: number, hostPID: number, rootPID: number);
  observe(rows: MacosProcess[]): { running: number; childrenRunning: number; leaderRunning: boolean; uncertain: boolean; recorded: number };
}
export function parseMacosLifecycle(value: unknown, groupPID: number): { event: string; rootPID: number; code: number };
export function waitForMacosExit(ownership: MacosProcessOwnership, options: {
  snapshot(timeout: number): Promise<MacosProcess[]>;
  status(): { exited: boolean; expected: boolean; engineExited: boolean };
  quit(): void;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}): Promise<{ stopped: boolean; proof: string; recorded: number }>;
export function runMacosEngineHost(command: string[]): Promise<number>;
