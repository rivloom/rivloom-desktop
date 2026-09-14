import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { customProviderSchema, type CustomProvider } from '../shared/model-providers.ts';

// One owned file, consumed by the official engine through OPENCODE_CONFIG.
// No API keys or OAuth tokens belong here. Do not merge arbitrary engine config from clients.
export class ProviderConfigStore {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  get file() {
    return join(this.root, 'rivloom-providers.json');
  }
  list(): CustomProvider[] {
    if (!existsSync(this.file)) return [];
    const raw = JSON.parse(readFileSync(this.file, 'utf8'));
    return z.array(customProviderSchema).parse(
      Object.entries(raw.provider || {}).map(([id, value]) => {
        const p = value as {
          name: string;
          npm: string;
          options: { baseURL: string; apiKey?: string };
          models: Record<string, { name: string; limit: { context: number; output: number } }>;
        };
        const limits = Object.values(p.models)[0]?.limit;
        return {
          id,
          name: p.name,
          baseURL: p.options.baseURL,
          protocol: p.npm === '@ai-sdk/openai' ? 'responses' : 'chat',
          keyless: p.options.apiKey === '',
          models: Object.entries(p.models).map(([id, m]) => ({ id, name: m.name })),
          context: limits?.context,
          output: limits?.output,
        };
      }),
    );
  }
  write(providers: CustomProvider[]) {
    const checked = z.array(customProviderSchema).parse(providers);
    const config = {
      provider: Object.fromEntries(
        checked.map((p) => [
          p.id,
          {
            npm: p.protocol === 'responses' ? '@ai-sdk/openai' : '@ai-sdk/openai-compatible',
            name: p.name,
            options: { baseURL: p.baseURL, ...(p.keyless ? { apiKey: '' } : {}) },
            models: Object.fromEntries(
              p.models.map((m) => [
                m.id,
                { name: m.name, limit: { context: p.context, output: p.output } },
              ]),
            ),
          },
        ]),
      ),
    };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
