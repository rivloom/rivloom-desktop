import type { AvailableModel } from './model-catalog.ts';
import { t } from './i18n.ts';

/** null means runtime/model defaults; undefined preserves older records' inheritance rules. */
export type ReasoningEffort = string | null;
export function validReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === null || typeof value === 'string' && value.length <= 64 &&
    /^[a-zA-Z0-9]/.test(value) && !/[^a-zA-Z0-9_-]/.test(value);
}
export function reasoningSupported(model: AvailableModel | undefined, effort: ReasoningEffort | undefined): boolean {
  return effort == null || validReasoningEffort(effort) && !!model?.reasoningEfforts?.includes(effort);
}
/** Never turn a stale, explicit selection into a different execution silently. */
export function reasoningPromptOptions(model: AvailableModel | undefined, effort: ReasoningEffort | undefined): { variant?: string } {
  if (!reasoningSupported(model, effort)) throw new Error(t('所选思考等级当前不可用，请重新选择思考等级或使用自动。'));
  return effort == null ? {} : { variant: effort };
}
export function reasoningForMessage(current: { model: string | null; reasoningEffort?: ReasoningEffort },
  message: { model?: string | null; reasoningEffort?: ReasoningEffort }): ReasoningEffort | undefined {
  return message.reasoningEffort !== undefined ? message.reasoningEffort :
    message.model !== undefined && message.model !== current.model ? null : current.reasoningEffort;
}
