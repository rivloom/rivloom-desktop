export type MacosProcess = { pid: number; parentPid: number; group: number; session: number; uid: number; created: string | null; zombie: boolean };
export type MacosInventoryFailure = 'capacity' | 'list' | 'allocation' | 'short-info' | 'full-info-before' | 'full-info-after' |
  'session-before' | 'session-after' | 'birth-invalid' | 'birth-changed' | 'group-changed' | 'uid-changed' | 'output' |
  'query-timeout' | 'query-output-limit' | 'query-launch' | 'query-failed' | 'invalid-result';
export type MacosHostFailure = 'none' | 'inventory-unavailable' | 'ownership-uncertain' | 'owner-start' | 'owner-exit' |
  'owner-pipe' | 'lifecycle-invalid' | 'startup-timeout' | 'engine-exit' | 'stop-unproven' | 'host-error';
export type MacosOwnershipFailure = 'initial-identity' | 'leader-reused' | 'recorded-birth-unavailable' | 'recorded-birth-backwards' |
  'session-birth-invalid' | 'session-uid-changed' | 'child-birth-unavailable' | 'session-changed' | 'group-changed' | 'uid-changed' | 'record-limit' |
  'guard-identity' | 'guard-transition' | 'watchdog-identity';
export type MacosEngineStopDiagnostic = { phase: 'result'; outcome: 'ok' | 'failed'; durationMs: number;
  proof: 'observed-exit' | 'unproven'; recorded: number; failure: MacosHostFailure; inventoryFailure?: MacosInventoryFailure;
  ownershipFailure?: MacosOwnershipFailure };
export function parseMacosInventoryFailure(line: unknown): MacosInventoryFailure | undefined;
export function parseMacosEngineStopDiagnostic(line: unknown): MacosEngineStopDiagnostic | undefined;
export function macosProcessHelper(): string;
export function macosProcessSnapshot(value: unknown): MacosProcess[];
export function readMacosProcesses(timeoutMs?: number): Promise<MacosProcess[]>;
export function macosMediaProcessCount(): Promise<number>;
export type MacosLifecycle = { event: string; rootPID: number; code: number; watchdogPID?: number;
  id?: number; guardPID?: number; guardRootPID?: number; created?: string };
export type MacosOwnershipState = { running: number; childrenRunning: number; leaderRunning: boolean; uncertain: boolean; recorded: number;
  ownershipFailure?: MacosOwnershipFailure };
export class MacosProcessOwnership {
  leader: MacosProcess;
  root: MacosProcess;
  recorded: Map<string, MacosProcess>;
  uncertain: boolean;
  watchdog?: MacosProcess;
  ownerQuit: boolean;
  ownerStopping: boolean;
  ownershipFailure?: MacosOwnershipFailure;
  constructor(rows: MacosProcess[], groupPID: number, hostPID: number, rootPID: number, watchdogPID?: number);
  registerGuard(receipt: MacosLifecycle, rows: MacosProcess[], cancelledBeforeStart?: boolean): void;
  authorizeGuard(id: number): void;
  activateGuard(receipt: MacosLifecycle, rows: MacosProcess[], cancelledBeforeExecution?: boolean): void;
  guardEvent(receipt: MacosLifecycle): void;
  guardQuits(): number[];
  markUncertain(reason: MacosOwnershipFailure): void;
  observe(rows: MacosProcess[]): MacosOwnershipState;
}
export function parseMacosLifecycle(value: unknown, groupPID: number): MacosLifecycle;
export function waitForMacosExit(ownership: MacosProcessOwnership, options: {
  snapshot?(timeout: number): Promise<MacosProcess[]>;
  observe?(timeout: number): Promise<MacosOwnershipState>;
  status(): { exited: boolean; expected: boolean; engineExited: boolean };
  quit(): void;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
}): Promise<{ stopped: boolean; proof: string; recorded: number; failure: MacosHostFailure; inventoryFailure?: MacosInventoryFailure;
  ownershipFailure?: MacosOwnershipFailure }>;
export function runMacosEngineHost(command: string[]): Promise<number>;
