import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { officeFileLimit, type OfficeReadOptions, type OfficeDocument } from '../shared/office-files.ts';
export const officeReadOptions = z.object({ page: z.coerce.number().int().min(1).max(100000).optional(),
  sheet: z.coerce.number().int().min(0).max(127).optional(), offset: z.coerce.number().int().min(0).max(50_000_000).optional(),
  textOffset: z.coerce.number().int().min(0).max(50_000_000).optional() }).strict();
/** Keep tool responses within the history bridge's 32 KiB context budget. */
export function officeToolResult(document: OfficeDocument, path: string) {
  const { html: _html, rows: _rows, ...metadata } = document;
  const result = { ...metadata, path };
  while (Buffer.byteLength(JSON.stringify(result)) > 32 * 1024 && result.text.length) {
    let length = Math.floor(result.text.length * 0.8);
    if (length && /[\uD800-\uDBFF]/.test(result.text[length - 1])) length--;
    result.text = result.text.slice(0, length);
    if (result.kind === 'table') result.nextTextOffset = (result.textOffset || 0) + length;
    else { result.nextOffset = (result.offset || 0) + length; result.truncated = true; }
  }
  return result;
}
let active = 0;
export function readOffice(name: string, bytes: Buffer, options: OfficeReadOptions = {}): Promise<OfficeDocument> {
  const checked = officeReadOptions.parse(options);
  if (bytes.length > officeFileLimit) return Promise.reject(new Error('office_too_large'));
  if (active >= 2) return Promise.reject(new Error('office_busy'));
  active++;
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try { worker = new Worker(new URL('./office-worker.ts', import.meta.url), {
      workerData: { name, bytes, options: checked }, resourceLimits: { maxOldGenerationSizeMb: 384, stackSizeMb: 8 },
    }); } catch { active--; reject(new Error('office_unavailable')); return; }
    let finished = false;
    const finish = (error?: string, document?: OfficeDocument) => {
      if (finished) return; finished = true; clearTimeout(timer);
      void worker.terminate().finally(() => { active--; if (error) reject(new Error(error)); else resolve(document!); });
    };
    const timer = setTimeout(() => finish('office_timeout'), 25_000);
    worker.once('message', value => finish(value.error, value.document));
    worker.once('error', () => finish('office_invalid'));
    worker.once('exit', () => { if (!finished) finish('office_invalid'); });
  });
}
