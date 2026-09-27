/** Public activity metadata contains no entry text, source paths, or task content. */
export const knowledgeActivityActions = ['refresh', 'search', 'read', 'save', 'rules', 'organize', 'share', 'register', 'remove', 'withdraw'] as const;
export type KnowledgeActivityAction = typeof knowledgeActivityActions[number];
export type OperationActivityStatus = 'running' | 'completed' | 'partial' | 'failed';
export type OperationActivity = {
  id: string;
  action: KnowledgeActivityAction;
  status: OperationActivityStatus;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  /** Concurrent operations of this action; never an estimated progress value. */
  activeCount?: number;
  /** Repeated failures of this action are coalesced until explicitly dismissed. */
  occurrences?: number;
  error?: string;
};
