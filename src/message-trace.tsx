import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Activity, Brain, Check, ChevronDown, ChevronRight, Circle, Terminal, X } from 'lucide-react';
import { language, t, systemText } from '../shared/i18n';
import { activeStates, type Message, type MessagePart, type Task } from '../shared/types';
import { messageSpeed } from '../shared/message-speed';
import { MessageMarkdown } from './message-markdown';
import { CopyButton } from './copy-button';
import './message-trace.css';

export function MessageSpeed({ message, active }: { message: Message; active: boolean }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active || message.timing?.completed) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, message.id, message.timing?.completed]);
  const speed = messageSpeed(message, active, now);
  if (!speed) return null;
  const hint = speed.estimated ? t('根据已返回文字估算的平均速度；包含等待时间，最终以引擎用量为准。') :
    t('输出与推理 Token 合计 ÷ 本条回复用时，包含等待和工具执行时间。');
  return <span className={`message-speed ${speed.estimated ? 'live' : ''}`} title={hint} aria-label={`${t('平均速度')} ${speed.estimated ? '≈ ' : ''}${speed.value.toFixed(1)} token/s. ${hint}`}>
    <Activity size={12} /><span>{speed.estimated ? '≈ ' : ''}{new Intl.NumberFormat(language(), { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(speed.value)}</span><span>token/s</span>
  </span>;
}

function Reasoning({ part, active }: { part: Extract<MessagePart, { type: 'text' | 'reasoning' }>; active: boolean }) {
  const live = active && !part.endedAt;
  const [choice, setChoice] = useState<boolean | null>(null);
  const expanded = choice ?? live;
  const body = useRef<HTMLDivElement>(null), follow = useRef(true);
  useLayoutEffect(() => { if (body.current && live && follow.current) body.current.scrollTop = body.current.scrollHeight; }, [part.text, expanded, live]);
  if (!part.text.trim() && !live) return null;
  return <section className={`trace-reasoning ${live ? 'is-live' : ''}`}>
    <button type="button" className="trace-line" aria-expanded={expanded} onClick={() => setChoice(!expanded)}>
      <Brain size={14} /><span className="trace-kind">{live ? t('正在思考') : t('思考')}</span>
      {!expanded && <span className="trace-preview">{part.text.trim().replace(/\s+/g, ' ')}</span>}
      {live && <span className="trace-pulse" aria-hidden="true" />}{expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
    </button>
    {expanded && <div className="trace-reasoning-body" ref={body} onScroll={() => { const el = body.current; if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30; }}>
      <span>{part.text || t('等待模型返回思考内容…')}</span>{live && <span className="trace-cursor" aria-hidden="true" />}
      {part.truncated && <small>{t('内容过长，已截断显示。')}</small>}
    </div>}
  </section>;
}

function ToolCall({ part, active }: { part: Extract<MessagePart, { type: 'tool' }>; active: boolean }) {
  const pending = ['running', 'pending'].includes(part.status);
  const live = active && pending;
  const failed = ['error', 'failed'].includes(part.status);
  const status = live ? t('执行中') : pending ? t('执行已结束') : failed ? t('执行失败') : part.status === 'completed' ? t('已完成') : systemText(part.status);
  let preview = part.title;
  try {
    const input = JSON.parse(part.input);
    preview = [input.command, input.filePath, input.path, input.pattern, input.url].find(v => typeof v === 'string' && v.trim()) || preview;
  } catch { /* Old records have no saved input. */ }
  return <details className={`trace-tool ${live ? 'is-live' : ''} ${failed ? 'failed' : ''}`}>
    <summary className="trace-line">
      {live ? <span className="trace-pulse" aria-hidden="true" /> : failed ? <X size={13} /> : part.status === 'completed' ? <Check size={13} /> : <Circle size={12} />}
      <span className="trace-kind">{part.name}</span><span className="trace-preview" title={preview}>{preview}</span>
      <small>{status}</small><ChevronRight size={12} className="trace-chevron" />
    </summary>
    <div className="trace-tool-body">
      {part.input && <><h5><Terminal size={12} />{t('调用参数')}</h5><pre>{part.input}</pre></>}
      <h5>{t('执行结果')}</h5><pre>{part.output || (live ? t('等待执行结果…') : t('暂无工具输出'))}</pre>
      {part.truncated && <small>{t('内容过长，已截断显示。')}</small>}
      {part.output.trim() && <CopyButton text={part.output} label={t('复制工具输出')} iconOnly />}
    </div>
  </details>;
}

export function MessageTrace({ message, active = false, searchQuery = '', showText = true }: {
  message: Message; active?: boolean; searchQuery?: string; showText?: boolean;
}) {
  const parts: MessagePart[] = message.parts || [
    ...(message.text ? [{ id: 'text', type: 'text' as const, text: message.text }] : []),
    ...message.tools.map((tool, index) => ({ ...tool, id: `tool-${index}`, type: 'tool' as const, input: '' })),
  ];
  return <div className="message-trace">{parts.map(part => part.type === 'tool' ? <ToolCall key={part.id} part={part} active={active} /> :
    part.type === 'reasoning' ? <Reasoning key={part.id} part={part} active={active && !message.timing?.completed} /> :
      showText && part.text ? <div className="trace-text" key={part.id}><MessageMarkdown text={part.text} searchQuery={searchQuery} />
        {part.truncated && <small>{t('内容过长，已截断显示。')}</small>}</div> : null)}</div>;
}

export function TaskTrace({ task, label }: { task: Task; label: string }) {
  const active = activeStates.includes(task.state) && task.state !== 'stopping';
  const messages = task.messages.filter(m => m.role === 'assistant');
  const [choice, setChoice] = useState<boolean | null>(null);
  const [count, setCount] = useState(12);
  const expanded = choice ?? active;
  if (!messages.some(m => m.parts?.length || m.tools.length || m.text)) return null;
  const latest = messages.at(-1)!;
  return <section className={`task-trace ${active ? 'is-live' : ''}`} aria-label={t('思考与调用过程')}>
    <div className="task-trace-heading"><button type="button" aria-expanded={expanded} onClick={() => setChoice(!expanded)}>
      {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}<span>{label}</span><small>{t('思考与调用过程')}</small></button>
      <MessageSpeed message={latest} active={active} /></div>
    {expanded && <div className="task-trace-content">
      {messages.length > count && <button type="button" className="trace-earlier" onClick={() => setCount(count + 20)}>{t('加载更早的过程')}</button>}
      {messages.slice(-count).map(message => <MessageTrace key={message.id} message={message} active={active} />)}
    </div>}
  </section>;
}
