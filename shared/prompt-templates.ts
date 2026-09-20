export const maximumPromptTemplates = 100;
export const maximumPromptTemplateTitle = 80;
export const maximumPromptTemplateText = 12_000;

export type PromptTemplate = { id: string; title: string; text: string; revision: number; updatedAt: string };
export type PromptTemplateInput = Pick<PromptTemplate, 'title' | 'text'>;
export type PromptTemplateList = { templates: PromptTemplate[]; limit: number };
export type PromptTemplateErrorCode = 'prompt_template_invalid' | 'prompt_template_missing' | 'prompt_template_conflict' | 'prompt_template_limit';

export function validPromptTemplateInput(value: unknown): value is PromptTemplateInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).length === 2 && Object.hasOwn(input, 'title') && Object.hasOwn(input, 'text')
    && typeof input.title === 'string' && input.title.trim().length > 0 && input.title.trim().length <= maximumPromptTemplateTitle
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(input.title)
    && typeof input.text === 'string' && input.text.trim().length > 0 && input.text.length <= maximumPromptTemplateText && !input.text.includes('\u0000');
}

/** Literal local search; does not modify templates or send queries to a server. */
export function filterPromptTemplates(templates: readonly PromptTemplate[], query: string): PromptTemplate[] {
  const term = query.trim().toLocaleLowerCase();
  return templates.filter(template => !term || template.title.toLocaleLowerCase().includes(term) || template.text.toLocaleLowerCase().includes(term));
}
