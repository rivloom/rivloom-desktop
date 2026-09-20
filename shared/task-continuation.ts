import type { Task } from './types.ts';

export const taskMessageStates: readonly Task['state'][] = ['ready', 'stopped', 'failed', 'review', 'accepted'];
export function isOrdinaryLocalTask(value: Pick<Task, 'collaboration' | 'remoteOrigin'>): boolean {
  return !value.collaboration && !value.remoteOrigin;
}
export function canContinueTask(value: Pick<Task, 'state' | 'collaboration' | 'remoteOrigin'>): boolean {
  return isOrdinaryLocalTask(value) && taskMessageStates.includes(value.state);
}

export type TaskMessageRequest = { requestID: string; text: string; model?: string; reasoningEffort?: import('./model-reasoning.ts').ReasoningEffort };
