import type { Provider } from '@opencode-ai/sdk/v2';

/** Public display fields only. Older snapshots can still supply just id/name. */
export type AvailableModel = {
  id: string;
  name: string;
  providerID?: string;
  providerName?: string;
  modelName?: string;
  contextWindow?: number;
  supportsImages?: boolean;
};

export function availableModels(
  providers: Pick<Provider, 'id' | 'name' | 'models'>[],
  connected: string[],
): AvailableModel[] {
  return providers
    .filter((provider) => connected.includes(provider.id))
    .flatMap((provider) =>
      Object.values(provider.models).map((model) => ({
        id: `${provider.id}/${model.id}`,
        name: `${model.name} · ${provider.name}`,
        providerID: provider.id,
        providerName: provider.name,
        modelName: model.name,
        ...(Number.isFinite(model.limit.context) && model.limit.context > 0
          ? { contextWindow: model.limit.context }
          : {}),
        supportsImages: model.capabilities.input.image,
      })),
    );
}
