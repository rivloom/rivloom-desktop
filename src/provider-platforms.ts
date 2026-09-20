import type { CustomProvider, ProviderAccess } from '../shared/model-providers.ts';
// Search vocabulary is multilingual data, independent of the display locale.
import searchAliases from './provider-search-aliases.json' with { type: 'json' };

// Native providers keep their SDK, catalog and account routing. These endpoints
// are only defaults for a new, explicitly saved OpenAI-compatible configuration.
export const PROVIDER_PLATFORMS = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    aliases: searchAliases.openrouter,
    baseURL: 'https://openrouter.ai/api/v1',
    docsURL: 'https://openrouter.ai/docs/quickstart',
  },
  {
    id: 'siliconflow-cn',
    name: 'SiliconFlow CN',
    aliases: searchAliases['siliconflow-cn'],
    baseURL: 'https://api.siliconflow.cn/v1',
    docsURL: 'https://docs.siliconflow.cn/docs/userguide/quickstart',
  },
  {
    id: 'groq',
    name: 'Groq',
    aliases: searchAliases.groq,
    baseURL: 'https://api.groq.com/openai/v1',
    docsURL: 'https://console.groq.com/docs/overview',
  },
  {
    id: 'togetherai',
    name: 'Together AI',
    aliases: searchAliases.togetherai,
    baseURL: 'https://api.together.ai/v1',
    docsURL: 'https://docs.together.ai/docs/inference/openai-compatibility',
  },
  {
    id: 'deepinfra',
    name: 'DeepInfra',
    aliases: searchAliases.deepinfra,
    baseURL: 'https://api.deepinfra.com/v1/openai',
    docsURL: 'https://docs.deepinfra.com/chat/overview',
  },
] as const;

export function nativePlatformProvider(
  providers: readonly ProviderAccess[],
  platformID: string,
): ProviderAccess | undefined {
  if (!PROVIDER_PLATFORMS.some((p) => p.id === platformID)) return undefined;
  return providers.find((p) => p.id === platformID && p.apiKey && !p.custom && !p.account);
}

export function platformCustomDraft(
  platformID: string,
  providers: readonly ProviderAccess[],
): CustomProvider {
  const platform = PROVIDER_PLATFORMS.find((p) => p.id === platformID);
  if (!platform) throw new Error('Unknown provider platform');
  const occupied = new Set(providers.map((p) => p.id));
  const baseID = `${platform.id}-custom`;
  let id = baseID;
  for (let suffix = 2; occupied.has(id); suffix++) id = `${baseID}-${suffix}`;
  return {
    id,
    name: platform.name,
    baseURL: platform.baseURL,
    protocol: 'chat',
    models: [],
    context: 32768,
    output: 4096,
    keyless: false,
  };
}

export function providerSearchText(provider: Pick<ProviderAccess, 'id' | 'name'>): string {
  // The international SiliconFlow account is a separate provider/credential.
  const aliases = Object.hasOwn(searchAliases, provider.id)
    ? searchAliases[provider.id as keyof typeof searchAliases]
    : [];
  return [provider.id, provider.name, ...aliases].join(' ').toLowerCase();
}

const apiPriority: readonly string[] = [
  ...PROVIDER_PLATFORMS.map((p) => p.id),
  'deepseek',
  'anthropic',
  'openai',
  'siliconflow',
];
export function providerApiRank(id: string): number {
  const index = apiPriority.indexOf(id);
  return index < 0 ? apiPriority.length : index;
}
