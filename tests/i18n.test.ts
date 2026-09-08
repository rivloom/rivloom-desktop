import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { i18n, language, normalizeLocale, systemText, t } from '../shared/i18n.ts';
import { stateLabels, approvalModeLabels } from '../shared/types.ts';
import { attentionLabels } from '../shared/task-attention.ts';
import { queueReasonLabel, taskReceiptView } from '../src/task-receipts.ts';
import { executionSummaryText } from '../src/system-display.ts';
import type { Conversation } from '../src/conversations.ts';
import type { TaskQueueReceipt } from '../shared/task-queue-receipts.ts';

test('native locale persistence is available only through the owned desktop capability', () => {
  const config = JSON.parse(
    readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
  );
  const capability = config.app.security.capabilities.find(
    (entry: { identifier: string }) => entry.identifier === 'desktop-main',
  );
  assert.deepEqual(capability.windows, ['main']);
  assert.deepEqual(capability.remote.urls, ['http://127.0.0.1:*']);
  assert(capability.permissions.includes('allow-set-desktop-language'));
  const manifest = readFileSync(new URL('../src-tauri/build.rs', import.meta.url), 'utf8');
  assert(manifest.includes('"set_desktop_language"'));
});

test('supported locale normalization always has a Chinese fallback', () => {
  for (const value of [undefined, null, '', 'fr', 'zh', 'zh-CN', 'zh-TW', 1])
    assert.equal(normalizeLocale(value), 'zh-CN');
  for (const value of ['en', 'en-US', 'EN_gb']) assert.equal(normalizeLocale(value), 'en');
});

test('language changes update previously imported display maps without remounting or freezing labels', async () => {
  try {
    await i18n.changeLanguage('en');
    assert.equal(language(), 'en');
    assert.equal(stateLabels.running, 'Running');
    assert.equal(approvalModeLabels.ask, 'Request approval');
    assert.equal(attentionLabels.input, 'Awaiting answer');
    await i18n.changeLanguage('zh-CN');
    assert.equal(stateLabels.running, '执行中');
    assert.equal(approvalModeLabels.ask, '请求批准');
    assert.equal(attentionLabels.input, '待回答');
  } finally {
    await i18n.changeLanguage('zh-CN');
  }
});

test('owned messages translate in both directions while preserving parameters and unknown external text', async () => {
  const path = 'C:\\工作文件\\等待执行-<draft>.txt';
  try {
    await i18n.changeLanguage('en');
    assert.equal(t('已保存至 {{value1}}', { value1: path }), `Saved to ${path}`);
    assert.equal(systemText(`已保存至 ${path}`), `Saved to ${path}`);
    assert.equal(systemText('请登录'), 'Please sign in');
    assert.equal(systemText('自定义提供方错误：请登录'), '自定义提供方错误：请登录');
    assert.equal(systemText('external model error 123'), 'external model error 123');
    await i18n.changeLanguage('zh-CN');
    assert.equal(systemText(`Saved to ${path}`), `已保存至 ${path}`);
    assert.equal(systemText('Please sign in'), '请登录');
  } finally {
    await i18n.changeLanguage('zh-CN');
  }
});

test('model replies and user-authored queue rejection reasons remain verbatim', async () => {
  const text = '等待执行'; // Deliberately identical to a translatable UI key.
  const receipt = {
    state: 'rejected',
    reason: text,
    position: null,
    updatedAt: '2026-09-06T12:00:00Z',
  } as TaskQueueReceipt;
  const conversation = {
    key: 'remote:test',
    attempts: [],
    remote: { status: 'accepted', executionState: 'not_started', queueReceipt: receipt },
  } as unknown as Conversation;
  try {
    await i18n.changeLanguage('en');
    assert.equal(executionSummaryText(text, 'review'), text);
    assert.equal(executionSummaryText(text, 'completed'), text);
    assert.equal(
      executionSummaryText('OpenCode 正在执行任务。', 'running'),
      'OpenCode is running the task.',
    );
    assert.equal(queueReasonLabel({ code: 'rejected', message: text }), text);
    assert.equal(taskReceiptView(conversation, { connected: true })?.detail, text);
    assert.equal(
      queueReasonLabel({ code: 'model_unavailable', message: '等待本机模型可用' }),
      'Waiting for the local model',
    );
  } finally {
    await i18n.changeLanguage('zh-CN');
  }
});
