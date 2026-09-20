import { Brain } from 'lucide-react';
import type { AvailableModel } from '../shared/model-catalog.ts';
import { reasoningSupported, type ReasoningEffort } from '../shared/model-reasoning.ts';
import { t } from '../shared/i18n.ts';

export function reasoningLabel(value: ReasoningEffort | undefined): string {
  const labels: Record<string, string> = {
    none: t('关闭思考'), minimal: t('极低'), low: t('低'), medium: t('中'), high: t('高'),
    xhigh: t('很高'), max: t('最高'), ultra: t('超高'), thinking: t('开启思考'),
  };
  return value == null ? t('自动（模型默认）') : labels[value] || value;
}
export function ReasoningPicker({ model, value, onChange, disabled = false }: {
  model: AvailableModel | undefined; value: ReasoningEffort | undefined;
  onChange: (value: ReasoningEffort) => void; disabled?: boolean;
}) {
  const options = model?.reasoningEfforts || [];
  const invalid = !reasoningSupported(model, value);
  if (!options.length && !invalid) return null;
  return <label className={`composer-select reasoning-picker${invalid ? ' needs-setup' : ''}`}
    title={t('自动使用模型与运行时的默认思考策略；不会切换模型。手动等级越高，通常耗时和用量越多。此设置只影响后续发送的消息。')}>
    <Brain size={15} aria-hidden="true" />
    <select aria-label={t('思考等级')} value={value ?? ''} disabled={disabled}
      onChange={(event) => onChange(event.target.value || null)}>
      <option value="">{reasoningLabel(null)}</option>
      {invalid && <option value={value!} disabled>{t('不可用：{{value}}', { value: reasoningLabel(value) })}</option>}
      {options.map(option => <option key={option} value={option}>{reasoningLabel(option)}</option>)}
    </select>
  </label>;
}
