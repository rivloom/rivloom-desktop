import { useState, type Ref } from 'react';
import { AlertCircle, Check, ChevronDown, ChevronRight, Circle, Clock3, LoaderCircle } from 'lucide-react';
import { t } from '../shared/i18n.ts';
import type { Workflow, WorkflowStep } from '../shared/workflows.ts';
import { visibleWorkflowActivity, workflowActivityItems, workflowActivityPresentation } from './workflow-activity.ts';

export function WorkflowActivity({ value, nodeName, showStep, closeProcess, expanded, processID, processTrigger }: {
  value: Workflow; nodeName: (id: string | null) => string; showStep: (step: WorkflowStep) => void;
  closeProcess: () => void; expanded: boolean; processID: string;
  processTrigger: Ref<HTMLButtonElement>;
}) {
  const [all, setAll] = useState(false);
  const items = workflowActivityItems(value), shown = all ? items : visibleWorkflowActivity(items);
  return <section className={`workflow-activity ${value.state}`} aria-label={t('任务进展')}>
    <ol className="workflow-activity-list">
      {shown.map((item, index) => {
        const { step, attempt, nodeID } = item;
        const { label, attribution, elapsed, completed, detailsTitle } = workflowActivityPresentation(item, nodeID ? nodeName(nodeID) : '');
        const attention = ['failed', 'blocked'].includes(step.state) || attempt?.phase === 'unknown';
        return <li key={step.id}>
          <button ref={index === 0 ? processTrigger : undefined} type="button" className={`workflow-activity-step ${attention ? 'attention' : step.state}`}
            aria-controls={processID} aria-expanded={expanded} aria-label={[step.title, attribution, label, elapsed].join(' · ')}
            onClick={() => shown.length === 1 && expanded ? closeProcess() : showStep(step)}>
            {attention ? <AlertCircle size={13} /> : completed ? <Check size={13} /> : attempt?.phase === 'running' ? <LoaderCircle size={13} className="spin" /> : <Circle size={11} />}
            <span className="workflow-activity-description">
              <span className="workflow-activity-step-title" title={step.title}>{step.title}</span>
              <span className="workflow-activity-attribution" title={attribution}>{attribution}</span>
              {!completed && <small className="workflow-activity-state">{label}</small>}
            </span>
            <span className="workflow-activity-time" title={detailsTitle}><Clock3 size={11} />{elapsed}{expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</span>
          </button>
        </li>;
      })}
    </ol>
    {items.length > 3 && <button type="button" className="workflow-activity-more" aria-expanded={all} onClick={() => setAll(!all)}>
      {all ? t('收起步骤') : t('展开 {{count}} 个步骤', { count: items.length })}{all ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
    </button>}
  </section>;
}
