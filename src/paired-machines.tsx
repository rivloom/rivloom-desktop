import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Info, Pencil, Radio, Trash2, X } from 'lucide-react';
import { t, language } from '../shared/i18n.ts';
import type { RivloomNode } from '../shared/types';
import { NodeAvatar } from './node-avatar';
import { nodeDisplayName } from './node-mentions';
import { conversationState, type Conversation } from './conversations';
import { groupMachines, machineBytes, machineConversations, machineStatus } from './machine-status';

const reading = (value: number | null) => (value === null ? t('未知') : `${Math.round(value)}%`);

function MachineInfo({
  node,
  view,
  items,
}: {
  node: RivloomNode;
  view: ReturnType<typeof machineStatus>;
  items: readonly Conversation[];
}) {
  const hardware = node.worker?.hardware;
  const load = view.loadFresh ? node.worker?.load : null;
  const related = machineConversations(node.id, items);
  return (
    <>
      <p className="machine-info-status">
        {view.status}
        {view.health ? ` · ${view.health}` : ''}
      </p>
      <section>
        <h3>{t('任务队列')}</h3>
        <dl>
          <dt>{t('队列 / 提醒线')}</dt>
          <dd>
            {view.queueCount ?? '—'} / {view.queueThreshold}
          </dd>
          {view.concurrency ? <>
            <dt>{t('本机任务占用')}</dt>
            <dd>{t('{{count}} 项 · 不设固定上限', { count: view.concurrency.localOccupied })}</dd>
            <dt>{t('其他机器任务占用 / 上限')}</dt>
            <dd>{view.concurrency.remoteOccupied} / {view.concurrency.remoteLimit}</dd>
          </> : <>
            <dt>{t('执行占用 / 并发容量')}</dt>
            <dd>{view.occupied ?? '—'} / {view.total ?? '—'}</dd>
          </>}
          <dt>{t('执行中')}</dt>
          <dd>{view.executing ?? t('未知')}</dd>
          <dt>{t('等待')}</dt>
          <dd>{view.waiting ?? t('未知')}</dd>
        </dl>
        <p className="machine-info-note">
          {t('队列包含正在执行、等待和保留的任务。10 是提醒线，可在本机确认后继续提交。')}
        </p>
        {view.executing === null && (
          <p className="machine-info-note">{t('对端未提供有效的执行中统计。')}</p>
        )}
      </section>
      <section>
        <h3>
          {t('硬件负载')} <span>{reading(view.hardware)}</span>
        </h3>
        <dl>
          <dt>CPU</dt>
          <dd>{reading(view.cpu)}</dd>
          <dt>{t('内存')}</dt>
          <dd>{reading(view.memory)}</dd>
          <dt>GPU</dt>
          <dd>{reading(view.gpu)}</dd>
          <dt>{t('可用内存')}</dt>
          <dd>{machineBytes(load?.memoryAvailableBytes)}</dd>
          <dt>{t('可用显存')}</dt>
          <dd>{machineBytes(load?.gpuMemoryAvailableBytes)}</dd>
          <dt>{t('可用磁盘')}</dt>
          <dd>{machineBytes(load?.diskAvailableBytes)}</dd>
        </dl>
        <p className="machine-info-note">
          {t('图标取 CPU、内存、GPU 有效使用率中的最高值；未提供的指标不参与计算。')}
        </p>
        <p className="machine-info-note">
          {view.loadFresh
            ? t('采样时间：{{value1}}', {
                value1: new Date(node.worker!.load.sampledAt).toLocaleTimeString(language()),
              })
            : t('负载报告缺失或已过期')}
          {view.loadFresh && view.partial ? ` · ${t('部分指标未知')}` : ''}
        </p>
      </section>
      <section>
        <h3>{t('硬件信息')}</h3>
        {hardware ? (
          <>
            <dl>
              <dt>{t('系统')}</dt>
              <dd>
                {hardware.platform === 'win32' ? 'Windows' : hardware.platform} {hardware.release} ·{' '}
                {hardware.architecture}
              </dd>
              <dt>CPU</dt>
              <dd>{hardware.cpuModel}</dd>
              <dt>{t('核心 / 线程')}</dt>
              <dd>
                {hardware.physicalCores ?? '—'} / {hardware.logicalCores}
              </dd>
              <dt>{t('总内存')}</dt>
              <dd>{machineBytes(hardware.memoryBytes)}</dd>
              <dt>{t('磁盘容量')}</dt>
              <dd>{machineBytes(hardware.diskBytes)}</dd>
              <dt>GPU</dt>
              <dd>
                {hardware.gpus.length
                  ? hardware.gpus.map((gpu) => (
                      <div key={gpu.name}>
                        {gpu.name} · {machineBytes(gpu.memoryBytes)}
                      </div>
                    ))
                  : t('未提供 GPU 信息')}
              </dd>
            </dl>
            <p className="machine-info-note">
              {t('硬件报告：{{value1}}', {
                value1: new Date(hardware.collectedAt).toLocaleString(language()),
              })}
            </p>
          </>
        ) : (
          <p className="machine-info-note">{t('未提供硬件报告')}</p>
        )}
      </section>
      <section>
        <h3>
          {t('相关会话')} <span>{related.length}</span>
        </h3>
        <p className="machine-info-note">{t('仅列出当前可见、发往这台机器的未结束会话。')}</p>
        <ul className="machine-info-tasks">
          {related.slice(0, 3).map((item) => (
            <li key={item.key}>
              <span>{item.title}</span>
              <small>{conversationState(item)}</small>
            </li>
          ))}
        </ul>
      </section>
      <p className="machine-info-id">Node ID · {node.id}</p>
    </>
  );
}

function MachineRow({
  node,
  items,
  now,
  connected,
  owner,
  remark,
  remove,
  open,
  setOpen,
}: {
  node: RivloomNode;
  items: readonly Conversation[];
  now: number;
  connected: boolean;
  owner: boolean;
  remark: (id: string) => void;
  remove: (id: string) => void;
  open: boolean;
  setOpen: (value: boolean) => void;
}) {
  const view = machineStatus(node, now, connected);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const cancelClose = () => clearTimeout(timer.current);
  const show = () => {
    cancelClose();
    setOpen(true);
  };
  const leave = () => {
    cancelClose();
    timer.current = setTimeout(() => {
      if (
        button.current === document.activeElement ||
        panel.current?.contains(document.activeElement)
      )
        return;
      setOpen(false);
    }, 160);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = button.current?.getBoundingClientRect();
      const box = panel.current?.getBoundingClientRect();
      if (!anchor || !box) return;
      const left = anchor.left - box.width - 10;
      setPosition({
        left: Math.max(
          12,
          Math.min(left >= 12 ? left : anchor.right + 10, window.innerWidth - box.width - 12),
        ),
        top: Math.max(12, Math.min(anchor.top - 12, window.innerHeight - box.height - 12)),
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !button.current?.contains(event.target as Node) &&
        !panel.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (panel.current?.contains(document.activeElement)) button.current?.focus();
      setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', key, true);
    };
  }, [open]);
  const occupancy = `${view.queueCount ?? '—'}/${view.queueThreshold}`;
  return (
    <article
      className={`machine-card ${!node.online || !node.channelReady ? 'offline' : ''}`}
      data-node-id={node.id}
    >
      <div className="machine-heading">
        <NodeAvatar icon={node.icon} name={node.name} small />
        <strong title={nodeDisplayName(node)}>{nodeDisplayName(node)}</strong>
        {owner && (
          <button
            type="button"
            className="machine-remark-button"
            aria-label={t('编辑 {{value1}} 的备注名', { value1: node.name })}
            title={t('编辑本地备注名')}
            onClick={() => remark(node.id)}
          >
            <Pencil size={12} />
          </button>
        )}
        {owner && (
          <button
            type="button"
            className="machine-delete-button"
            aria-label={t('删除配对机器 {{value1}}', { value1: node.name })}
            title={t('删除配对机器')}
            onClick={() => remove(node.id)}
          >
            <Trash2 size={12} />
          </button>
        )}
        <button
          type="button"
          ref={button}
          className="machine-info-button"
          aria-label={t('{{value1}} 的机器详情', { value1: node.name })}
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onPointerEnter={(event) => {
            if (event.pointerType !== 'touch') show();
          }}
          onPointerLeave={leave}
          onFocus={show}
          onBlur={leave}
          onClick={() => {
            show();
            requestAnimationFrame(() => panel.current?.focus());
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              show();
              requestAnimationFrame(() => panel.current?.focus());
            }
          }}
        >
          <Info size={14} />
        </button>
      </div>
      <div className="machine-load">
        <span
          className={`machine-hardware-icon ${view.hardware === null ? 'unknown' : view.hardware >= 85 ? 'high' : ''}`}
          role="img"
          aria-label={t('硬件负载 {{value1}}', { value1: reading(view.hardware) })}
          title={t('硬件负载 {{value1}}', { value1: reading(view.hardware) })}
        >
          {[view.cpu, view.memory, view.gpu].map((value, index) => (
            <i
              key={index}
              className={value === null ? 'unknown' : ''}
              style={{ '--meter-height': `${value ?? 0}%` } as CSSProperties}
            >
              <b />
            </i>
          ))}
        </span>
        <div
          className={`machine-load-bar ${view.queueFill === null ? 'unknown' : ''} ${view.paused ? 'paused' : ''}`}
          role="progressbar"
          aria-label={t('任务容量')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={view.queueFill ?? undefined}
          aria-valuetext={`${view.label} · ${occupancy}`}
        >
          <i style={{ width: `${view.queueFill ?? 0}%` }} />
          <span className={view.executing && view.executing > 0 ? 'machine-running-label' : ''}>
            {t('队列')}
            {view.queueCount === null
              ? ` · ${view.status}`
              : view.executing !== null && view.executing > 0
                ? ` · ${view.label}`
                : view.paused
                  ? ` · ${t('已暂停')}`
                  : ''}
          </span>
          <b>{occupancy}</b>
        </div>
      </div>
      {open &&
        createPortal(
          <div
            id={id}
            ref={panel}
            role="dialog"
            tabIndex={-1}
            aria-label={t('{{value1}} 的机器详情', { value1: node.name })}
            className="machine-info-panel"
            style={position}
            onPointerEnter={cancelClose}
            onPointerLeave={leave}
            onFocus={cancelClose}
            onBlur={leave}
          >
            <header>
              <strong>{nodeDisplayName(node)}</strong>
              <button
                type="button"
                aria-label={t('关闭')}
                onClick={() => {
                  button.current?.focus();
                  setOpen(false);
                }}
              >
                <X size={15} />
              </button>
            </header>
            <MachineInfo node={node} view={view} items={items} />
          </div>,
          document.body,
        )}
    </article>
  );
}

export function PairedMachines({
  nodes,
  items,
  connected,
  owner,
  remark,
  remove,
}: {
  nodes: readonly RivloomNode[];
  items: readonly Conversation[];
  connected: boolean;
  owner: boolean;
  remark: (id: string) => void;
  remove: (id: string) => void;
}) {
  const [now, setNow] = useState(Date.now);
  const [infoID, setInfoID] = useState<string | null>(null);
  const [offlineOpen, setOfflineOpen] = useState(false);
  // One low-frequency clock for the whole list: expired data becomes unknown even
  // while the app receives no new bootstrap snapshot. No polling or per-row timers.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const groups = groupMachines(nodes);
  const observedAt = Math.max(now, Date.now());
  useEffect(() => {
    if (
      infoID &&
      !nodes.some(
        (node) => node.id === infoID && (offlineOpen || (node.online && node.channelReady)),
      )
    )
      setInfoID(null);
  }, [nodes, offlineOpen, infoID]);
  const rows = (peers: readonly RivloomNode[]) =>
    peers.map((node) => (
      <MachineRow
        key={node.id}
        node={node}
        items={items}
        now={observedAt}
        connected={connected}
        owner={owner}
        remark={remark}
        remove={remove}
        open={infoID === node.id}
        setOpen={(value) =>
          setInfoID((current) => (value ? node.id : current === node.id ? null : current))
        }
      />
    ));
  return (
    <section className="paired-machines">
      <div className="rail-heading">
        <Radio size={17} />
        <h2>{t('已配对机器')}</h2>
        <span>{nodes.length}</span>
      </div>
      <div className="machine-group connected">
        <div className="machine-group-heading">
          <i className={`status-dot ${connected ? 'online' : ''}`} />
          <h3>{connected ? t('已连接') : t('状态待确认')}</h3>
          <span>{groups.connected.length}</span>
        </div>
        <div className="machine-list">{rows(groups.connected)}</div>
        {!groups.connected.length && <p className="machine-group-empty">{t('暂无已连接机器')}</p>}
      </div>
      <details
        className="machine-group offline"
        onToggle={(event) => setOfflineOpen(event.currentTarget.open)}
      >
        <summary className="machine-group-heading">
          <ChevronRight size={12} />
          <span>{t('离线')}</span>
          <b>{groups.offline.length}</b>
        </summary>
        <div className="machine-list">{offlineOpen && rows(groups.offline)}</div>
        {!groups.offline.length && <p className="machine-group-empty">{t('暂无离线机器')}</p>}
      </details>
    </section>
  );
}
