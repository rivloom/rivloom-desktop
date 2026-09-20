import { useState } from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import { t, systemText } from '../shared/i18n.ts';
import type { WorkflowStep } from '../shared/workflows.ts';
import type { WorkflowRecentExecution } from './workflow-recent.ts';
import { MessageMarkdown } from './message-markdown';

function toolStatus(status: string) {
  return ({ pending: t('等待处理'), running: t('执行中'), completed: t('已完成'), error: t('执行失败'), failed: t('执行失败') } as Record<string, string>)[status] || systemText(status);
}

export function WorkflowRecentOutput({ entry, nodeName, showStep }: {
  entry: WorkflowRecentExecution; nodeName: (id: string | null) => string; showStep: (step: WorkflowStep) => void;
}) {
  const [full, setFull] = useState(false);
  const long = entry.text.length > 1800;
  return <section className="workflow-recent-output" aria-label={entry.remote ? t('远端执行摘要') : t('近期执行内容')}>
    <div className="workflow-recent-heading"><button type="button" onClick={() => showStep(entry.step)}>{entry.step.title}<ChevronRight size={12} /></button>
      <small>{entry.remote ? t('远端执行摘要') : nodeName(entry.attempt.nodeID)}</small></div>
    {entry.text && <div className="workflow-recent-message">
      {long && !full ? <p className="workflow-recent-excerpt">{entry.text.slice(0, 1800)}…</p> : <MessageMarkdown text={entry.text} />}
      {long && <button type="button" className="workflow-recent-expand" aria-expanded={full} onClick={() => setFull(!full)}>
        {full ? t('收起全文') : t('展开完整内容')}{full ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button>}
    </div>}
    {!!entry.tools.length && <div className="workflow-recent-tools">
      {entry.tools.map(({ key, tool }) => <details key={key} className={`workflow-recent-tool ${tool.status === 'error' || tool.status === 'failed' ? 'failed' : ''}`}>
        <summary><Wrench size={12} /><span title={tool.title || tool.name}>{tool.title || tool.name}</span><small>{toolStatus(tool.status)}</small><ChevronRight size={12} /></summary>
        <pre>{tool.output ? tool.output.slice(0, 4000) + (tool.output.length > 4000 ? '…' : '') : t('暂无工具输出')}</pre>
        {tool.output.length > 4000 && <button type="button" className="workflow-recent-expand" onClick={() => showStep(entry.step)}>{t('查看完整工具记录')}<ChevronRight size={12} /></button>}
      </details>)}
    </div>}
  </section>;
}
