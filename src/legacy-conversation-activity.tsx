import { useState } from 'react';
import { t } from '../shared/i18n.ts';
import type { Conversation } from '../shared/conversations.ts';
import { conversationIsFailed, conversationIsRunning, conversationState } from './conversations';
import { conversationActivitySummary, type ActivityTone } from './conversation-activity';
import { ActivityDisclosure } from './conversation-activity-view';
import { MessageTrace } from './message-trace';
import { TaskFileRecovery } from './task-files';
import { useTaskFileStates, type TaskFileQuery } from './use-task-file-state';
import { conversationJourney } from './conversation-journey';

export function legacyFileRevision(item: Conversation): string {
  return JSON.stringify([item.localTask?.state, item.localTask?.runAfter, item.localTask?.inputFiles?.map(file => file.id),
    item.remote?.executionState, item.remote?.executionSequence, item.remote?.status, item.brainTask?.status]);
}

export function LegacyConversationActivity({ item, nodeName, connected, localNodeID }: {
  item: Conversation; nodeName: (id: string | null) => string; connected: boolean; localNodeID: string | null;
}) {
  const [count, setCount] = useState(12);
  const route: TaskFileQuery = { scope: item.brainTask ? 'brain' : item.remote ? 'remote' : 'local',
    taskID: item.brainTask?.id || item.remote?.id || item.localTask!.id };
  const files = useTaskFileStates([route], legacyFileRevision(item));
  const task = item.localTask, remote = item.remote;
  const state = task?.state || remote?.executionState || item.brainTask?.status;
  const terminal = ['review', 'accepted', 'completed', 'stopped', 'cancelled', 'rejected', 'expired'].includes(state || '')
    || !!remote && ['cancelled', 'rejected', 'expired'].includes(remote.status);
  const attentionCount = (task?.approvals.length || remote?.remoteApprovals.length || 0) + (task?.questions.length || remote?.remoteQuestions.length || 0);
  const tone: ActivityTone = attentionCount || conversationIsFailed(item) || state === 'interrupted' ? 'attention'
    : !connected && !terminal ? 'unavailable' : terminal ? 'settled' : conversationIsRunning(item) ? 'active' : 'waiting';
  const summary = conversationActivitySummary({ label: !connected && !terminal ? t('状态待更新') : conversationState(item), tone, files, attentionCount });
  const journey = conversationJourney({ conversationKey: item.key, localNodeID, conversation: item,
    transfers: summary.transfers, fresh: connected });
  const messages = (task?.messages || []).filter(message => message.role === 'assistant' && (message.tools.length || message.parts?.some(part => part.type !== 'text')));
  return <div className="legacy-conversation-activity">
    <ActivityDisclosure summary={summary} journey={journey} identityKey={item.key} nodeName={nodeName} actions={<TaskFileRecovery states={files} />}>
      {messages.length > count && <button type="button" className="activity-show-more" onClick={() => setCount(value => value + 20)}>{t('加载更早的过程')}</button>}
      {messages.slice(-count).map(message => <div className="legacy-activity-record" key={message.id}>
        <MessageTrace message={message} showText={false} active={tone === 'active'} />
      </div>)}
      {!messages.length && !summary.transfers.some(file => file.state !== 'complete') && <p className="activity-process-note">{summary.label}</p>}
    </ActivityDisclosure>
  </div>;
}
