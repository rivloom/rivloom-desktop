import { primaryShortcut } from './keyboard-platform.ts';

export const workspaceActionIDs = [
  'new-conversation', 'search-conversations', 'focus-composer', 'attention', 'models',
  'knowledge', 'queue', 'diagnostics', 'trash', 'shortcuts', 'templates', 'find-current', 'export-conversation', 'project-changes',
] as const;
export type WorkspaceActionID = (typeof workspaceActionIDs)[number];

type CommandFields = {
  label: string;
  detail?: string;
  keywords?: readonly string[];
  shortcut?: string;
  disabled?: boolean;
  ownerOnly?: boolean;
  run: () => void;
};
export type WorkspaceCommand = CommandFields & (
  { kind: 'action'; id: WorkspaceActionID } |
  { kind: 'conversation' | 'draft'; id: string }
);

const ownerActions = new Set<WorkspaceActionID>(['knowledge', 'queue', 'trash', 'project-changes']);
const kindOrder = { action: 0, draft: 1, conversation: 2 };
const normalized = (text: string) => text.normalize('NFKC').toLowerCase();

/** Draft and recent entries for the same conversation share one navigation target. */
export function workspaceCommandKey(command: WorkspaceCommand): string {
  return `${command.kind === 'action' ? 'action' : 'conversation'}:${command.id}`;
}

function permitted(command: WorkspaceCommand, owner: boolean): boolean {
  if (!command.id || !command.label.trim()) return false;
  if (command.kind === 'action' && !workspaceActionIDs.includes(command.id)) return false;
  return owner || !(command.ownerOnly || command.kind === 'action' && ownerActions.has(command.id));
}

/** Navigation only. Authorization remains enforced by each existing destination and API. */
export function availableWorkspaceCommands(commands: readonly WorkspaceCommand[], owner: boolean): WorkspaceCommand[] {
  const seen = new Set<string>();
  return [...commands].sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind]).filter((command) => {
    if (!permitted(command, owner)) return false;
    const key = workspaceCommandKey(command);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function searchWorkspaceCommands(
  commands: readonly WorkspaceCommand[], query: string, owner: boolean, limit = 40,
): WorkspaceCommand[] {
  const terms = normalized(query).trim().split(/\s+/u).filter(Boolean);
  const available = availableWorkspaceCommands(commands, owner);
  const matches = available.filter((command) => {
    const text = normalized([command.label, command.detail || '', ...(command.keywords || [])].join(' '));
    return terms.every((term) => text.includes(term));
  });
  if (terms.length) matches.sort((a, b) => {
    const score = (command: WorkspaceCommand) => terms.every((term) => normalized(command.label).includes(term)) ? 0 : 1;
    return score(a) - score(b);
  });
  return matches.slice(0, Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 40);
}

export function executeWorkspaceCommand(command: WorkspaceCommand, owner: boolean): boolean {
  if (!permitted(command, owner) || command.disabled) return false;
  command.run();
  return true;
}

export type WorkspaceShortcut = 'palette' | 'new-conversation' | 'search-conversations' | 'focus-composer';
export type WorkspaceKeyEvent = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  defaultPrevented?: boolean;
};

export const workspaceShortcutLabels: Record<WorkspaceShortcut, string> = {
  palette: primaryShortcut('K'),
  'new-conversation': primaryShortcut('Shift + N'),
  'search-conversations': primaryShortcut('Shift + F'),
  'focus-composer': primaryShortcut('Shift + L'),
};

/** Only explicit modified chords; typing, held keys and nested dialogs retain control. */
export function workspaceShortcutForEvent(
  event: WorkspaceKeyEvent, context: { blocked?: boolean; composing?: boolean } = {},
): WorkspaceShortcut | null {
  if (context.blocked || context.composing || event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 || event.altKey) return null;
  if (!!event.ctrlKey === !!event.metaKey) return null;
  const key = event.key.toLowerCase();
  if (!event.shiftKey) return key === 'k' ? 'palette' : null;
  return key === 'n' ? 'new-conversation' : key === 'f' ? 'search-conversations' : key === 'l' ? 'focus-composer' : null;
}
