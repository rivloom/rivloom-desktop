import { systemText, t } from '../shared/i18n.ts';

/** Review and accepted summaries can contain a model's actual reply. */
export function executionSummaryText(value: string | undefined, state: string | undefined) {
  return ['review', 'accepted', 'completed'].includes(state || '')
    ? value || ''
    : systemText(value);
}

/** Display protocol values without changing the values sent over the wire. */
export function operationResultText(value: string) {
  return (
    (
      {
        success: t('成功'),
        passed: t('连接通过'),
        failed: t('执行失败'),
        testing: t('正在测试'),
        started: t('已启动'),
        stopped: t('已停止'),
        interrupted: t('执行中断'),
        completed: t('已完成'),
      } as Record<string, string>
    )[value] || value
  );
}
export function executionStateText(value: string) {
  return (
    (
      {
        pending: t('等待处理'),
        queued: t('排队中'),
        assigned: t('已分配'),
        running: t('执行中'),
        waiting: t('等待处理'),
        review: t('已完成'),
        completed: t('已完成'),
        failed: t('执行失败'),
        error: t('执行失败'),
      } as Record<string, string>
    )[value] || value
  );
}
