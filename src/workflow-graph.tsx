import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Circle, LoaderCircle, LockKeyhole, AlertCircle, ArrowRightLeft } from 'lucide-react';
import { t } from '../shared/i18n.ts';
import type { Workflow } from '../shared/workflows.ts';

import { workflowGraph, layoutWorkflowGraph, workflowStepLabel, type WorkflowGraphNode } from './workflow-graph-data.ts';
export { workflowStepLabel, type WorkflowGraphNode } from './workflow-graph-data.ts';
export function WorkflowGraph({ value, selected, select, nodeName }: {
  value: Workflow; selected: string | null; select: (node: WorkflowGraphNode) => void; nodeName: (id: string | null) => string;
}) {
  const ref = useRef<HTMLDivElement>(null); const [width, setWidth] = useState(640);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(ref.current); return () => observer.disconnect();
  }, []);
  const graph = useMemo(() => workflowGraph(value), [value.steps, value.handoffs]);
  const layout = useMemo(() => layoutWorkflowGraph(graph, width), [graph, width]);
  return <div className="workflow-graph" ref={ref} aria-label={t('任务依赖与转交图')}>
    <div className="workflow-graph-scroll" tabIndex={0} role="region" aria-label={t('任务依赖与转交图')}>
      <ol className="workflow-graph-canvas" style={{ width: layout.width, height: layout.height }}>
        <svg aria-hidden="true" className="workflow-graph-lines" width={layout.width} height={layout.height}>
          {graph.edges.map((edge, index) => {
            const from = layout.positions.get(edge.from); const to = layout.positions.get(edge.to); if (!from || !to) return null;
            const x1 = from.x + from.width; const y1 = from.y + from.height / 2;
            const x2 = to.x; const y2 = to.y + to.height / 2; const mid = (x1 + x2) / 2;
            const skipped = to.rank > from.rank + 1; const gutter = 4 + index % 3 * 4;
            const path = skipped ? `M ${x1} ${y1} H ${x1 + 16} V ${gutter} H ${x2 - 20} V ${y2} H ${x2}` :
              `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
            return <g className={edge.kind} key={edge.id}><title>{edge.label}</title><path d={path} />
              <path className="workflow-edge-arrow" d={`M ${x2 - 5} ${y2 - 3} L ${x2} ${y2} L ${x2 - 5} ${y2 + 3}`} />
              {edge.kind === 'handoff' && !skipped && <text x={mid} y={(y1 + y2) / 2 - 8} textAnchor="middle">{t('转交')}</text>}
            </g>;
          })}
        </svg>
        {graph.nodes.map((node) => {
          const position = layout.positions.get(node.id)!;
          const status = node.historical ? t('已转交') : workflowStepLabel(node.step, node.attempt);
          const state = node.historical ? 'handed-off' : node.step.state;
          const assigned = node.attempt?.nodeID || node.step.nodeID || (value.target.mode === 'locked' ? value.target.nodeID : null);
          return <li key={node.id} style={{ left: position.x, top: position.y, width: position.width, height: position.height }}>
            <button type="button" className={`workflow-step ${state} ${selected === node.id ? 'selected' : ''}`}
              aria-pressed={selected === node.id} onClick={() => select(node)}
              title={`${node.step.title} · ${status} · ${assigned ? nodeName(assigned) : t('待分配')}${node.step.dependsOn.length ? ` · ${t('前置步骤')} ${node.step.dependsOn.join(', ')}` : ''}`}>
              <span className="workflow-step-top">
                {node.historical ? <ArrowRightLeft size={14} /> : state === 'completed' ? <Check size={15} /> : state === 'running' && node.attempt?.phase === 'running' ?
                  <LoaderCircle size={14} className="spin" /> : ['failed', 'blocked'].includes(state) ? <AlertCircle size={14} /> : <Circle size={13} />}
                <span>{status}</span><small>{node.attempt ? `#${node.attempt.number}` : '—'}</small>
              </span>
              <strong>{node.step.title}</strong>
              <span className="workflow-step-node">{value.target.mode === 'locked' && <LockKeyhole size={12} />}{assigned ? nodeName(assigned) : t('待分配')}</span>
            </button>
          </li>;
        })}
      </ol>
    </div>
    <div className="workflow-graph-legend"><span><i />{t('步骤依赖')}</span><span><i className="handoff" />{t('执行转交')}</span><small>{t('选择步骤查看执行记录')}</small></div>
  </div>;
}
