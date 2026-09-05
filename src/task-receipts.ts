import { stateLabels } from '../shared/types.ts';
import type { NodeQueueItem, NodeQueueReason } from '../shared/node-queue.ts';
import type { TaskQueueReceipt } from '../shared/task-queue-receipts.ts';
import type { Conversation } from './conversations.ts';

export type TaskReceiptView = {
  label: string;
  detail: string;
  position: number | null;
  updatedAt: string | null;
  syncing: boolean;
  tone: 'neutral' | 'waiting' | 'working' | 'ended';
};

const reasonLabels: Record<NodeQueueReason['code'], string> = {
  queue: '等待前面的工作完成',
  slot: '等待执行槽位',
  queue_paused: 'Node 队列已暂停后续启动',
  execution_paused: 'Node 已暂停执行',
  model_unavailable: '等待可用模型',
  project_unavailable: '等待可用工作文件夹',
  hardware_unavailable: '等待符合要求的硬件',
  engine_unavailable: '等待执行引擎就绪',
  peer_unavailable: '等待原 Node 连接恢复',
  acceptance_pending: '正在确认收件',
  held: '此项工作已暂缓',
  state_unknown: '执行结果待确认，执行槽继续保留',
  rejected: 'Node 已拒绝执行',
  cancelled: '发起方已取消',
  expired: '投递已过期',
  trust_revoked: '配对信任已撤销',
  completed: '执行已完成',
  stopped: '执行已停止',
  failed: '执行失败',
};

export function queueReasonLabel(reason: NodeQueueReason | string | null | undefined) {
  if (!reason) return '';
  if (typeof reason === 'object') return reason.message || reasonLabels[reason.code];
  return reasonLabels[reason as NodeQueueReason['code']] || reason;
}

function queueView(
  receipt: Pick<TaskQueueReceipt, 'state' | 'position' | 'reason' | 'updatedAt'>,
): TaskReceiptView {
  const reason = queueReasonLabel(receipt.reason);
  const labels = {
    queued: '目标 Node 已入队',
    held: '目标 Node 已暂缓',
    admitted: '已获执行槽',
    rejected: '目标 Node 已拒绝执行',
  };
  const position = receipt.state === 'queued' ? receipt.position : null;
  return {
    label: labels[receipt.state],
    detail:
      receipt.state === 'queued'
        ? [position ? `当前候选第 ${position} 位` : '当前排位未提供', reason]
            .filter(Boolean)
            .join(' · ')
        : reason ||
          (receipt.state === 'held'
            ? '等待执行 Node 恢复此项工作'
            : receipt.state === 'admitted'
              ? '执行条件由目标 Node 再次核对，状态以实际执行记录为准'
              : '原会话保留拒绝原因'),
    position,
    updatedAt: receipt.updatedAt,
    syncing: false,
    tone:
      receipt.state === 'rejected' ? 'ended' : receipt.state === 'admitted' ? 'working' : 'waiting',
  };
}

export function taskReceiptView(
  item: Conversation,
  options: { connected: boolean; queueEntry?: NodeQueueItem; queueConfirmed?: boolean },
): TaskReceiptView | null {
  const remote = item.remote;
  const brain = item.brainTask;
  const receipt = brain?.queueReceipt || remote?.queueReceipt;
  const local = options.queueEntry;
  const executionState =
    item.localTask?.state ||
    (remote?.executionState !== 'not_started' ? remote?.executionState : undefined);
  const terminalExecution =
    executionState && ['accepted', 'stopped', 'failed'].includes(executionState);
  const base = (
    label: string,
    detail: string,
    tone: TaskReceiptView['tone'] = 'neutral',
  ): TaskReceiptView => ({
    label,
    detail,
    tone,
    position: null,
    updatedAt: remote?.updatedAt || brain?.updatedAt || item.updatedAt,
    syncing: false,
  });
  if (local?.endReason?.code === 'rejected' && !item.localTask?.sessionID)
    return base('本机已拒绝执行', queueReasonLabel(local.endReason), 'ended');
  if (terminalExecution)
    return base(stateLabels[executionState!], '保留原执行记录与验收结果。', 'ended');
  if (brain && ['completed', 'failed'].includes(brain.status))
    return base(
      brain.status === 'completed' ? '已完成' : '执行失败',
      brain.executionSummary || '原 Brain 保留任务与执行历史。',
      'ended',
    );
  if (remote && ['cancelled', 'expired', 'declined'].includes(remote.status))
    return base(
      { cancelled: '投递已取消', expired: '投递已过期', declined: 'Node 未接受执行' }[
        remote.status as 'cancelled' | 'expired' | 'declined'
      ],
      remote.executionSummary || queueReasonLabel(receipt?.reason),
      'ended',
    );
  if (local?.state === 'ended')
    return base(
      queueReasonLabel(local.endReason) || '本机队列项已结束',
      '原任务和执行记录继续保留。',
      'ended',
    );

  let view: TaskReceiptView | null = null;
  if (executionState && !['open', 'ready'].includes(executionState)) {
    view = base(
      stateLabels[executionState],
      executionState === 'interrupted'
        ? '结果待确认，执行槽继续保留，不自动重新执行。'
        : executionState === 'review'
          ? '等待验收，执行槽继续保留。'
          : '已收到实际执行状态。',
      'working',
    );
  } else if (brain && ['running', 'waiting', 'review'].includes(brain.status)) {
    view = base(
      brain.status === 'running' ? '执行中' : brain.status === 'review' ? '待验收' : '等待处理',
      brain.executionSummary || '原 Brain 已收到实际执行状态。',
      'working',
    );
  } else if (receipt?.state === 'rejected') {
    return queueView(receipt);
  } else if (local) {
    view = queueView({
      state: local.state === 'waiting' ? 'queued' : local.state === 'held' ? 'held' : 'admitted',
      position: local.position,
      reason: queueReasonLabel(local.blockReason),
      updatedAt: local.updatedAt,
    });
    view.label = view.label.replace('目标 Node ', '本机');
  } else if (receipt) view = queueView(receipt);
  else if (remote) {
    if (
      remote.deliveredAt ||
      remote.transmissionState === 'delivered' ||
      remote.status === 'accepted' ||
      remote.executionSequence > 0
    )
      view = base('对端已接收', '对端未提供队列信息，当前排位未知。', 'waiting');
    else if (remote.transmissionState === 'transmission_unknown' || remote.deliveryError)
      view = {
        ...base('投递状态待确认', remote.deliveryError || '正在核对原投递，不会改派到其他 Node。'),
        syncing: true,
      };
    else if (remote.transmissionState === 'sending' || remote.deliveryPending)
      view = base('正在发送', '本机已保存投递，等待目标 Node 确认。');
    else view = base('本机已保存', '尚未收到目标 Node 的收件确认。');
  } else if (brain) {
    view = base(
      brain.status === 'submitting' ? '正在发送到 Brain' : '原 Brain 已接收',
      brain.deliveryError ||
        (brain.status === 'queued'
          ? '等待原 Brain 分配合法 Worker；尚未进入某个 Node 的执行队列。'
          : '等待执行 Node 的队列回执，当前排位未知。'),
      'waiting',
    );
  }
  if (view && (!options.connected || (local && options.queueConfirmed === false))) {
    return {
      ...view,
      label: '正在确认状态',
      detail: `上次确认：${view.label}${view.detail ? ` · ${view.detail}` : ''}`,
      position: null,
      syncing: true,
      tone: 'neutral',
    };
  }
  return view;
}
