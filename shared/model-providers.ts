import { z } from 'zod';

const safeText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (v) => !/[\x00-\x1f\x7f]/.test(v) && !/\{(?:env|file):/i.test(v),
      'Invalid configuration text',
    );
export const providerIDSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,59}$/)
  .refine((v) => !['constructor', 'prototype'].includes(v), 'Reserved provider ID');
export const accountNameSchema = safeText(40);
export const accountTargetSchema = z.object({
  id: providerIDSchema.optional(),
  name: accountNameSchema,
});
export type AccountTarget = z.infer<typeof accountTargetSchema>;
export const apiKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/);
export const baseURLSchema = safeText(1000)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ['https:', 'http:'].includes(url.protocol) &&
        !!url.hostname &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, 'Use an HTTP(S) API base URL without credentials, query parameters or fragments')
  .transform((v) => v.replace(/\/+$/, ''));
export const customProviderSchema = z
  .object({
    id: providerIDSchema.refine(v => !v.startsWith('rivloom-account-'), 'Reserved account namespace'),
    name: safeText(80),
    baseURL: baseURLSchema,
    protocol: z.enum(['chat', 'responses']),
    models: z
      .array(
        z.object({
          id: safeText(120).refine(
            (v) => !/\s/.test(v) && !['__proto__', 'constructor', 'prototype'].includes(v),
            'Invalid model ID',
          ),
          name: safeText(120),
        }),
      )
      .min(1)
      .max(50)
      .refine((v) => new Set(v.map((m) => m.id)).size === v.length, 'Duplicate model IDs'),
    context: z.number().int().min(2048).max(2_000_000).default(32768),
    output: z.number().int().min(256).max(200_000).default(4096),
    keyless: z.boolean().default(false),
  })
  .refine((v) => v.output < v.context, 'Output limit must be smaller than context limit');
export type CustomProvider = z.infer<typeof customProviderSchema>;
export type AuthPrompt = {
  key: string;
  message: string;
  type: 'text' | 'select';
  placeholder?: string;
  options?: { label: string; value: string; hint?: string }[];
  when?: { key: string; op: 'eq' | 'neq'; value: string };
};
export type ProviderAccess = {
  id: string;
  name: string;
  connected: boolean;
  modelCount: number;
  apiKey: boolean;
  oauth: { index: number; label: string; prompts: AuthPrompt[] }[];
  custom?: CustomProvider;
  account?: { providerID: string; name: string };
  accountName?: string;
  accountError?: string;
};
export type OAuthStatus = {
  id: string;
  providerID: string;
  accountID?: string;
  status: 'starting' | 'waiting' | 'connecting' | 'saving' | 'connected' | 'cancelled' | 'failed';
  url?: string;
  instructions?: string;
  mode?: 'auto' | 'code';
  expiresAt: string;
  message?: string;
};
export function promptVisible(prompt: AuthPrompt, inputs: Record<string, string>) {
  return (
    !prompt.when ||
    (prompt.when.op === 'eq'
      ? inputs[prompt.when.key] === prompt.when.value
      : inputs[prompt.when.key] !== prompt.when.value)
  );
}
export function safeOAuthURL(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || /[\x00-\x20\x7f]/.test(value))
    throw new Error('Invalid authorization URL');
  return url.href;
}
