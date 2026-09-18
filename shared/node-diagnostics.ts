import { t } from './i18n.ts';
import type { Bootstrap, RivloomNode } from './types.ts';

export type DiagnosticState = 'ok' | 'warning' | 'blocked' | 'unknown';
export type DiagnosticAction = 'retry' | 'network' | 'models' | 'queue' | 'attention';
export type DiagnosticCheck = {
  code: string;
  state: DiagnosticState;
  title: string;
  detail: string;
  action?: DiagnosticAction;
};
export type NodeDiagnostic = {
  nodeID: string | null;
  name: string;
  local: boolean;
  lastContactAt: string | null;
  checks: DiagnosticCheck[];
};

const freshness = (at: string | undefined, now: number) =>
  !!at &&
  Number.isFinite(Date.parse(at)) &&
  now - Date.parse(at) <= 20_000 &&
  Date.parse(at) - now <= 60_000;

export function diagnoseLocal(data: Bootstrap, connected = true): NodeDiagnostic {
  const { network, engine, executionPolicy: policy } = data;
  const checks: DiagnosticCheck[] = [];
  checks.push(
    connected
      ? { code: 'backend', state: 'ok', title: t('工作区连接正常'), detail: t('已连接本机服务。') }
      : {
          code: 'backend',
          state: 'blocked',
          title: t('工作区正在重连'),
          detail: t('下方保留上次状态，暂不能确认新的执行与控制结果。'),
          action: 'retry',
        },
  );
  checks.push(
    network.local
      ? {
          code: 'identity',
          state: 'ok',
          title: t('本机身份已就绪'),
          detail: t('继续使用当前 Node 和已有配对。'),
        }
      : {
          code: 'identity',
          state: 'blocked',
          title: t('本机身份未就绪'),
          detail: t('等待应用启动；若持续失败，请检查本机数据目录是否可用。'),
          action: 'network',
        },
  );
  checks.push({
    code: 'discovery',
    state:
      network.status === 'online' ? 'ok' : network.status === 'starting' ? 'unknown' : 'blocked',
    title:
      network.status === 'online'
        ? t('发现服务已启动')
        : network.status === 'disabled'
          ? t('局域网发现已关闭')
          : network.status === 'starting'
            ? t('发现服务正在启动')
            : t('发现服务受限'),
    detail:
      network.status === 'online'
        ? t('服务启动只表示可以尝试发现，仍需核对另一台设备的通信状态。')
        : t('确认两台设备连接可互通的网络、Rivloom 已打开，并检查系统是否允许应用通信。'),
    action: 'retry',
  });
  if (network.diagnostics) {
    const probe = network.diagnostics.lastProbe;
    if (probe && Number.isFinite(Date.parse(probe.at)) && Date.now() - Date.parse(probe.at) < 60_000)
      checks.push({
        code: 'peer_probe', state: probe.stage === 'verified' ? 'ok' : 'warning',
        title: probe.stage === 'verified' ? t('已完成一次对端身份探测') : probe.stage === 'transport_failed' ? t('收到发现信息，但未连通对端') : t('对端响应未通过身份验证'),
        detail: probe.stage === 'verified' ? t('该次探测已验证签名；配对与加密通道状态见具体设备。')
          : probe.stage === 'transport_failed' ? t('请在对端检查 Rivloom 是否仍运行及局域网通信权限。超时也可能由网络隔离或地址变化引起，尚不能确定为防火墙。')
            : t('请核对两端时间和版本。响应尚不可信，不会据此建立配对。'),
        action: 'retry',
      });
    checks.push({
      code: 'transport',
      state: network.diagnostics.mdnsActive || network.diagnostics.udpActive ? 'ok' : 'unknown',
      title: t('发现通道'),
      detail: t('mDNS：{{value1}}；局域网 UDP：{{value2}}。通道启动不代表已发现对端。', {
        value1: network.diagnostics.mdnsActive ? t('已启动') : t('未启动'),
        value2: network.diagnostics.udpActive ? t('已启动') : t('未启动'),
      }),
    });
    if (network.diagnostics.incompatibleAnnouncementAt)
      checks.push({
        code: 'incompatible_discovery',
        state: 'warning',
        title: t('检测到不同协议的发现广播'),
        detail: t('广播来源尚未通过身份验证。请核对另一台 Rivloom 的版本，再重新发现。'),
        action: 'network',
      });
  }
  checks.push(
    engine.ready
      ? {
          code: 'engine',
          state: 'ok',
          title: t('执行引擎已就绪'),
          detail: t('可以继续检查模型与任务条件。'),
        }
      : {
          code: 'engine',
          state: 'blocked',
          title: t('执行引擎未就绪'),
          detail: t('等待引擎启动；持续失败时保留已有任务，检查本机运行环境。'),
          action: 'models',
        },
  );
  const model = policy.model || data.defaultModel;
  checks.push(
    model && engine.models.some((m) => m.id === model)
      ? {
          code: 'model',
          state: 'ok',
          title: t('已配置可用模型'),
          detail: t('当前目录中有该模型；实际调用结果以任务返回为准。'),
        }
      : {
          code: 'model',
          state: 'blocked',
          title: t('缺少可用模型'),
          detail: t('打开模型设置完成连接，再检查执行模型。'),
          action: 'models',
        },
  );
  checks.push(
    policy.enabled
      ? {
          code: 'execution',
          state: 'ok',
          title: t('已开启接收任务的执行能力'),
          detail: t('仍需满足项目、模型和执行槽条件。'),
        }
      : {
          code: 'execution',
          state: 'warning',
          title: t('接收的任务会等待执行'),
          detail: t('本机执行能力已关闭；可信任务仍可收件。本机会话不受此接收开关限制。'),
          action: 'network',
        },
  );
  if (!policy.projectID || !data.projects.some((p) => p.id === policy.projectID))
    checks.push({
      code: 'project',
      state: 'warning',
      title: t('接收任务的执行文件夹未配置'),
      detail: t('在本机执行能力中选择文件夹。'),
      action: 'network',
    });
  return {
    nodeID: network.local?.id || null,
    name: network.local?.name || t('本机'),
    local: true,
    lastContactAt: null,
    checks,
  };
}

export function diagnosePeer(
  node: RivloomNode,
  now = Date.now(),
  expectedProtocol = 1,
): NodeDiagnostic {
  const checks: DiagnosticCheck[] = [];
  const contact =
    node.lastContactAt && Number.isFinite(Date.parse(node.lastContactAt))
      ? node.lastContactAt
      : null;
  checks.push({
    code: 'presence',
    state: node.online ? 'ok' : 'blocked',
    title: node.online ? t('设备在线') : t('当前未连接到设备'),
    detail: node.online
      ? t('已观测到对端消息，继续检查信任与通道。')
      : t('保持对端 Rivloom 打开，确认网络互通后重试。未重新收到消息前，旧状态只供参考。'),
    action: 'retry',
  });
  checks.push({
    code: 'identity',
    state: node.verified ? 'ok' : 'unknown',
    title: node.verified ? t('设备身份已验证') : t('等待本次身份验证'),
    detail: node.verified ? t('已校验设备签名。') : t('保存的配对不能证明对端本次启动已在线。'),
  });
  checks.push({
    code: 'protocol',
    state: node.protocolVersion !== expectedProtocol ? 'blocked' : node.verified ? 'ok' : 'unknown',
    title:
      node.protocolVersion !== expectedProtocol
        ? t('节点协议不兼容')
        : node.verified
          ? t('节点协议兼容')
          : t('协议待确认'),
    detail:
      node.protocolVersion !== expectedProtocol
        ? t('核对两端版本并使用兼容版本后重试。')
        : t('具体功能仍需要双方协商对应能力。'),
  });
  checks.push({
    code: 'trust',
    state: node.trusted ? 'ok' : 'blocked',
    title: node.trusted ? t('已保存配对信任') : t('尚未配对'),
    detail: node.trusted
      ? t('恢复通信会使用原信任关系。')
      : t('在节点页核对双方短码和指纹，再完成配对。'),
    action: 'network',
  });
  checks.push({
    code: 'channel',
    state: node.channelReady && node.online && node.trusted ? 'ok' : 'blocked',
    title:
      node.channelReady && node.online && node.trusted ? t('加密通道已就绪') : t('加密通道未就绪'),
    detail: node.trusted
      ? t('重试会使用原身份恢复通道，不会重建配对或重发新任务。')
      : t('先完成双向配对。'),
    action: node.trusted ? 'retry' : 'network',
  });
  if (!node.online || !node.channelReady) {
    checks.push({
      code: 'execution',
      state: 'unknown',
      title: t('执行能力待刷新'),
      detail: t('恢复认证通信后才能确认当前能力和排队信息。'),
    });
  } else if (!node.worker || !freshness(node.worker.load.sampledAt, now)) {
    checks.push({
      code: 'execution',
      state: 'unknown',
      title: t('执行报告缺失或已过期'),
      detail: t('不能据此推断空闲槽或执行开关。请刷新连接状态。'),
      action: 'retry',
    });
  } else {
    checks.push(
      node.worker.accepting
        ? {
            code: 'execution',
            state: 'ok',
            title: t('已开放执行资源'),
            detail:
              node.worker.load.availableSlots > 0
                ? t('报告显示有空闲槽，任务仍需通过最终准入。')
                : t('当前没有空闲槽；指定任务仍在原 Node 排队，不会自动改派。'),
          }
        : {
            code: 'execution',
            state: 'warning',
            title: t('对端暂未开放可执行资源'),
            detail: t('请在对端检查执行开关、模型和文件夹。此报告不能单独确定是哪项未就绪。'),
          },
    );
  }
  if (node.online && node.channelReady) {
    const queue = node.nodeQueue;
    checks.push(
      !queue || !freshness(queue.sampledAt, now)
        ? {
            code: 'queue',
            state: 'unknown',
            title: t('队列统计待确认'),
            detail: t('对端未提供新鲜统计，排位以当前任务认证回执为准。'),
          }
        : {
            code: 'queue',
            state: queue.paused ? 'warning' : 'ok',
            title: queue.paused ? t('对端队列已暂停') : t('队列统计已刷新'),
            detail: queue.paused
              ? t('等待对端恢复后续执行；正在运行的任务不因此暂停。')
              : t('当前等待 {{value1}} 项。这是统计值，不是预计开始时间。', {
                  value1: queue.waitingCount,
                }),
          },
    );
    checks.push({
      code: 'files',
      state: node.capabilities.includes('task-files-v1') ? 'ok' : 'warning',
      title: node.capabilities.includes('task-files-v1')
        ? t('支持任务文件传输')
        : t('对端尚不支持任务文件传输'),
      detail: node.capabilities.includes('task-files-v1')
        ? t('文件仍按原任务路由与接收校验处理。')
        : t('文字任务可继续使用；文件任务需在两端使用支持此能力的版本。'),
    });
  }
  return {
    nodeID: node.id,
    name: node.remark || node.name,
    local: false,
    lastContactAt: contact,
    checks,
  };
}

/** Copy a bounded summary without task text, paths, addresses, fingerprints, or credentials. */
export function diagnosticSummary(value: NodeDiagnostic, checkedAt: string) {
  return [
    t('Rivloom 连接诊断'),
    t('检查时间：{{value1}}', { value1: checkedAt }),
    value.local ? t('范围：本机') : t('范围：所选远端设备'),
    t('最近确认通信：{{value1}}', { value1: value.lastContactAt || t('本次启动尚未记录') }),
    ...value.checks.map((c) => `${c.code}: ${c.state} · ${c.title}`),
  ].join('\n');
}
