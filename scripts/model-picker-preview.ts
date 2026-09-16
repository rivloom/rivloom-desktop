// Synthetic display data only: no vendor login, model requests, or installation data.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import type { AvailableModel } from '../shared/model-catalog.ts';
import { startSearchPreview } from './conversation-search-preview.ts';

export const modelPickerFixture: AvailableModel[] = [
  ...['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].map((id) => ({
    id: `deepseek/${id}`,
    name: `${id} · DeepSeek 官方`,
    providerID: 'deepseek',
    providerName: 'DeepSeek 官方',
    modelName: id,
    contextWindow: 1_000_000,
    supportsImages: id.includes('vision'),
  })),
  ...['kimi-k3', 'glm-5.2', 'kimi-k2.7-code', 'deepseek-v4-pro', 'deepseek-v4-flash'].map((id) => ({
    id: `opencode-go/${id}`,
    name: `${id} · opencode-go`,
    providerID: 'opencode-go',
    providerName: 'opencode-go',
    modelName: id,
    contextWindow: id === 'kimi-k2.7-code' ? 262_144 : 1_000_000,
    supportsImages: id !== 'glm-5.2' && id !== 'deepseek-v4-pro',
  })),
  {
    id: 'opencode-go-anthropic/qwen3.8-max',
    name: 'qwen3.8-max · opencode-go-anthropic',
    providerID: 'opencode-go-anthropic',
    providerName: 'opencode-go-anthropic',
    modelName: 'qwen3.8-max',
    contextWindow: 262_144,
  },
  {
    id: 'local/org/model',
    name: 'Custom model · Local',
    providerID: 'local',
    providerName: 'Local',
    modelName: 'Custom model',
  },
];

export async function startModelPickerPreview(dist = resolve('dist')) {
  const preview = await startSearchPreview(dist);
  preview.data.user.name = '模型分组演示 · 合成数据';
  preview.data.tasks = [];
  preview.data.workflows = [];
  preview.data.engine.models = structuredClone(modelPickerFixture);
  preview.data.defaultModel = 'opencode-go/deepseek-v4-flash';
  preview.data.executionPolicy.model = preview.data.defaultModel;
  return preview;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const preview = await startModelPickerPreview();
  console.log(
    `Model picker preview: ${preview.origin}\nSynthetic capacities and capabilities for UI verification only. Ctrl+C to stop.`,
  );
  if (process.argv.includes('--open'))
    execFile('rundll32.exe', ['url.dll,FileProtocolHandler', preview.origin], {
      windowsHide: true,
    });
  process.once('SIGINT', () => void preview.close());
  process.once('SIGTERM', () => void preview.close());
}
