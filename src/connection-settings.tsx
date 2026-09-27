import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronDown, CircleDot, Plus, Plug, Server, Settings2 } from 'lucide-react';
import { Modal } from './ui';
import { useUnsavedActionGuard } from './unsaved-changes-confirm';
import { api } from './api';
import { t, systemText } from '../shared/i18n';
import { customProviderSchema, type CustomProvider, type ProviderAccess } from '../shared/model-providers';
import type { ModelSettings } from '../shared/types';
import './connection-settings.css';
const fresh = (): CustomProvider => ({ id: `connection-${crypto.randomUUID().slice(0, 12)}`, name: '', baseURL: '', protocol: 'chat', models: [], context: 32768, output: 4096, keyless: false });
export function ConnectionSettings({ onboarding = false, close, changed, advanced }: { onboarding?: boolean; close: () => void; changed: (model?: string) => void; advanced: () => void }) {
  const [settings, setSettings] = useState<ModelSettings | null>(null), [providers, setProviders] = useState<ProviderAccess[]>([]);
  const [draft, setDraft] = useState<CustomProvider | null>(null), [modelLines, setModelLines] = useState(''), [key, setKey] = useState('');
  const [existing, setExisting] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [selected, setSelected] = useState(''), [testConfirmed, setTestConfirmed] = useState(false), [dirty, setDirty] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { scrollRef.current?.scrollTo(0, 0); }, [draft?.id, error, notice]);
  async function load() {
    const [next, catalog] = await Promise.all([api<ModelSettings>('/model-settings'), api<ProviderAccess[]>('/model-settings/providers')]);
    setSettings(next); setProviders(catalog); setSelected(value => value && next.models.some(model => model.id === value) ? value : next.defaultModel);
    return { next, catalog };
  }
  useEffect(() => { let alive = true; void load().then(({ catalog }) => { if (alive && onboarding && !catalog.some(value => value.connected || value.custom || value.account)) setDraft(fresh()); })
    .catch(error => { if (alive) setError(systemText(error.message)); }); return () => { alive = false; }; }, []);
  const testing = Object.values(settings?.checks || {}).some(value => value.status === 'testing');
  useEffect(() => { if (!testing) return; const timer = setInterval(() => void load().catch(() => {}), 1200); return () => clearInterval(timer); }, [testing]);
  const locked = busy || !!settings?.busy;
  const { request: guardUnsaved, confirmation } = useUnsavedActionGuard(dirty, busy);
  const dismiss = () => guardUnsaved(close);
  const patch = (value: Partial<CustomProvider>) => { setDraft(current => current ? { ...current, ...value } : current); setDirty(true); };
  async function perform(action: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); setNotice(''); try { await action(); } catch (error) { setError(systemText((error as Error).message)); } finally { setBusy(false); } }
  function edit(provider?: CustomProvider) {
    guardUnsaved(() => {
      setDraft(provider ? structuredClone(provider) : fresh()); setExisting(!!provider); setKey(''); setDirty(false);
      setModelLines(provider?.models.map(model => `${model.id}${model.name !== model.id ? ` | ${model.name}` : ''}`).join('\n') || ''); setError(''); setNotice('');
    });
  }
  const save = (use: boolean) => perform(async () => {
    if (!draft) return;
    const models = modelLines.split(/\r?\n/).filter(line => line.trim()).map(line => { const [id, name] = line.split('|').map(value => value.trim()); return { id, name: name || id }; });
    const checked = customProviderSchema.safeParse({ ...draft, models });
    if (!checked.success) throw new Error(t('请检查连接名称、完整 API 地址、模型 ID 和容量设置。'));
    if (!existing && !draft.keyless && !key.trim()) throw new Error(t('请填写 API Key，或选择免认证。'));
    await api('/model-settings/provider/custom', { provider: checked.data, shared: true, ...(key.trim() && !draft.keyless ? { key: key.trim() } : {}) });
    setExisting(true); setDirty(false); setKey(''); setDraft(checked.data);
    const model = `${checked.data.id}/${checked.data.models[0].id}`;
    if (use) await api('/model-settings/default', { model });
    await load(); if (use) setSelected(model); changed(use ? model : undefined);
    setNotice(use ? t('连接已保存并设为新任务的默认模型。') : t('连接已保存。保存配置不会发送模型请求。'));
  });
  const select = () => perform(async () => { await api('/model-settings/default', { model: selected }); await load(); changed(selected); setNotice(t('已切换默认连接，正在执行的任务保持原模型。')); });
  const connected = providers.filter(provider => provider.connected || provider.custom || provider.account);
  const selectedAvailable = !!settings?.models.some(model => model.id === selected);
  const selectedProvider = connected.find(provider => selected.startsWith(`${provider.id}/`));
  const overview = () => guardUnsaved(() => {
    setDraft(null); setDirty(false); setKey(''); setError(''); setNotice('');
  });
  const moreSettings = () => guardUnsaved(advanced);
  return <><Modal title={onboarding ? t('连接你的模型') : t('模型连接')} subtitle={t('保存不同办公环境的模型服务，需要时随时切换。')} close={dismiss} className="connection-settings-modal">
    <div className="connection-layout">
      <aside className="connection-sidebar" aria-label={t('已保存的连接')}>
        <button className={`connection-overview ${!draft ? 'selected' : ''}`} aria-current={!draft ? 'page' : undefined} disabled={busy} onClick={overview}><CircleDot size={17} /><span>{t('当前使用')}</span></button>
        <div className="connection-list-heading"><h3>{t('已保存的连接')}</h3><span>{connected.length}</span></div>
        <div className="connection-saved">
          {connected.map(provider => <button className={`connection-item ${draft?.id === provider.id ? 'selected' : ''}`} aria-current={draft?.id === provider.id ? 'page' : undefined} key={provider.id} disabled={busy} onClick={() => provider.custom ? edit(provider.custom) : moreSettings()}>
            <Server size={16} /><span><strong>{provider.name}{provider.accountName ? ` · ${provider.accountName}` : ''}</strong><small title={provider.custom?.baseURL}>{provider.custom ? new URL(provider.custom.baseURL).host : t('厂商账号')}</small></span>
            {settings?.defaultModel.startsWith(`${provider.id}/`) && <span className="connection-default-tag">{t('默认')}</span>}
          </button>)}
          {!connected.length && settings && <p className="connection-list-empty">{t('为不同办公环境保存连接，切换时无需重复填写。')}</p>}
        </div>
        <button className={`connection-add ${draft && !existing ? 'selected' : ''}`} disabled={locked || !settings} onClick={() => edit()}><Plus size={17} /><span>{t('添加连接')}</span></button>
        <button className="connection-more" disabled={busy} onClick={moreSettings}><Settings2 size={16} /><span>{t('厂商账号与更多设置')}</span><ArrowUpRight size={13} /></button>
      </aside>
      <div className="connection-content">
        <div className="connection-scroll" ref={scrollRef}>
          {error && <p className="connection-error" role="alert">{error}{!settings && <button className="button" disabled={busy} onClick={() => void perform(async () => { await load(); })}>{t('重试')}</button>}</p>}
          {notice && <p className="connection-notice" role="status"><Check size={15} />{notice}</p>}
          {!settings && !error && <div className="connection-loading" role="status"><span /><span /><span /><p>{t('正在读取…')}</p></div>}
          {settings && <>
            {settings.busy && <p className="connection-hint">{t('任务或模型操作进行中，完成后可修改连接；默认模型仍可单独选择。')}</p>}
            {draft ? <section className="connection-form" aria-label={existing ? t('修改连接') : t('添加连接')}>
              <header className="connection-section-heading"><h3>{existing ? t('修改连接') : t('添加连接')}</h3><p>{t('填写模型服务提供的地址、凭据和模型名称。')}</p></header>
              <label className="field"><span>{t('配置名称')}</span><input value={draft.name} maxLength={80} placeholder={t('例如：公司内网、家中、客户 A')} disabled={locked} onChange={event => patch({ name: event.target.value })} /></label>
              <label className="field"><span>{t('模型服务地址')}</span><input value={draft.baseURL} spellCheck={false} placeholder="http://192.168.1.20:8000/v1" disabled={locked} onChange={event => patch({ baseURL: event.target.value })} /></label>
              <label className="field"><span>{t('模型 ID')}</span><textarea value={modelLines} spellCheck={false} rows={2} placeholder={t('每行一个模型 ID，可写 ID | 显示名称')} disabled={locked} onChange={event => { setModelLines(event.target.value); setDirty(true); }} /></label>
              <label className="field connection-key"><span>API Key</span><input type="password" autoComplete="new-password" value={key} disabled={locked || draft.keyless} placeholder={existing ? t('已保存的密钥不会显示；留空保留') : t('填写服务提供的 API Key')} onChange={event => { setKey(event.target.value); setDirty(true); }} /></label>
              <label className="checkbox"><input type="checkbox" checked={draft.keyless} disabled={locked} onChange={event => patch({ keyless: event.target.checked })} />{t('此服务不需要 API Key')}</label>
              <details className="connection-advanced"><summary><Settings2 size={15} /><span>{t('高级设置')}</span><ChevronDown size={15} /></summary><div className="connection-advanced-fields"><label className="field"><span>{t('接口协议')}</span><select value={draft.protocol} disabled={locked} onChange={event => patch({ protocol: event.target.value as 'chat' | 'responses' })}><option value="chat">Chat Completions</option><option value="responses">Responses</option></select></label>
                <div className="connection-limits"><label className="field"><span>{t('上下文容量')}</span><input type="number" min={2048} max={2000000} value={draft.context} disabled={locked} onChange={event => patch({ context: Number(event.target.value) })} /></label><label className="field"><span>{t('最大输出')}</span><input type="number" min={256} max={200000} value={draft.output} disabled={locked} onChange={event => patch({ output: Number(event.target.value) })} /></label></div></div></details>
            </section> : <section className="connection-current">
              <header className="connection-section-heading"><h3>{t('当前使用')}</h3><p>{t('用于新任务，正在执行的任务保持原模型。')}</p></header>
              <label className="field"><span>{t('当前默认连接与模型')}</span><select value={selected} disabled={busy} onChange={event => { setSelected(event.target.value); setTestConfirmed(false); setNotice(''); }}>
                {!selectedAvailable && <option value={selected}>{selected ? `${selected} · ${t('当前不可用')}` : t('尚未连接模型')}</option>}{settings.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
              </select></label>
              {selectedProvider && <dl className="connection-details"><div><dt>{t('模型服务地址')}</dt><dd>{selectedProvider.custom?.baseURL || t('厂商账号')}</dd></div>{selectedProvider.custom && <><div><dt>{t('接口协议')}</dt><dd>{selectedProvider.custom.protocol === 'responses' ? 'Responses' : 'Chat Completions'}</dd></div><div><dt>{t('认证方式')}</dt><dd>{selectedProvider.custom.keyless ? t('免认证') : 'API Key'}</dd></div></>}</dl>}
              {!connected.length && <div className="connection-empty"><span className="connection-empty-icon"><Plug size={24} strokeWidth={1.6} /></span><h4>{t('添加你的第一个连接')}</h4><p>{t('支持公网或内网模型服务。保存后可在这里切换。')}</p><button className="button" disabled={locked} onClick={() => edit()}><Plus size={15} />{t('添加连接')}</button></div>}
              <details className="connection-test-panel"><summary><Plug size={15} /><span>{t('测试连接')}</span><ChevronDown size={15} /></summary><div className="connection-test-content"><p>{t('测试会向已保存并选中的模型发送一次最小请求，不运行办公任务。')}</p>
                <label className="checkbox"><input type="checkbox" checked={testConfirmed} onChange={event => setTestConfirmed(event.target.checked)} />{t('我同意发送这次测试请求')}</label>
                <div className="connection-test-actions"><button className="button" disabled={locked || !selectedAvailable || !testConfirmed || testing} onClick={() => { setTestConfirmed(false); void perform(async () => { await api('/model-settings/test', { model: selected, confirmed: true }); await load(); }); }}>{t('测试所选连接')}</button>
                  {testing && <button className="button" disabled={busy} onClick={() => void perform(async () => { await api('/model-settings/test/stop', {}); await load(); })}>{t('停止测试')}</button>}</div>
                {settings.checks[selected] && <p role="status">{systemText(settings.checks[selected].message)}</p>}
              </div></details>
              <p className="connection-scope-note">{t('连接不可达时会提示检查，不会自动切换到其他服务。')}</p>
            </section>}
          </>}
        </div>
        <footer className="connection-footer">
          {onboarding ? <button className="connection-later" disabled={busy} onClick={dismiss}>{t('稍后配置')}</button> : <span className="connection-footer-note">{draft ? t('保存配置不会发送模型请求。') : t('可随时从侧栏重新打开。')}</span>}
          <div className="connection-actions">{draft && settings ? <><button className="button" disabled={locked} onClick={() => void save(false)}>{t('保存配置')}</button><button className="button primary" disabled={locked} onClick={() => void save(true)}>{t('保存并使用')}</button></> : <>
            {settings && selected !== settings.defaultModel && <button className="button primary" disabled={busy || !selectedAvailable} onClick={() => void select()}>{t('使用此连接')}</button>}
            <button className="button" disabled={busy} onClick={dismiss}>{t('完成')}</button>
          </>}</div>
        </footer>
      </div>
    </div>
  </Modal>{confirmation}</>;
}
