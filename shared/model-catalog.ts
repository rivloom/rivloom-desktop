import type { Provider } from '@opencode-ai/sdk/v2';
import { validReasoningEffort } from './model-reasoning.ts';

/** Public display fields only. Older snapshots can still supply just id/name. */
export type AvailableModel = {
  id: string;
  name: string;
  providerID?: string;
  providerName?: string;
  modelName?: string;
  contextWindow?: number;
  supportsImages?: boolean;
  accountName?: string;
  sourceProviderID?: string;
  reasoningEfforts?: string[];
};

export function availableModels(
  providers: Pick<Provider, 'id' | 'name' | 'models'>[],
  connected: string[],
): AvailableModel[] {
  return providers
    .filter((provider) => connected.includes(provider.id))
    .flatMap((provider) =>
      Object.values(provider.models).map((model) => {
        const reasoningEfforts = Object.entries(model.variants || {}).filter(([key, options]) =>
          validReasoningEffort(key) && key !== 'auto' && key !== 'default' && options?.disabled !== true).map(([key]) => key);
        return {
        id: `${provider.id}/${model.id}`,
        name: `${model.name} · ${provider.name}`,
        providerID: provider.id,
        providerName: provider.name,
        modelName: model.name,
        ...(Number.isFinite(model.limit.context) && model.limit.context > 0
          ? { contextWindow: model.limit.context }
          : {}),
        supportsImages: model.capabilities.input.image,
        ...(reasoningEfforts.length ? { reasoningEfforts } : {}),
      }; }),
    );
}
