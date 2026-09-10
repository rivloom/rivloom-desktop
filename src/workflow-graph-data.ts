import { t } from '../shared/i18n.ts';
import type { Workflow, WorkflowAttempt, WorkflowStep } from '../shared/workflows.ts';
export type WorkflowGraphNode = { id: string; step: WorkflowStep; attempt: WorkflowAttempt | null; historical: boolean };
export type WorkflowGraphEdge = { id: string; from: string; to: string; kind: 'dependency' | 'handoff'; label: string };
export function workflowGraph(value: Workflow) {
  const nodes: WorkflowGraphNode[] = []; const edges: WorkflowGraphEdge[] = [];
  const first = new Map<string, string>(); const last = new Map<string, string>();
  for (const step of value.steps) {
    const latest = step.attempts.at(-1);
    const handoffs = value.handoffs.filter((h) => h.stepID === step.id).sort((a, b) => a.fromAttempt - b.fromAttempt);
    // Query continuations stay in the same Node segment. All attempts remain in the detail selector.
    const numbers = new Set([...(latest ? [latest.number] : [0]), ...handoffs.map((h) => h.fromAttempt)]);
    for (const number of [...numbers].sort((a, b) => a - b)) {
      const id = `${step.id}:${number}`; const attempt = step.attempts.find((a) => a.number === number) || null;
      nodes.push({ id, step, attempt, historical: !!attempt && attempt !== latest });
      if (!first.has(step.id)) first.set(step.id, id); last.set(step.id, id);
    }
    for (const [index, handoff] of handoffs.entries()) edges.push({ id: handoff.id, from: `${step.id}:${handoff.fromAttempt}`,
      to: `${step.id}:${handoffs[index + 1]?.fromAttempt || latest?.number || handoff.toAttempt}`, kind: 'handoff', label: handoff.reason });
  }
  for (const step of value.steps) for (const dependency of step.dependsOn) {
    const predecessor = value.steps.find((s) => s.id === dependency);
    const file = predecessor?.attempts.at(-1)?.outputFiles[0];
    if (last.has(dependency)) edges.push({ id: `${dependency}>${step.id}`, from: last.get(dependency)!, to: first.get(step.id)!,
      kind: 'dependency', label: file?.name || t('完成后继续') });
  }
  return { nodes, edges };
}
export function layoutWorkflowGraph(graph: ReturnType<typeof workflowGraph>, width: number) {
  const paddingX = 18; const paddingY = 18; const gapX = 36; const gapY = 16; const height = 104;
  const ranks = new Map<string, number>();
  const rank = (id: string, visiting = new Set<string>()): number => {
    if (ranks.has(id)) return ranks.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = graph.edges.filter((e) => e.to === id);
    const value = parents.length ? Math.max(...parents.map((e) => rank(e.from, new Set(visiting)))) + 1 : 0;
    ranks.set(id, value); return value;
  };
  graph.nodes.forEach((node) => rank(node.id));
  const positions = new Map<string, { x: number; y: number; width: number; height: number; rank: number }>();
  const levels = [...new Set(ranks.values())].sort((a, b) => a - b);
  const groups = levels.map((level) => graph.nodes.filter((node) => ranks.get(node.id) === level));
  const cardWidth = Math.min(220, Math.max(160,
    (Math.max(width, 244) - paddingX * 2 - Math.max(0, groups.length - 1) * gapX) / Math.max(1, groups.length)));
  const rows = Math.max(1, ...groups.map((nodes) => nodes.length));
  const contentHeight = rows * height + (rows - 1) * gapY;
  for (const [column, nodes] of groups.entries()) {
    const startY = paddingY + (contentHeight - nodes.length * height - (nodes.length - 1) * gapY) / 2;
    for (const [index, node] of nodes.entries()) {
      positions.set(node.id, { x: paddingX + column * (cardWidth + gapX), y: startY + index * (height + gapY),
        width: cardWidth, height, rank: levels[column] });
    }
  }
  return { positions, width: Math.max(width, 244, paddingX * 2 + groups.length * cardWidth + Math.max(0, groups.length - 1) * gapX),
    height: contentHeight + paddingY * 2 };
}
export function workflowStepLabel(step: WorkflowStep, attempt?: WorkflowAttempt | null) {
  if (attempt && ['intent', 'queued', 'waiting', 'unknown'].includes(attempt.phase)) return {
    intent: t('正在投递'), queued: t('已入队'), waiting: t('等待处理'), unknown: t('状态待确认'),
  }[attempt.phase as 'intent' | 'queued' | 'waiting' | 'unknown'];
  return { waiting: t('等待前置步骤'), ready: t('等待执行条件'), running: t('执行中'), completed: t('已完成'),
    failed: t('执行失败'), cancelled: t('已取消'), blocked: t('前置步骤未完成') }[step.state];
}
