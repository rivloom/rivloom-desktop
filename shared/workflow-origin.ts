import { keys, nodeID, record, text } from './collaboration.ts';
import type { Workflow, WorkflowExecutionContext, WorkflowPlan, WorkflowStep, WorkflowStepPlacement, WorkflowTarget } from './workflows.ts';

export const workflowPlacementPolicy = 'placement-v1' as const;
const contractMarker = 'RIVLOOM_PLACEMENT_CONTRACT_V1';

/** A trusted coordinator prefix; never detect a policy by scanning user/history text. */
export function workflowUsesPlacementContract(context: Pick<WorkflowExecutionContext, 'priorContext'>): boolean {
  return context.priorContext.startsWith(contractMarker + '\n');
}

/** This text also reaches old peers, without adding fields to their strict wire schema. */
export function workflowPlacementContract(originNodeID?: string): string {
  return `${contractMarker}
Use the full request/history to decide device scope, not phrase matching. Origin Node: ${nodeID(originNodeID) ? originNodeID : 'unknown; never guess'}. The planner host does not change that referent. Required means the user needs an observation/change on that particular machine, including a named remote. Otherwise use free. Origin does not lock all work. GPU/software/load/file location describe eligibility or materials, not identity: even if only one Node currently qualifies, use free plus requirements/software/resources; step.nodeID remains a soft preference.
Every plan/expand step.instructions MUST begin with one JSON line, newline, then business instructions:
{"rivloomPlacement":1,"mode":"free","reason":"Portable work"}
or {"rivloomPlacement":1,"mode":"required","nodeID":"origin","reason":"Machine-specific work"}.
Required nodeID may instead be a real 32-character Node ID from device facts. Exact keys; reason 1-400 characters. Required parents/global locks cannot be relaxed. Missing/conflicting headers block execution, never fall back.
Resolve ambiguous referents with a question before work. If this planner cannot ask, emit ONLY a free clarification step whose executor asks then expands after the answer; no inspection/business before the answer. If it cannot ask either, report the limitation. Resource kind=query is not a user question.`;
}

/** Only local sidecars use this type. It is not a wire StepPlan field. */
export function validWorkflowStepPlacement(value: unknown): value is WorkflowStepPlacement {
  return record(value) && value.version === 1 && text(value.reason, 400) &&
    (value.mode === 'free' ? keys(value, ['version', 'mode', 'reason']) :
      value.mode === 'required' && keys(value, ['version', 'mode', 'nodeID', 'reason']) && nodeID(value.nodeID));
}

// JSON.parse accepts duplicate keys. Reject them in this flat transport object before
// validating its values, rather than allowing two contradictory placement decisions.
function uniqueHeaderKeys(line: string) {
  const seen = new Set<string>();
  for (let index = 0; index < line.length; index++) {
    if (line[index] !== '"') continue;
    const start = index++;
    while (index < line.length) {
      if (line[index] === '\\') { index += 2; continue; }
      if (line[index] === '"') break;
      index++;
    }
    const end = index;
    while (index + 1 < line.length && /\s/u.test(line[index + 1])) index++;
    if (line[index + 1] !== ':') continue;
    const key = JSON.parse(line.slice(start, end + 1)) as string;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

export function decodeWorkflowPlacementPlan(plan: WorkflowPlan, input: {
  originNodeID?: string; knownNodeIDs: readonly string[]; target: WorkflowTarget; parent?: WorkflowStepPlacement;
}): { plan: WorkflowPlan; placements: Record<string, WorkflowStepPlacement> } {
  const placements: Record<string, WorkflowStepPlacement> = Object.create(null);
  const steps = plan.steps.map(step => {
    const newline = step.instructions.indexOf('\n');
    const line = step.instructions.slice(0, newline).replace(/\r$/u, '');
    if (newline < 0 || line.length > 1600) throw new Error('workflow_placement_header_invalid');
    let header: unknown;
    try {
      if (!uniqueHeaderKeys(line)) throw new Error();
      header = JSON.parse(line);
    } catch { throw new Error('workflow_placement_header_invalid'); }
    if (!record(header) || header.rivloomPlacement !== 1 || !text(header.reason, 400) ||
      (header.mode === 'free' ? !keys(header, ['rivloomPlacement', 'mode', 'reason']) :
        header.mode !== 'required' || !keys(header, ['rivloomPlacement', 'mode', 'nodeID', 'reason']) ||
        header.nodeID !== 'origin' && !nodeID(header.nodeID))) throw new Error('workflow_placement_header_invalid');
    const instructions = step.instructions.slice(newline + 1).trim();
    if (!text(instructions, 12_000)) throw new Error('workflow_placement_header_invalid');
    let placement: WorkflowStepPlacement;
    if (header.mode === 'free') placement = { version: 1, mode: 'free', reason: header.reason };
    else {
      const requiredNode = header.nodeID === 'origin' ? input.originNodeID : header.nodeID;
      if (!nodeID(requiredNode)) throw new Error('workflow_placement_origin_unknown');
      if (!input.knownNodeIDs.includes(requiredNode)) throw new Error('workflow_placement_node_unknown');
      placement = { version: 1, mode: 'required', nodeID: requiredNode, reason: header.reason };
    }
    if (placement.mode === 'required' && input.target.mode === 'locked' && placement.nodeID !== input.target.nodeID ||
      input.parent?.mode === 'required' && (placement.mode !== 'required' || placement.nodeID !== input.parent.nodeID))
      throw new Error('workflow_placement_conflict');
    placements[step.id] = placement;
    return { ...step, instructions };
  });
  return { plan: { ...plan, steps }, placements };
}

/** Semantic required placement is independent of the legacy soft step.nodeID. */
export function workflowEffectiveTarget(value: Pick<Workflow, 'target'>, step?: Pick<WorkflowStep, 'placement'>): WorkflowTarget {
  if (value.target.mode === 'locked') return value.target;
  if (step?.placement?.mode === 'required') return { mode: 'locked', nodeID: step.placement.nodeID };
  return value.target;
}
