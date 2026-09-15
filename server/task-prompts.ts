import type { ApprovalMode } from '../shared/types.ts';

/** Describe the same immutable policy that was passed to the official session. */
export function taskApprovalPrompt(mode: ApprovalMode): string {
  const policy = mode === 'ask'
    ? 'Edits, commands and network tools require approval through the engine permission interface.'
    : mode === 'auto'
      ? 'Project edits and commands are already authorized by the user. Call these tools directly when needed for the task; do not ask for a separate verbal confirmation. Network tools still require approval through the engine permission interface; external directories remain prohibited.'
      : 'Supported file, command, network and external-directory tools are already authorized by the user. Call these tools directly when needed for the task; do not ask for a separate verbal confirmation.';
  return `The current task uses permission mode "${mode}". ${policy}
Keep all original user constraints in force. Sensitive credential reads, subagents and uncontrolled native skill loading remain prohibited. Use the managed rivloom_knowledge tools for registered Skills and Wiki memory when available. An engine permission request must still be handled through its permission interface; never claim that a request was approved merely because you said so. Report only actions actually completed. Respond in the user's language.`;
}
