import { createHash } from 'node:crypto';
import { officeKind, officeFileLimit, editableTextLimit, officeTextLimit, officeRowLimit, textEditable,
  type OfficeReadOptions, type OfficeDocument } from '../shared/office-files.ts';

/** Reject encrypted, ZIP64 and oversized archives before a parser inflates them. */
export function inspectOfficeZip(buffer: Buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--)
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
  if (end < 0) throw new Error('office_invalid');
  const count = buffer.readUInt16LE(end + 10); let at = buffer.readUInt32LE(end + 16), expanded = 0;
  if (count > 10000 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6)) throw new Error('office_too_large');
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('office_invalid');
    if (buffer.readUInt16LE(at + 8) & 1) throw new Error('office_encrypted');
    expanded += buffer.readUInt32LE(at + 24);
    if (expanded > 128 * 1024 * 1024) throw new Error('office_too_large');
    at += 46 + buffer.readUInt16LE(at + 28) + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  if (at !== end) throw new Error('office_invalid');
}
export function decodeOfficeText(buffer: Buffer): { text: string; encoding: string } {
  if (buffer[0] === 255 && buffer[1] === 254) return { text: new TextDecoder('utf-16le').decode(buffer), encoding: 'utf-16le' };
  if (buffer[0] === 254 && buffer[1] === 255) return { text: new TextDecoder('utf-16be').decode(buffer), encoding: 'utf-16be' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' }; }
  catch { return { text: new TextDecoder('gb18030', { fatal: true }).decode(buffer), encoding: 'gb18030' }; }
}
export function csvRows(text: string, delimiter: string, offset = 0) {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false, count = 0, columns = 0, clipped = false;
  const pushCell = () => { if (row.length < 100) row.push(cell); else clipped = true; cell = ''; };
  const pushRow = () => { pushCell(); columns = Math.max(columns, row.length); if (count >= offset && rows.length < officeRowLimit) rows.push(row); row = []; count++; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') { if (quoted && text[i + 1] === '"') { if (cell.length < 2000) cell += '"'; i++; } else if (quoted || !cell) quoted = !quoted; else if (cell.length < 2000) cell += char; }
    else if (!quoted && char === delimiter) pushCell();
    else if (!quoted && (char === '\n' || char === '\r')) { if (char === '\r' && text[i + 1] === '\n') i++; pushRow(); }
    else if (cell.length < 2000) cell += char; else clipped = true;
  }
  if (quoted) throw new Error('office_invalid');
  if (cell || row.length) pushRow();
  return { rows, count, columns, clipped };
}
export async function parseOffice(name: string, buffer: Buffer, options: OfficeReadOptions = {}): Promise<OfficeDocument> {
  const kind = officeKind(name); if (!kind) throw new Error('office_unsupported');
  if (buffer.length > officeFileLimit) throw new Error('office_too_large');
  const result: OfficeDocument = { kind, name, revision: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length, text: '', truncated: false, warnings: [] };
  const offset = options.offset || 0;
  if (/\.(docx|xlsx)$/i.test(name)) inspectOfficeZip(buffer);
  if (kind === 'text' || kind === 'markdown') {
    const decoded = decodeOfficeText(buffer); if (decoded.text.includes('\0')) throw new Error('office_invalid');
    result.encoding = decoded.encoding;
    result.text = decoded.text.slice(offset, offset + officeTextLimit); result.offset = offset;
    result.truncated = offset + result.text.length < decoded.text.length;
    if (result.truncated) result.nextOffset = offset + result.text.length;
    result.editable = textEditable(name) && buffer.length <= editableTextLimit && decoded.encoding === 'utf-8';
    // Editors must receive the whole file, never the paginated preview prefix.
    return result;
  }
  if (kind === 'pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const job = getDocument({ data: new Uint8Array(buffer), useSystemFonts: true, verbosity: 0,
      disableFontFace: true, useWorkerFetch: false });
    try {
      const document = await job.promise;
      const page = options.page || 1;
      if (page > document.numPages) throw new Error('office_page');
      const content = await (await document.getPage(page)).getTextContent();
      const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
      result.page = page; result.pages = document.numPages; result.offset = offset;
      result.text = text.slice(offset, offset + officeTextLimit); result.truncated = offset + result.text.length < text.length;
      if (result.truncated) result.nextOffset = offset + result.text.length;
      if (!text.trim()) result.warnings.push('office_no_text');
      return result;
    } catch (error) { if ((error as Error).name === 'PasswordException') throw new Error('office_encrypted'); throw error; }
    finally { await job.destroy(); }
  }
  if (kind === 'word') {
    const mammoth = await import('mammoth'); const { default: sanitize } = await import('sanitize-html');
    let imageBytes = 0;
    const converted = await mammoth.convertToHtml({ buffer }, { externalFileAccess: false,
      convertImage: mammoth.images.imgElement(async image => {
        const content = await image.read('base64'); imageBytes += content.length;
        if (!/^image\/(png|jpeg|gif|webp)$/.test(image.contentType) || imageBytes > 4 * 1024 * 1024) { result.warnings.push('office_images_omitted'); return { src: '' }; }
        return { src: `data:${image.contentType};base64,${content}` };
      }) });
    const plain = await mammoth.extractRawText({ buffer });
    result.text = plain.value.slice(offset, offset + officeTextLimit); result.offset = offset;
    result.truncated = offset + result.text.length < plain.value.length;
    if (result.truncated) result.nextOffset = offset + result.text.length;
    if (converted.value.length <= 6 * 1024 * 1024) result.html = sanitize(converted.value, {
      allowedTags: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'strong', 'em', 'u', 's', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'blockquote', 'sup', 'sub', 'img'],
      allowedAttributes: { img: ['src', 'alt'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] },
      allowedSchemes: ['data'], allowedSchemesAppliedToAttributes: ['src'], allowProtocolRelative: false,
      exclusiveFilter: frame => frame.tag === 'img' && !/^data:image\/(?:png|jpeg|gif|webp);base64,[a-z\d+/=]+$/i.test(frame.attribs.src || ''),
    }); else result.warnings.push('office_layout_omitted');
    if (converted.messages.length) result.warnings.push('office_layout_approximate');
    result.warnings = [...new Set(result.warnings)]; return result;
  }
  result.offset = offset;
  if (/\.xlsx$/i.test(name)) {
    const { default: ExcelJS } = await import('exceljs'); const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0], { ignoreNodes: ['drawing', 'picture', 'extLst'] });
    if (workbook.worksheets.length > 128) throw new Error('office_too_large');
    result.sheets = workbook.worksheets.map(sheet => ({ name: sheet.name, rows: sheet.rowCount, columns: sheet.columnCount }));
    result.sheet = options.sheet || 0; const sheet = workbook.worksheets[result.sheet];
    if (!sheet && workbook.worksheets.length) throw new Error('office_sheet');
    result.columns = Math.min(sheet?.columnCount || 0, 100); result.rows = [];
    if (sheet) for (let row = offset + 1; row <= Math.min(sheet.rowCount, offset + officeRowLimit); row++) {
      const cells: string[] = [];
      for (let col = 1; col <= result.columns; col++) {
        const cell = sheet.getCell(row, col); let text = cell.text;
        if (cell.type === ExcelJS.ValueType.Formula) {
          const value = cell.result;
          text = value === undefined ? `[=${cell.formula}]` : typeof value === 'object' && value !== null && 'error' in value ? String(value.error) : String(value);
        }
        if (text.length > 2000) result.warnings.push('office_cells_truncated');
        cells.push(text.slice(0, 2000));
      }
      result.rows.push(cells);
    }
    result.truncated = !!sheet && offset + result.rows.length < sheet.rowCount;
    if (result.truncated) result.nextOffset = offset + result.rows.length;
    if ((sheet?.columnCount || 0) > 100) result.warnings.push('office_columns_truncated');
    result.warnings.push('office_cached_formulas');
  } else {
    const decoded = decodeOfficeText(buffer); result.encoding = decoded.encoding;
    const parsed = csvRows(decoded.text, /\.tsv$/i.test(name) ? '\t' : ',', offset);
    result.rows = parsed.rows; result.columns = parsed.columns; result.sheet = 0;
    result.sheets = [{ name, rows: parsed.count, columns: parsed.columns }];
    result.truncated = offset + parsed.rows.length < parsed.count;
    if (result.truncated) result.nextOffset = offset + parsed.rows.length;
    if (parsed.clipped) result.warnings.push('office_cells_truncated');
  }
  const text = result.rows!.map((row, index) => `${offset + index + 1}\t${row.join('\t')}`).join('\n');
  result.textOffset = options.textOffset || 0;
  result.text = text.slice(result.textOffset, result.textOffset + officeTextLimit);
  if (result.textOffset + result.text.length < text.length) result.nextTextOffset = result.textOffset + result.text.length;
  result.warnings = [...new Set(result.warnings)]; return result;
}
