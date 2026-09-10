export type FilePreviewKind = 'image' | 'text' | 'audio' | 'video' | 'unsupported';
export const filePreviewTextBytes = 256 * 1024;
export function filePreviewType(name: string): { kind: FilePreviewKind; mime: string } {
  const ext = name.toLowerCase().split('.').pop() || '';
  const images: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
  const audio: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac' };
  const video: Record<string, string> = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
  if (images[ext]) return { kind: 'image', mime: images[ext] };
  if (audio[ext]) return { kind: 'audio', mime: audio[ext] };
  if (video[ext]) return { kind: 'video', mime: video[ext] };
  if (/^(txt|md|mdx|csv|tsv|json|jsonl|yaml|yml|xml|html|htm|svg|log|js|jsx|ts|tsx|css|py|rs|go|java|c|h|cpp|sh|ps1|toml|ini|sql)$/.test(ext))
    return { kind: 'text', mime: 'text/plain; charset=utf-8' };
  return { kind: 'unsupported', mime: 'application/octet-stream' };
}
export function previewRange(range: string | undefined, bytes: number): { start: number; end: number } | null {
  const cap = 4 * 1024 * 1024;
  if (!bytes) return null;
  if (!range) return { start: 0, end: Math.min(bytes, cap) - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || !match[1] && !match[2]) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, bytes - Number(match[2]));
  const end = match[1] && match[2] ? Number(match[2]) : bytes - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= bytes || end < start) return null;
  return { start, end: Math.min(end, bytes - 1, start + cap - 1) };
}
