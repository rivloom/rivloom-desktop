import { redact } from './artifacts.ts';
import { stateLabels, type Task } from '../shared/types.ts';

export function remoteExecutionSummary(value: Pick<Task, 'state' | 'messages' | 'error'>) {
  if (value.state === 'review' || value.state === 'accepted') {
    const assistant = value.messages.filter((message) => message.role === 'assistant').at(-1)?.text;
    const fallback =
      value.state === 'review' ? 'AI 已完成执行，等待发起方查看结果。' : stateLabels.accepted;
    return redact(assistant?.trim() || fallback).slice(0, 12_000);
  }
  if (value.state === 'failed' || value.state === 'interrupted')
    return redact(value.error || stateLabels[value.state]);
  if (value.state === 'waiting_approval') return '执行节点正在等待本机审批。';
  if (value.state === 'waiting_input') return '执行节点正在等待本机补充信息。';
  if (value.state === 'running') return 'OpenCode 正在执行任务。';
  if (value.state === 'stopped') return '执行节点已停止任务，已完成的修改不会自动回滚。';
  return stateLabels[value.state];
}
