import { t, language } from '../shared/i18n.ts';
import type { Task } from '../shared/types.ts';
import type { TaskTodo } from '../shared/task-telemetry.ts';
import './task-telemetry.css';

function number(value: number | null, cost = false) {
  return value === null ? t('未提供') : new Intl.NumberFormat(language(),
    cost ? { maximumSignificantDigits: 8 } : { maximumFractionDigits: 0 }).format(value);
}
function status(value: TaskTodo['status']) {
  switch (value) {
    case 'pending': return t('待执行');
    case 'in_progress': return t('执行中');
    case 'completed': return t('已完成');
    case 'cancelled': return t('已取消');
    default: return t('未知状态');
  }
}

/** Read-only telemetry belongs to the actual local engine session, not a remote receipt. */
export function TaskTelemetryView({ task }: {
  task: Pick<Task, 'telemetry' | 'state' | 'runAfter' | 'sessionID'>;
}) {
  const telemetry = task.telemetry;
  if (!telemetry || telemetry.sessionID !== task.sessionID) return null;
  const usage = telemetry.usage;
  const current = telemetry.runAfter === task.runAfter &&
    ['running', 'waiting_approval', 'waiting_input', 'accepted', 'review'].includes(task.state);
  const todos = telemetry.todos;
  const available = current && todos.state === 'available';
  const completed = available ? todos.items.filter(item => item.status === 'completed').length : 0;
  return <details className="task-telemetry">
    <summary>
      <span>{available && todos.items.length ? t('用量与清单') : t('用量')}</span>
      {available && todos.items.length > 0 && <span className="task-telemetry-count">{t('已完成 {{done}} / {{total}} 项', { done: completed, total: todos.items.length })}</span>}
    </summary>
    <div className="task-telemetry-body">
      <section aria-label={t('引擎会话用量')}>
        <h4>{t('引擎会话用量')}</h4>
        {usage ? <>
          <dl className="task-telemetry-usage">
            <div><dt>{t('输入 Token')}</dt><dd>{number(usage.tokens.input)}</dd></div>
            <div><dt>{t('输出 Token')}</dt><dd>{number(usage.tokens.output)}</dd></div>
            <div><dt>{t('推理 Token')}</dt><dd>{number(usage.tokens.reasoning)}</dd></div>
            <div><dt>{t('缓存读取 Token')}</dt><dd>{number(usage.tokens.cacheRead)}</dd></div>
            <div><dt>{t('缓存写入 Token')}</dt><dd>{number(usage.tokens.cacheWrite)}</dd></div>
            <div><dt>{t('官方总 Token')}</dt><dd>{number(usage.tokens.total)}</dd></div>
            <div><dt>{t('官方费用读数')}</dt><dd>{number(usage.cost, true)}</dd></div>
          </dl>
          <p>{t('会话累计读数来自 {{count}} 条官方助手消息；未提供的数值不作估算。', { count: usage.assistantMessages })}</p>
          <p>{t('费用沿用引擎原始单位和估算，0 不表示免费，也不代表实际账单。')}</p>
        </> : <p>{t('官方引擎尚未返回用量。')}</p>}
      </section>
      <section aria-label={t('本轮执行清单')}>
        <h4>{t('本轮执行清单')}</h4>
        {available ? <>
          {todos.items.length ? <ol className="task-telemetry-todos">{todos.items.map((item, index) =>
            <li key={index} data-status={item.status}>
              <span className="task-telemetry-todo-status">{status(item.status)}</span>
              <span>{item.content}</span>
            </li>)}</ol> : <p>{t('本轮官方执行清单为空。')}</p>}
          {todos.truncated && <p>{t('执行清单过长，仅展示前 200 项，每项最多 4000 个字符。')}</p>}
        </> : <p>{!current || todos.state === 'inactive' ? t('执行已停止或中断，旧清单不作为当前进度。') :
          todos.state === 'unavailable' ? t('官方执行清单暂不可用，任务执行不受影响。') : t('本轮尚未提供官方执行清单。')}</p>}
      </section>
    </div>
  </details>;
}
