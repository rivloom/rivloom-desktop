import { collaborationCapability } from '../shared/collaboration.ts';
import { nodeQueueBacklog } from '../shared/queue-backlog.ts';
import { resourceFreshMilliseconds, type ResourceDiscoveryNode } from '../shared/resources.ts';
import { workflowControlsCapability } from '../shared/workflow-channel.ts';
import type { WorkflowDiagnosticReason, WorkflowNodeDiagnostic } from '../shared/workflow-diagnostics.ts';
import type { NodeNetwork, TaskHardwareRequirements, WorkerHardware } from '../shared/types.ts';
import type { WorkflowStep } from '../shared/workflows.ts';
import { validWorkerRegistration, workerHardwareMatches, workerReportFresh } from './worker-resources.ts';
import type { WorkflowCandidate } from './workflow-service.ts';

export type WorkflowPlacementInput = {
  network: Pick<NodeNetwork, 'local' | 'paired' | 'brains'>;
  owner: boolean;
  catalog: ResourceDiscoveryNode[];
  local: { projectID: string | null; model: string | null; reasoningEffort?: import('../shared/model-reasoning.ts').ReasoningEffort; projectExists: boolean; modelAvailable: boolean;
    engineReady: boolean; accepting: boolean; waitingCount: number };
};
export type WorkflowPlacement = { candidates: WorkflowCandidate[]; nodes: WorkflowNodeDiagnostic[] };

function hardwareReasons(requirements: TaskHardwareRequirements, hardware: WorkerHardware): WorkflowDiagnosticReason[] {
  const reported: Record<keyof TaskHardwareRequirements, string | number | boolean | null> = {
    platform: hardware.platform, architecture: hardware.architecture, minimumLogicalCores: hardware.logicalCores,
    minimumMemoryBytes: hardware.memoryBytes, gpu: hardware.gpus.length > 0,
    minimumGpuMemoryBytes: hardware.gpus.some((g) => g.memoryBytes !== null)
      ? Math.max(...hardware.gpus.map((g) => g.memoryBytes ?? -1)) : null,
  };
  return (Object.entries(requirements) as [keyof TaskHardwareRequirements, string | number | boolean][]).flatMap(([requirement, required]) => {
    const actual = reported[requirement];
    const matches = typeof required === 'number' ? typeof actual === 'number' && actual >= required :
      requirement === 'gpu' && required === false || actual === required;
    if (matches) return [];
    const unknown = actual === null || requirement === 'minimumGpuMemoryBytes' && hardware.gpus.some((g) => g.memoryBytes === null);
    return [{ code: unknown ? 'hardware_unknown' : 'hardware_unavailable', certainty: unknown ? 'unknown' : 'confirmed',
      observedAt: hardware.collectedAt, hardware: { requirement, required, reported: unknown ? null : actual } } satisfies WorkflowDiagnosticReason];
  });
}

/** Read-only evaluation used by both dispatch and diagnostics; ranking remains unchanged. */
export function evaluateWorkflowPlacement(step: WorkflowStep, input: WorkflowPlacementInput, at = Date.now()): WorkflowPlacement {
  const candidates: WorkflowCandidate[] = [], nodes: WorkflowNodeDiagnostic[] = [];
  const { network, local } = input;
  const now = new Date(at).toISOString();
  function software(nodeID: string): WorkflowDiagnosticReason[] {
    const head = input.catalog.find((node) => node.nodeID === nodeID)?.head;
    return step.software.flatMap((name) => {
      const entries = head?.capabilities.filter((e) => e.kind === 'software' &&
        (e.id.toLowerCase() === name.toLowerCase() || e.name.toLowerCase() === name.toLowerCase())) || [];
      // Keep the existing eligibility freshness rule, including its clock-skew behavior.
      if (entries.some((e) => e.status === 'available' && at - Date.parse(e.checkedAt) < resourceFreshMilliseconds)) return [];
      const unavailable = entries.find((e) => e.status === 'unavailable' &&
        Date.parse(e.checkedAt) <= at && at - Date.parse(e.checkedAt) < resourceFreshMilliseconds);
      return [{ code: unavailable ? 'software_unavailable' : 'software_unknown',
        certainty: unavailable ? 'confirmed' : 'unknown', software: name,
        observedAt: unavailable?.checkedAt || entries[0]?.checkedAt || head?.checkedAt || null } satisfies WorkflowDiagnosticReason];
    });
  }
  if (network.local) {
    const own = network.local, reasons: WorkflowDiagnosticReason[] = [];
    const add = (code: WorkflowDiagnosticReason['code'], certainty: WorkflowDiagnosticReason['certainty'] = 'confirmed', observedAt: string | null = now) =>
      reasons.push({ code, certainty, observedAt });
    if (!local.projectID || !local.projectExists) add('project_unavailable');
    if (!local.engineReady) add('engine_unavailable');
    if (!local.modelAvailable) add('model_unavailable');
    if (!local.accepting) add('queue_unavailable');
    reasons.push(...software(own.id));
    if (Object.keys(step.requirements).length) {
      if (!own.worker) add('report_missing', 'unknown', null);
      else if (!workerReportFresh(own.worker, at)) add('report_stale', 'unknown', own.worker.load.sampledAt);
      else if (!workerHardwareMatches(own.worker.hardware, step.requirements)) reasons.push(...hardwareReasons(step.requirements, own.worker.hardware));
    }
    nodes.push({ nodeID: own.id, reasons });
    if (!reasons.length) candidates.push({ nodeID: own.id, kind: 'local', waitingCount: local.waitingCount,
      localConfig: { projectID: local.projectID!, model: local.model!, ...(local.reasoningEffort !== undefined ? { reasoningEffort: local.reasoningEffort } : {}) } });
  }
  if (input.owner) for (const node of network.paired || []) {
    const reasons: WorkflowDiagnosticReason[] = [];
    const add = (code: WorkflowDiagnosticReason['code'], certainty: WorkflowDiagnosticReason['certainty'] = 'confirmed', observedAt = node.lastContactAt || null) =>
      reasons.push({ code, certainty, observedAt });
    // Stale peer configuration cannot establish why a disconnected machine cannot execute.
    if (!node.online) add('node_offline');
    else if (!node.trusted) add('trust_required');
    else if (!node.channelReady) add('channel_unavailable');
    else {
      if (!node.capabilities.includes(collaborationCapability)) add('capability_unsupported');
      const worker = node.worker;
      if (!worker || !validWorkerRegistration(worker)) add('report_missing', 'unknown');
      else if (!workerReportFresh(worker, at)) add('report_stale', 'unknown', worker.load.sampledAt);
      else {
        if (!worker.accepting) add('execution_unavailable', 'confirmed', worker.load.sampledAt);
        if (!workerHardwareMatches(worker.hardware, step.requirements)) reasons.push(...hardwareReasons(step.requirements, worker.hardware));
      }
      reasons.push(...software(node.id));
      if (!network.brains.some((b) => b.state === 'established' && b.online && node.brains.some((n) => n.id === b.id))) add('topology_unavailable');
    }
    nodes.push({ nodeID: node.id, reasons });
    if (!reasons.length) candidates.push({ nodeID: node.id, kind: 'remote', waitingCount: nodeQueueBacklog(node, at) ?? node.worker!.load.runningTasks,
      ...(node.capabilities.includes(workflowControlsCapability) ? { resultDelivery: 'on-demand' as const } : {}) });
  }
  candidates.sort((a, b) => a.waitingCount - b.waitingCount ||
    Number(step.resources.some((r) => r.nodeID === b.nodeID)) - Number(step.resources.some((r) => r.nodeID === a.nodeID)) || a.nodeID.localeCompare(b.nodeID));
  return { candidates, nodes };
}
