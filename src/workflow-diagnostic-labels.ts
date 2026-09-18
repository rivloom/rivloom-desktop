import { t } from '../shared/i18n.ts';
import type { WorkflowDiagnosticReason, WorkflowStepDiagnostic } from '../shared/workflow-diagnostics.ts';

export function diagnosticPhaseLabel(phase: WorkflowStepDiagnostic['phase']) {
  const labels: Record<typeof phase, string> = {
    dependency: t('等待前置步骤'), placement: t('正在检查执行条件'), materials: t('正在准备输入材料'),
    queued: t('已进入执行队列'), dispatching: t('正在确认任务投递'), running: t('正在执行'),
    held: t('此项工作已暂缓'), admitted: t('已获执行槽'), rejected: t('Node 已拒绝执行'),
    attention: t('等待执行反馈'), unknown: t('执行状态待确认'), failed: t('执行失败'), completed: t('已完成'),
    paused: t('已暂停派发'), stopping: t('正在确认停止'), stopped: t('已停止'), confirmation: t('等待排队确认'),
  };
  return labels[phase];
}
export function diagnosticReasonLabel(reason: WorkflowDiagnosticReason) {
  if (reason.hardware) {
    const labels = { platform: t('操作系统'), architecture: t('处理器架构'), minimumLogicalCores: t('逻辑核心数'),
      minimumMemoryBytes: t('内存容量'), gpu: t('GPU'), minimumGpuMemoryBytes: t('显存容量') };
    const format = (value: string | number | boolean | null) => value === null ? t('待确认') : typeof value === 'boolean' ?
      value ? t('有') : t('无') : typeof value === 'number' && ['minimumMemoryBytes', 'minimumGpuMemoryBytes'].includes(reason.hardware!.requirement)
        ? `${Math.round(value / 1024 ** 3 * 10) / 10} GiB` : String(value);
    return t('{{item}}：要求 {{required}}，报告 {{reported}}', { item: labels[reason.hardware.requirement],
      required: format(reason.hardware.required), reported: format(reason.hardware.reported) });
  }
  switch (reason.code) {
    case 'node_offline': return t('当前未连接到设备');
    case 'channel_unavailable': return t('加密通道未就绪');
    case 'trust_required': return t('尚未配对');
    case 'topology_unavailable': return t('协作 Brain 连接尚未就绪');
    case 'capability_unsupported': return t('此设备尚不支持协作执行');
    case 'report_missing': return t('执行能力报告待确认');
    case 'report_stale': return t('执行能力报告已过期');
    case 'execution_unavailable': return t('对端暂未开放执行，请在该设备检查执行开关、模型和文件夹。');
    case 'software_unavailable': return t('当前报告显示 {{software}} 不可用', { software: reason.software || '' });
    case 'software_unknown': return t('{{software}} 的可用状态待确认', { software: reason.software || '' });
    case 'hardware_unavailable': return t('设备硬件报告未满足本步骤要求');
    case 'hardware_unknown': return t('所需硬件能力待确认');
    case 'project_unavailable': return t('本机执行文件夹未就绪');
    case 'model_unavailable': return t('本机所选模型当前不可用');
    case 'engine_unavailable': return t('本机执行引擎尚未就绪');
    case 'queue_unavailable': return t('本机队列暂不接受新任务');
    case 'target_restricted': return t('此设备不符合当前指定或转交范围');
    case 'no_eligible_node': return t('当前没有满足要求的设备');
  }
}
export function diagnosticRecoveryLabel(step: WorkflowStepDiagnostic) {
  if (step.phase === 'materials') return t('输入材料准备完成后，会继续检查并派发原步骤。');
  if (step.phase === 'unknown' || step.phase === 'dispatching') return t('正在核对原执行，不会因此创建另一份执行。');
  if (step.phase === 'queued') return t('等待原设备处理；排位不代表预计开始时间。');
  if (step.phase === 'held') return t('请在执行设备的队列中恢复此项工作。');
  if (step.phase === 'admitted') return t('原设备已接单，正在等待执行进度。');
  if (step.phase === 'rejected') return t('查看拒绝原因，等待原执行结束后再决定是否重试。');
  if (step.phase === 'paused') return t('继续派发后才会启动新步骤，已入队的执行会继续。');
  if (step.phase === 'stopping') return t('等待原执行确认停止，暂不能重试。');
  if (step.phase === 'failed') return t('确认旧执行已结束后可重试；已完成的部分会保留。');
  if (step.phase === 'dependency' && step.recovery === 'user_action') return t('前置步骤尚未完成，请查看其失败或停止记录。');
  if (step.phase === 'placement') return t('尚未派发；条件恢复后会自动重新检查执行条件。');
  return '';
}
