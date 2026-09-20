import type { Bootstrap } from '../shared/types.ts';
import type { WorkflowTarget } from '../shared/workflows.ts';

export type ModelReadinessIssue = 'engine' | 'empty' | 'selection';

/** An empty available-model catalog does not prove that credentials were never configured. */
export function modelReadinessIssue(
  engine: Pick<Bootstrap['engine'], 'ready' | 'error' | 'models'>,
  value: string,
): ModelReadinessIssue | null {
  if (!engine.ready || engine.error) return 'engine';
  if (!engine.models.length) return 'empty';
  return engine.models.some((model) => model.id === value) ? null : 'selection';
}

export type ModelSendGuidanceInput = {
  issue: ModelReadinessIssue | null;
  hasCurrent: boolean;
  localPickerVisible: boolean;
  continuationBlocked: boolean;
  requestPending: boolean;
  owner: boolean;
  targetMode: WorkflowTarget['mode'];
  legacyNeedsModel: boolean;
};

/** Offer guidance without replacing an issued request or asserting remote execution availability. */
export function modelSendGuidance({
  issue, hasCurrent, localPickerVisible, continuationBlocked, requestPending, owner, targetMode, legacyNeedsModel,
}: ModelSendGuidanceInput): { required: boolean; canSchedule: boolean } {
  const required = !requestPending && (
    (!hasCurrent && localPickerVisible && !!issue) || continuationBlocked || legacyNeedsModel
  );
  return {
    required,
    canSchedule: required && !hasCurrent && owner && targetMode !== 'locked' && !legacyNeedsModel,
  };
}
