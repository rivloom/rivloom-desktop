import { executionSummaryText } from './system-display.ts';
import { t, systemText } from '../shared/i18n.ts';
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
  get queue() {
    return t('等待前面的工作完成');
  },
  get slot() {
    return t('等待执行槽位');
  },
  get queue_paused() {
    return t('Node 队列已暂停后续启动');
  },
  get execution_paused() {
    return t('Node 已暂停执行');
  },
  get model_unavailable() {
    return t('等待可用模型');
  },
  get project_unavailable() {
    return t('等待可用工作文件夹');
  },
  get hardware_unavailable() {
    return t('等待符合要求的硬件');
  },
  get engine_unavailable() {
    return t('等待执行引擎就绪');
  },
  get peer_unavailable() {
    return t('等待原 Node 连接恢复');
  },
  get acceptance_pending() {
    return t('正在确认收件');
  },
  get attachments_pending() {
    return t('等待附件完整接收并校验');
  },
  get held() {
    return t('此项工作已暂缓');
  },
  get state_unknown() {
    return t('执行结果待确认，执行槽继续保留');
  },
  get rejected() {
    return t('Node 已拒绝执行');
  },
  get cancelled() {
    return t('发起方已取消');
  },
  get expired() {
    return t('投递已过期');
  },
  get trust_revoked() {
    return t('配对信任已撤销');
  },
  get completed() {
    return t('执行已完成');
  },
  get stopped() {
    return t('执行已停止');
  },
  get failed() {
    return t('执行失败');
  },
};

export function queueReasonLabel(reason: NodeQueueReason | string | null | undefined) {
  if (!reason) return '';
  if (typeof reason === 'object')
    return reason.message
      ? reason.code === 'rejected'
        ? reason.message
        : systemText(reason.message)
      : reasonLabels[reason.code];
  return reasonLabels[reason as NodeQueueReason['code']] || systemText(reason);
}

function queueView(
  receipt: Pick<TaskQueueReceipt, 'state' | 'position' | 'reason' | 'updatedAt'>,
): TaskReceiptView {
  // Rejection reasons are user-authored and must stay verbatim.
  const reason =
    receipt.state === 'rejected' ? receipt.reason || '' : queueReasonLabel(receipt.reason);
  const labels = {
    queued: t('目标 Node 已入队'),
    held: t('目标 Node 已暂缓'),
    admitted: t('已获执行槽'),
    rejected: t('目标 Node 已拒绝执行'),
  };
  const position = receipt.state === 'queued' ? receipt.position : null;
  return {
    label: labels[receipt.state],
    detail:
      receipt.state === 'queued'
        ? [
            position ? t('当前候选第 {{value1}} 位', { value1: position }) : t('当前排位未提供'),
            reason,
          ]
            .filter(Boolean)
            .join(' · ')
        : reason ||
          (receipt.state === 'held'
            ? t('等待执行 Node 恢复此项工作')
            : receipt.state === 'admitted'
              ? t('执行条件由目标 Node 再次核对，状态以实际执行记录为准')
              : t('原会话保留拒绝原因')),
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
  const actualLocalExecution = item.localTask && !['open', 'ready'].includes(item.localTask.state);
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
    return base(t('本机已拒绝执行'), queueReasonLabel(local.endReason), 'ended');
  // A confirmed terminal owner/delivery status supersedes an older remote snapshot.
  // Direct local execution facts retain priority over those synchronized records.
  if (!actualLocalExecution && brain && ['completed', 'failed'].includes(brain.status))
    return base(
      brain.status === 'completed' ? t('已完成') : t('执行失败'),
      executionSummaryText(brain.executionSummary, brain.status) ||
        t('原 Brain 保留任务与执行历史。'),
      'ended',
    );
  if (
    !actualLocalExecution &&
    remote &&
    ['cancelled', 'expired', 'declined'].includes(remote.status)
  )
    return base(
      { cancelled: t('投递已取消'), expired: t('投递已过期'), declined: t('Node 未接受执行') }[
        remote.status as 'cancelled' | 'expired' | 'declined'
      ],
      executionSummaryText(remote.executionSummary, remote.executionState) ||
        (receipt?.state === 'rejected' ? receipt.reason || '' : queueReasonLabel(receipt?.reason)),
      'ended',
    );
  if (terminalExecution)
    return base(stateLabels[executionState!], t('保留原执行记录与结果。'), 'ended');
  if (local?.state === 'ended')
    return base(
      queueReasonLabel(local.endReason) || t('本机队列项已结束'),
      t('原任务和执行记录继续保留。'),
      'ended',
    );

  let view: TaskReceiptView | null = null;
  if (executionState && !['open', 'ready'].includes(executionState)) {
    view = base(
      stateLabels[executionState],
      executionState === 'interrupted'
        ? t('结果待确认，执行槽继续保留，不自动重新执行。')
        : executionState === 'review'
          ? t('执行已完成。旧版执行节点仍可能保留槽位，请更新该节点。')
          : t('已收到实际执行状态。'),
      'working',
    );
  } else if (brain && ['running', 'waiting', 'review'].includes(brain.status)) {
    view = base(
      brain.status === 'running'
        ? t('执行中')
        : brain.status === 'review'
          ? t('已完成')
          : t('等待处理'),
      executionSummaryText(brain.executionSummary, brain.status) ||
        t('原 Brain 已收到实际执行状态。'),
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
    view.label =
      local.state === 'waiting'
        ? t('本机已入队')
        : local.state === 'held'
          ? t('本机已暂缓')
          : t('已获执行槽');
  } else if (receipt) view = queueView(receipt);
  else if (remote) {
    if (
      remote.deliveredAt ||
      remote.transmissionState === 'delivered' ||
      remote.status === 'accepted' ||
      remote.executionSequence > 0
    )
      view = base(t('对端已接收'), t('对端未提供队列信息，当前排位未知。'), 'waiting');
    else if (remote.transmissionState === 'transmission_unknown' || remote.deliveryError)
      view = {
        ...base(
          t('投递状态待确认'),
          systemText(remote.deliveryError) || t('正在核对原投递，不会改派到其他 Node。'),
        ),
        syncing: true,
      };
    else if (remote.transmissionState === 'sending' || remote.deliveryPending)
      view = base(t('正在发送'), t('本机已保存投递，等待目标 Node 确认。'));
    else view = base(t('本机已保存'), t('尚未收到目标 Node 的收件确认。'));
  } else if (brain) {
    view = base(
      brain.status === 'submitting' ? t('正在发送到 Brain') : t('原 Brain 已接收'),
      systemText(brain.deliveryError) ||
        (brain.status === 'queued'
          ? t('等待原 Brain 分配合法 Worker；尚未进入某个 Node 的执行队列。')
          : t('等待执行 Node 的队列回执，当前排位未知。')),
      'waiting',
    );
  }
  if (view && (!options.connected || (local && options.queueConfirmed === false))) {
    return {
      ...view,
      label: t('正在确认状态'),
      detail: t('上次确认：{{value1}}{{value2}}', {
        value1: view.label,
        value2: view.detail ? ` · ${view.detail}` : '',
      }),
      position: null,
      syncing: true,
      tone: 'neutral',
    };
  }
  return view;
}
