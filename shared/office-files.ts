export const officeFileLimit = 32 * 1024 * 1024;
export const editableTextLimit = 256 * 1024;
export const officeTextLimit = 24_000;
export const officeRowLimit = 100;
export type OfficeReadOptions = { page?: number; sheet?: number; offset?: number; textOffset?: number };
export type OfficeKind = 'text' | 'markdown' | 'table' | 'word' | 'pdf';
export type OfficeDocument = {
  kind: OfficeKind; name: string; revision: string; bytes: number;
  text: string; truncated: boolean; warnings: string[];
  html?: string; editable?: boolean; encoding?: string;
  page?: number; pages?: number; offset?: number; nextOffset?: number;
  textOffset?: number; nextTextOffset?: number;
  sheet?: number; sheets?: { name: string; rows: number; columns: number }[];
  rows?: string[][]; columns?: number;
};
export function officeKind(name: string): OfficeKind | null {
  const ext = name.toLowerCase().split('.').pop();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'word';
  if (['xlsx', 'csv', 'tsv'].includes(ext || '')) return 'table';
  if (ext === 'md') return 'markdown';
  if (/^(txt|log|json|jsonl|yaml|yml|xml|html|htm|svg|mdx|js|jsx|ts|tsx|css|py|rs|go|java|c|h|cpp|sh|ps1|toml|ini|sql)$/.test(ext || '')) return 'text';
  return null;
}
export function textEditable(name: string) { return /\.(txt|md)$/i.test(name); }
export type ProjectFileEntry = { name: string; path: string; directory: boolean; bytes: number };
export type ProjectFileListing = { path: string; entries: ProjectFileEntry[]; truncated: boolean };
