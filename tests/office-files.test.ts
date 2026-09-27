import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { createRequire } from 'node:module';
import { csvRows, parseOffice, inspectOfficeZip } from '../server/office-parser.ts';
import { readOffice, officeToolResult } from '../server/office-files.ts';
const JSZip = createRequire(import.meta.resolve('exceljs'))('jszip');

test('tool excerpts obey the UTF-8 budget and resume within a wide row without losing its tail', async () => {
  const bytes = Buffer.from(Array.from({ length: 40 }, () => '中'.repeat(1990)).join(','));
  let textOffset = 0, text = '', reads = 0;
  do {
    const value = officeToolResult(await parseOffice('wide.csv', bytes, { textOffset }), 'wide.csv');
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 32768);
    text += value.text; reads++; textOffset = value.nextTextOffset ?? -1;
  } while (textOffset >= 0 && reads < 30);
  assert.equal(text, '1\t' + Array.from({ length: 40 }, () => '中'.repeat(1990)).join('\t'));
  assert.ok(reads > 1);
  const value = officeToolResult(await parseOffice('notes.md', Buffer.from('中'.repeat(24000))), 'notes.md');
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 32768); assert.equal(value.nextOffset, value.text.length);
});

test('CSV preserves quoted newlines/commas, empty fields and row paging; unterminated quote fails', () => {
  assert.deepEqual(csvRows('name,note\r\n"张三","a,b\nline"\r\nlast,', ',').rows,
    [['name', 'note'], ['张三', 'a,b\nline'], ['last', '']]);
  assert.deepEqual(csvRows('a\nb\nc', ',', 1).rows, [['b'], ['c']]);
  assert.throws(() => csvRows('"unfinished', ','), /office_invalid/);
});
test('text is paginated without offering truncated content as a complete editable document', async () => {
  const value = await parseOffice('notes.md', Buffer.from('中'.repeat(40000)));
  assert.equal(value.kind, 'markdown'); assert.equal(value.nextOffset, 24000); assert.equal(value.text.length, 24000);
  assert.equal((await parseOffice('notes.md', Buffer.from('中'.repeat(40000)), { offset: value.nextOffset })).text.length, 16000);
  assert.equal((await parseOffice('notes.txt', Buffer.from([255, 254, 65, 0]))).editable, false);
});
test('XLSX reads multiple sheets and saved formula results without evaluating formulas', async () => {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('统计');
  sheet.addRow(['名称', '总额']); sheet.addRow(['一组', { formula: '1+2', result: 3 }]);
  book.addWorksheet('说明').addRow(['第二张表']);
  const bytes = Buffer.from(await book.xlsx.writeBuffer());
  const parsed = await readOffice('report.xlsx', bytes);
  assert.deepEqual(parsed.rows, [['名称', '总额'], ['一组', '3']]); assert.equal(parsed.sheets?.length, 2);
  assert.equal((await readOffice('report.xlsx', bytes, { sheet: 1 })).rows?.[0][0], '第二张表');
  assert.ok(parsed.warnings.includes('office_cached_formulas'));
});
test('DOCX preserves paragraphs/tables and removes external images and active HTML', async () => {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>办公文档</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格数据</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>');
  const bytes = await zip.generateAsync({ type: 'nodebuffer' });
  const parsed = await readOffice('report.docx', bytes);
  assert.match(parsed.text, /办公文档/); assert.match(parsed.html!, /<table>/); assert.doesNotMatch(parsed.html!, /script|https?:/);
  const bad = Buffer.from(bytes); let end = bad.length - 22; const central = bad.readUInt32LE(end + 16);
  bad.writeUInt32LE(200 * 1024 * 1024, central + 24); assert.throws(() => inspectOfficeZip(bad), /office_too_large/);
});
test('PDF exposes page provenance and text; malformed documents return a bounded error', async () => {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const stream = 'BT /F1 12 Tf 20 100 Td (Office report) Tj ET'; objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  let pdf = '%PDF-1.4\n'; const offsets = [0]; for (const [i, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = pdf.length; pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(x => String(x).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const parsed = await readOffice('report.pdf', Buffer.from(pdf)); assert.equal(parsed.pages, 1); assert.match(parsed.text, /Office report/);
  await assert.rejects(readOffice('broken.pdf', Buffer.from('bad')), /office_invalid/);
});
