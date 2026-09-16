import type { AvailableModel } from '../shared/model-catalog.ts';

export function modelDetails(model: AvailableModel) {
  const separator = model.id.indexOf('/');
  const providerID = model.providerID || (separator > 0 ? model.id.slice(0, separator) : '');
  const suffix = model.name.lastIndexOf(' · ');
  return {
    providerID,
    providerName: model.providerName || (suffix > 0 ? model.name.slice(suffix + 3) : providerID),
    modelName: model.modelName || (suffix > 0 ? model.name.slice(0, suffix) : model.name),
  };
}

export function groupModels(models: AvailableModel[], query = '', locale = 'zh-CN') {
  const terms = query.trim().toLocaleLowerCase(locale).split(/\s+/).filter(Boolean);
  const compare = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' }).compare;
  const stableCompare = (a: string, b: string) => compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
  const groups = new Map<string, { id: string; name: string; models: AvailableModel[] }>();
  for (const model of models) {
    const { providerID, providerName, modelName } = modelDetails(model);
    const haystack = `${model.id} ${modelName} ${providerID} ${providerName}`.toLocaleLowerCase(
      locale,
    );
    if (!terms.every((term) => haystack.includes(term))) continue;
    const group = groups.get(providerID) || { id: providerID, name: providerName, models: [] };
    group.models.push(model);
    groups.set(providerID, group);
  }
  return [...groups.values()]
    .sort((a, b) => stableCompare(a.name, b.name) || stableCompare(a.id, b.id))
    .map((group) => ({
      ...group,
      models: group.models.sort(
        (a, b) =>
          stableCompare(modelDetails(a).modelName, modelDetails(b).modelName) ||
          stableCompare(a.id, b.id),
      ),
    }));
}

/** Decimal units match the model directory's token counts (262144 -> 262.1K). */
export function formatContextWindow(tokens: number | undefined) {
  if (!tokens || !Number.isFinite(tokens) || tokens < 0) return null;
  const divisor = tokens >= 1_000_000 ? 1_000_000 : tokens >= 1_000 ? 1_000 : 1;
  return `${Number((tokens / divisor).toFixed(1))}${divisor === 1_000_000 ? 'M' : divisor === 1_000 ? 'K' : ''}`;
}
