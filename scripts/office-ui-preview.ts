// Synthetic office acceptance files and model settings. No real credentials or model calls.
import express from 'express';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import { startModelAccessPreview } from './model-access-preview.ts';
import { installProjectFilesAPI } from '../server/project-files-api.ts';
import type { Bootstrap } from '../shared/types.ts';

export async function officeFixtureFiles(directory: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, '说明.md'), '# 材料处理说明\n\n这是用于验收的合成资料。\n\n- 核对来源\n- 汇总销售\n- 生成报告\n');
  await writeFile(join(directory, '搜索检查.md'), '# 搜索检查\n\nİ尾针\n\n```text\nOnlyCodeNeedle\n```\n\na+b? [needle]\n');
  await writeFile(join(directory, '长文本.txt'), '第一页合成内容\n' + '文'.repeat(23992) + '第二页合成内容');
  await writeFile(join(directory, '空白.txt'), '');
  await writeFile(join(directory, '数据.csv'), '部门,金额,备注\n一部,1200,"含税,已核对"\n二部,1800,"第二行\n补充说明"');
  await writeFile(join(directory, '损坏.pdf'), 'Synthetic invalid PDF');
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('销售汇总'); sheet.addRow(['部门', '收入', '成本', '利润']);
  sheet.addRow(['华东', 32000, 12000, { formula: 'B2-C2', result: 20000 }]);
  sheet.addRow(['华南', 28000, 15000, { formula: 'B3-C3', result: 13000 }]);
  for (let i = 4; i <= 125; i++) sheet.addRow([`合成数据 ${i}`, i * 100, i * 50, i * 50]);
  book.addWorksheet('口径说明').addRow(['金额单位：元。所有内容均为合成验收数据。']);
  await book.xlsx.writeFile(join(directory, '销售.xlsx'));
  const JSZip = createRequire(import.meta.resolve('exceljs'))('jszip'); const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>季度经营简报</w:t></w:r></w:p><w:p><w:r><w:t>这是合成资料，用于验证离线阅读与引用功能。</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>华东</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>32,000 元</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>');
  await writeFile(join(directory, '简报.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>长简报合成资料 ${'内容核对。'.repeat(5000)}</w:t></w:r></w:p></w:body></w:document>`);
  await writeFile(join(directory, '长简报.docx'), await zip.generateAsync({ type: 'nodebuffer' }));
  const stream = 'BT /F1 22 Tf 40 230 Td (Quarterly Office Report) Tj 0 -40 Td /F1 12 Tf (Offline preview - synthetic data) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>'];
  let pdf = '%PDF-1.4\n'; const offsets: number[] = [];
  for (const [i, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = pdf.length; pdf += `xref\n0 7\n0000000000 65535 f \n${offsets.map(value => `${String(value).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await writeFile(join(directory, '报告.pdf'), pdf);
}

export async function startOfficePreview(dist = resolve('dist')) {
  const root = resolve('.data/verification/office-workspace-20260926', randomUUID());
  const directory = join(root, 'project'); await officeFixtureFiles(directory);
  let data: Bootstrap; let dismissed = false;
  const app = express(); app.use(express.json({ limit: '2mb' }));
  installProjectFilesAPI(app, () => data.user, () => data.projects);
  app.get('/api/model-settings/onboarding', (_req, res) => res.json({ dismissed }));
  app.post('/api/model-settings/onboarding', (_req, res) => { dismissed = true; res.json({ dismissed }); });
  const preview = await startModelAccessPreview(dist, async (req, res, next) => {
    data = next;
    // Match the production preview CSP, including local PDF WASM and worker loading.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' blob:; connect-src 'self'; media-src 'self' blob:; object-src 'none'");
    if (!/^\/api\/(projects|office-assets)(\/|$)|^\/api\/model-settings\/onboarding/.test(req.url || '')) return false;
    app(req, res); return true;
  });
  data = preview.data; data.projects[0].directory = directory; data.projects[0].name = '办公验收 · 合成资料';
  return { ...preview, root, directory };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const preview = await startOfficePreview(process.argv[2] ? resolve(process.argv[2]) : undefined);
  console.log(JSON.stringify({ origin: preview.origin, root: preview.root, directory: preview.directory, pid: process.pid }));
  process.once('SIGINT', () => void preview.close()); process.once('SIGTERM', () => void preview.close());
}
