import { t, systemText } from './i18n.ts';
export function workflowError(value: string | null | undefined) {
  if (!value) return '';
  const messages: Record<string, string> = {
    workflow_version_conflict: t('任务流程已有更新，请关闭编辑窗口后重新打开，核对最新步骤再保存。'),
    workflow_step_started: t('此步骤已经开始，不能覆盖执行要求。请查看最新执行记录。'),
    workflow_confirmation_stale: t('队列确认目标已变化，请查看当前提示后重试。'),
    invalid_plan: t('返回的计划格式无效，尚未开始业务执行。请查看规划记录。'),
    duplicate_step: t('计划包含重复步骤，尚未开始业务执行。请查看规划记录。'),
    missing_dependency: t('计划引用了不存在的前置步骤，尚未开始业务执行。'),
    workflow_invalid_outcome: t('执行没有返回有效的计划或结果。请查看记录后重新提交。'),
    workflow_source_not_quiescent: t('尚不能确认源执行的外部工作已停止，转交已阻止。请检查源 Node 的进程与已保存文件。'),
    workflow_locked_handoff: t('此任务已锁定 Node，不能把执行或子步骤转交给其他设备。'),
    workflow_query_limit: t('资源查询已达到本步骤的次数上限，请补充更明确的资源条件。'),
    workflow_stop_unconfirmed: t('停止结果仍待确认，任务不会再次派发。'),
    workflow_execution_unconfirmed: t('执行状态仍待确认，任务不会重复派发。'),
    workflow_dependency_failed: t('前置步骤未完成，依赖它的步骤已阻止。'),
    workflow_context_limit: t('任务与材料说明过长，请缩短说明或减少附件后重新提交。'),
    workflow_input_quota: t('步骤材料超过 10 个或合计 1000 MiB，请调整任务范围。'),
    workflow_output_not_exportable: t('结果文件路径不允许导出，请查看执行记录并选择普通业务文件。'),
    workflow_output_changed: t('导出时源文件发生变化，尚未把它交给后续步骤。'),
    dependency_cycle: t('计划中的步骤存在循环依赖，尚未开始执行。'),
    locked_target: t('计划包含锁定 Node 之外的执行，尚未开始执行。'),
  };
  return messages[value] || systemText(value);
}
