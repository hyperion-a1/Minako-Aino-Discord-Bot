import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DiscordSDK } from '@discord/embedded-app-sdk';
import WebApp from './WebApp.jsx';
import AudioControls from './audio/AudioControls.jsx';

const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID;
const demoData = {
  mode: 'preview',
  availableNow: null,
  openGroups: [],
  freeSlots: null,
  pendingProposals: null,
  matchesToday: null,
  weekly: null,
  recent: [],
};

function Icon({ name, size = 20 }) {
  const paths = {
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M20 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>,
    groups: <><path d="M16 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="10" cy="7" r="4"/><path d="M20 8v6M23 11h-6"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    trophy: <><path d="M8 21h8m-4-4v4M7 4h10v5a5 5 0 0 1-10 0V4Z"/><path d="M7 6H4v2a4 4 0 0 0 4 4m9-6h3v2a4 4 0 0 1-4 4"/></>,
    gamepad: <><path d="M6 12h4m-2-2v4m7-1h.01M18 10h.01"/><path d="M6.5 6h11a4.5 4.5 0 0 1 4.4 5.4l-1 4.4a3 3 0 0 1-5 1.5l-1.5-1.3h-4.8l-1.5 1.3a3 3 0 0 1-5-1.5l-1-4.4A4.5 4.5 0 0 1 6.5 6Z"/></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2"/></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6"/></>,
    shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.gamepad}</svg>;
}

function formatRelative(timestamp) {
  if (!timestamp) return 'recentemente';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'agora há pouco';
  if (seconds < 3600) return `há ${Math.round(seconds / 60)} min`;
  if (seconds < 86400) return `há ${Math.round(seconds / 3600)} h`;
  return `há ${Math.round(seconds / 86400)} d`;
}

const dashboardSections = [
  { id: 'overview', label: 'Visão geral', icon: '✦', desc: 'Resumo das configurações' },
  { id: 'week', label: 'Semana e ciclo', icon: '📅', desc: 'Virada semanal e horário' },
  { id: 'channels', label: 'Canais gerais', icon: '💬', desc: 'Moderação e publicações' },
  { id: 'night', label: 'Modo Noturno', icon: '🌙', desc: 'Horários e canais afetados' },
  { id: 'seasonal', label: 'Personalidade sazonal', icon: '✨', desc: 'Pacotes de falas' },
  { id: 'roles', label: 'Cargos e permissões', icon: '🛡️', desc: 'Equipe e administração' },
  { id: 'matchmaking', label: 'Matchmaking', icon: '🎮', desc: 'Central, grupos e prazos' },
  { id: 'giveaways', label: 'Sorteios', icon: '🎁', desc: 'Regras e anúncio do sorteio' },
];

const initialDashboardConfig = {
  weekStartDay: 'monday', weekStartTime: '00:00', moderationChannel: '', publicationChannel: '',
  nightEnabled: false, nightStart: '01:00', nightEnd: '05:00', timezone: 'America/Sao_Paulo',
  nightCategories: '', nightAffectedChannels: '', nightImmuneChannels: '', nightNoticeChannels: '', nightNoticeUrl: '',
  seasonal: { halloween: false, christmas: false, newYear: false }, starRole: '', matchAdminRoles: '',
  matchmakingEnabled: true, matchModes: 'Clássico, Ranqueada, Casual', groupCapacity: 5, proposalMinutes: 10,
  reviewMatches: true, centralChannel: '',
  giveawayName: 'Sorteio de exemplo', giveawayMin: 2, giveawayMax: 100, giveawayWinners: 1,
  giveawayDuration: '24h', giveawayEndDate: '', giveawayStart: 'immediate', giveawayScheduledAt: '',
  giveawayChannel: '', giveawayAllowedRoles: '', giveawayBlockedRoles: '', giveawayAllowedMembers: '', giveawayBlockedMembers: '',
  giveawayCooldownType: 'none', giveawayCooldownAmount: 1, giveawayCooldownUnit: 'giveaways',
  giveawayPin: false, giveawayPrivateThread: false, giveawayPrivateMessage: 'Parabéns! Este é o espaço privado para combinar os próximos passos com quem organizou o sorteio.',
  giveawayMessage: '## 🎁 Sorteio especial da comunidade\nParticipe e boa sorte!', giveawayTemplateName: '',
  giveawayRulesScope: 'local', giveawayColor: '#f6bd4b', giveawayMinRole: '', giveawayMaxRole: '',
};


function PickField({ label, hint, value, onChange, options, multi = false, placeholder = 'Selecionar…' }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef(null);
  const selected = useMemo(() => String(value || '').split(',').map((x) => x.trim()).filter(Boolean), [value]);
  const byId = useMemo(() => new Map(options.map((o) => [o.id, o])), [options]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const toggle = (id) => {
    if (!multi) { onChange(selected[0] === id ? '' : id); setOpen(false); return; }
    onChange((selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]).join(', '));
  };
  const shown = options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase()));
  return <div className="dash-field pick" ref={ref}>
    <span className="dash-field-label">{label}</span>
    <div className="pick-box">
      {selected.map((id) => <span className="pick-chip" key={id} style={byId.get(id)?.color ? { borderColor: byId.get(id).color } : undefined}>
        {byId.get(id)?.label || `Item removido (${id})`}
        <button type="button" aria-label="Remover" onClick={() => toggle(id)}>×</button>
      </span>)}
      <button type="button" className="pick-open" onClick={() => { setOpen((v) => !v); setQ(''); }}>{selected.length ? (multi ? '＋ Adicionar' : 'Trocar') : placeholder}</button>
    </div>
    {open && <div className="pick-menu">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar…" />
      <div className="pick-list">
        {shown.length === 0 && <small className="pick-empty">Nada encontrado.</small>}
        {shown.map((o) => <button type="button" key={o.id} className={`pick-opt ${selected.includes(o.id) ? 'on' : ''}`} onClick={() => toggle(o.id)}>
          {o.color && <i style={{ background: o.color }} />}<span>{o.label}</span>{o.sub && <small>{o.sub}</small>}{selected.includes(o.id) && <b>✓</b>}
        </button>)}
      </div>
    </div>}
    {hint && <small>{hint}</small>}
  </div>;
}


function MemberField({ label, hint, value, onChange, apiFetch, guildId }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [names, setNames] = useState({});
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  const selected = useMemo(() => String(value || '').split(',').map((x) => x.trim()).filter(Boolean), [value]);
  const base = `/api/dashboard/members?guildId=${encodeURIComponent(guildId)}`;
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  useEffect(() => {
    const missing = selected.filter((id) => !names[id]);
    if (!missing.length) return undefined;
    let cancelled = false;
    apiFetch(`${base}&ids=${missing.join(',')}`).then((d) => {
      if (cancelled) return;
      setNames((prev) => { const next = { ...prev }; missing.forEach((id) => { next[id] = 'Membro fora do servidor'; }); d.members.forEach((m) => { next[m.id] = m.name; }); return next; });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [selected, names, apiFetch, base]);
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return undefined; }
    let cancelled = false;
    const timer = setTimeout(() => {
      setBusy(true);
      apiFetch(`${base}&q=${encodeURIComponent(q.trim())}`).then((d) => { if (!cancelled) setResults(d.members); }).catch(() => { if (!cancelled) setResults([]); }).finally(() => { if (!cancelled) setBusy(false); });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [q, apiFetch, base]);
  const toggle = (m) => {
    if (m.name) setNames((prev) => ({ ...prev, [m.id]: m.name }));
    const id = m.id;
    onChange((selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]).join(', '));
  };
  return <div className="dash-field pick" ref={ref}>
    <span className="dash-field-label">{label}</span>
    <div className="pick-box">
      {selected.map((id) => <span className="pick-chip" key={id}>{names[id] || '…'}<button type="button" aria-label="Remover" onClick={() => toggle({ id })}>×</button></span>)}
      <button type="button" className="pick-open" onClick={() => { setOpen((v) => !v); setQ(''); }}>{selected.length ? '＋ Adicionar' : 'Buscar por nome…'}</button>
    </div>
    {open && <div className="pick-menu">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Digite ao menos 2 letras do nome ou apelido" />
      <div className="pick-list">
        {busy && <small className="pick-empty">Buscando…</small>}
        {!busy && q.trim().length >= 2 && results.length === 0 && <small className="pick-empty">Nenhum membro encontrado.</small>}
        {results.map((m) => <button type="button" key={m.id} className={`pick-opt ${selected.includes(m.id) ? 'on' : ''}`} onClick={() => toggle(m)}>
          <span>{m.name}</span><small>@{m.username}</small>{selected.includes(m.id) && <b>✓</b>}
        </button>)}
      </div>
    </div>}
    {hint && <small>{hint}</small>}
  </div>;
}


const GIVEAWAY_STATUS = { scheduled: 'Agendado', starting: 'Publicando…', active: 'Ativo', drawn: 'Aguardando conclusão' };
function GiveawayLive({ apiFetch, guildId, config, setNotice }) {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => apiFetch(`/api/dashboard/giveaways?guildId=${encodeURIComponent(guildId)}`).then((d) => setList(Array.isArray(d?.giveaways) ? d.giveaways : [])).catch(() => setList([])), [apiFetch, guildId]);
  useEffect(() => { load(); }, [load]);
  const publish = async () => {
    setBusy(true);
    try {
      const d = await apiFetch('/api/dashboard/giveaways', { method: 'POST', body: JSON.stringify({ guildId, config }) });
      setNotice(`✅ ${d.message}`);
      await load();
    } catch (e) { setNotice(`Falha ao criar o sorteio: ${e.message}`); } finally { setBusy(false); }
  };
  const cancel = async (id) => {
    try { await apiFetch(`/api/dashboard/giveaways/${id}/cancel`, { method: 'POST', body: JSON.stringify({ guildId }) }); setNotice('✅ Sorteio agendado cancelado.'); await load(); }
    catch (e) { setNotice(`Falha ao cancelar: ${e.message}`); }
  };
  const scheduled = config.giveawayStart === 'scheduled';
  return <div className="dash-info-card giveaway-live">
    <strong>Publicar pelo bot</strong>
    <p>Usa a configuração acima e as mesmas regras do /sorteios. O bot publica a mensagem no canal escolhido e cuida do sorteio e do anúncio dos ganhadores.</p>
    <button type="button" className="primary-button" disabled={busy} onClick={publish}>{busy ? 'Enviando…' : scheduled ? '📅 Agendar sorteio' : '🎁 Criar sorteio agora'}</button>
    <h4>Sorteios em andamento</h4>
    {list === null ? <small>Carregando…</small> : list.length === 0 ? <small>Nenhum sorteio ativo ou agendado neste servidor.</small> : <ul className="giveaway-list">
      {list.map((g) => <li key={g.id}><span><strong>{g.name}</strong><small>{GIVEAWAY_STATUS[g.status] || g.status}{g.startsAt && g.status === 'scheduled' ? ` · ${new Date(g.startsAt).toLocaleString('pt-BR')}` : ''}{g.endsAt && g.status !== 'scheduled' ? ` · termina ${new Date(g.endsAt).toLocaleString('pt-BR')}` : ''}</small></span>
        {g.status === 'scheduled' && <button type="button" className="pick-open" onClick={() => cancel(g.id)}>Cancelar</button>}</li>)}
    </ul>}
    <button type="button" className="pick-open" onClick={load}>Atualizar lista</button>
  </div>;
}


class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error('[Minako] Erro de renderização:', error); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="dash-info-card"><strong>Algo deu errado nesta tela</strong><p>{String(this.state.error?.message || this.state.error)}</p>
      <button type="button" className="primary-button" onClick={() => this.setState({ error: null })}>Tentar de novo</button></div>;
  }
}

function Field({ label, hint, children }) {
  return <label className="dash-field"><span className="dash-field-label">{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
function TextField({ label, value, onChange, placeholder, hint, type = 'text', min, max }) {
  return <Field label={label} hint={hint}><input type={type} value={value ?? ''} min={min} max={max} placeholder={placeholder || ''} onChange={(e) => onChange(e.target.value)} /></Field>;
}
function SelectField({ label, value, onChange, options, hint }) {
  return <Field label={label} hint={hint}><select value={value} onChange={(e) => onChange(e.target.value)}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>;
}
function ToggleField({ label, checked, onChange, hint }) {
  return <label className="dash-toggle"><span><strong>{label}</strong>{hint && <small>{hint}</small>}</span><input type="checkbox" checked={Boolean(checked)} onChange={(e) => onChange(e.target.checked)} /><i /></label>;
}

export function AdminDashboard(props) {
  return <ErrorBoundary key={props.guildId}><AdminDashboardInner {...props} /></ErrorBoundary>;
}

function AdminDashboardInner({ accessToken, guildId, csrf }) {
  const [guildData, setGuildData] = useState(null);
  const [guildDataError, setGuildDataError] = useState('');
  const [guildTick, setGuildTick] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [configTick, setConfigTick] = useState(0);
  const [health, setHealth] = useState(null);
  const [section, setSection] = useState('overview');
  const [config, setConfig] = useState(initialDashboardConfig);
  const [notice, setNotice] = useState('');
  const [templates, setTemplates] = useState([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [apiReady, setApiReady] = useState(false);
  const apiFetch = useCallback(async (url, options = {}) => {
    const viaSession = accessToken === 'cookie';
    const response = await fetch(url, {
      ...options,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(viaSession ? { 'x-csrf-token': csrf || '' } : { Authorization: `Bearer ${accessToken}` }), ...(options.headers || {}) },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.error || 'A operação não foi concluída.');
    if (payload === null) throw new Error('Resposta inesperada do servidor. Reinicie o servidor para aplicar a atualização.');
    return payload;
  }, [accessToken, csrf]);
  useEffect(() => {
    if (!accessToken || !guildId) return undefined;
    let cancelled = false;
    setGuildDataError('');
    apiFetch(`/api/dashboard/guild-data?guildId=${encodeURIComponent(guildId)}`)
      .then((d) => {
        if (cancelled) return;
        if (!Array.isArray(d?.channels) || !Array.isArray(d?.roles)) throw new Error('Resposta inesperada do servidor.');
        setGuildData(d);
      })
      .catch((e) => { if (!cancelled) { setGuildData(null); setGuildDataError(e.message || 'Falha ao carregar canais e cargos.'); } });
    return () => { cancelled = true; };
  }, [accessToken, guildId, apiFetch, guildTick]);

  useEffect(() => {
    if (!accessToken || !guildId) return;
    let cancelled = false;
    setLoadingConfig(true);
    setLoadError('');
    apiFetch(`/api/dashboard?guildId=${encodeURIComponent(guildId)}`)
      .then((payload) => {
        if (cancelled) return;
        setConfig((old) => ({ ...old, ...(payload.config || {}) }));
        setTemplates(Array.isArray(payload.templates) ? payload.templates : []);
        setApiReady(true);
        setNotice('Configurações reais carregadas do PostgreSQL.');
      })
      .catch((error) => { if (!cancelled) { setApiReady(false); setLoadError(error.message); setNotice(error.message); fetch('/api/health').then((r) => r.json()).then(setHealth).catch(() => {}); } })
      .finally(() => { if (!cancelled) setLoadingConfig(false); });
    return () => { cancelled = true; };
  }, [accessToken, guildId, apiFetch, configTick]);
  const update = (key, value) => { setConfig((old) => ({ ...old, [key]: value })); setNotice(''); };
  const updateSeasonal = (key, value) => { setConfig((old) => ({ ...old, seasonal: { ...old.seasonal, [key]: value } })); setNotice(''); };
  const saveDraft = async () => {
    if (!accessToken || !guildId) { setNotice('Conecte-se ao Discord e abra a Activity dentro do servidor para salvar.'); return; }
    setSavingConfig(true); setNotice('Salvando no PostgreSQL…');
    try {
      const payload = await apiFetch('/api/dashboard', { method: 'PUT', body: JSON.stringify({ guildId, config }) });
      setConfig((old) => ({ ...old, ...(payload.config || {}) }));
      setApiReady(true);
      setNotice('Configurações salvas no PostgreSQL. As opções mapeadas para os módulos existentes já foram atualizadas.');
    } catch (error) { setNotice(error.message); }
    finally { setSavingConfig(false); }
  };
  const saveTemplate = async () => {
    const name = config.giveawayTemplateName.trim();
    if (!name) { setNotice('Dê um nome ao template antes de salvá-lo.'); return; }
    if (!accessToken || !guildId) { setNotice('Conecte-se ao Discord dentro do servidor para salvar templates.'); return; }
    try {
      const payload = await apiFetch('/api/dashboard/templates', { method: 'POST', body: JSON.stringify({ guildId, name, config }) });
      setTemplates(Array.isArray(payload.templates) ? payload.templates : []);
      setNotice(`Template “${name}” salvo no PostgreSQL deste servidor.`);
    } catch (error) { setNotice(error.message); }
  };
  const loadTemplate = async (id) => {
    setSelectedTemplateId(id);
    if (!id) return;
    try {
      const payload = await apiFetch(`/api/dashboard/templates/${encodeURIComponent(id)}?guildId=${encodeURIComponent(guildId)}`);
      setConfig((old) => ({ ...old, ...(payload.config || {}), giveawayTemplateName: payload.template?.name || old.giveawayTemplateName }));
      setNotice(`Template “${payload.template?.name || 'selecionado'}” carregado do PostgreSQL.`);
    } catch (error) { setNotice(error.message); }
  };
  const deleteTemplate = async () => {
    if (!selectedTemplateId) { setNotice('Selecione um template para excluir.'); return; }
    try {
      const payload = await apiFetch(`/api/dashboard/templates/${encodeURIComponent(selectedTemplateId)}?guildId=${encodeURIComponent(guildId)}`, { method: 'DELETE' });
      setTemplates(Array.isArray(payload.templates) ? payload.templates : []);
      setSelectedTemplateId('');
      setNotice('Template excluído do PostgreSQL.');
    } catch (error) { setNotice(error.message); }
  };
  const active = dashboardSections.find((x) => x.id === section) || dashboardSections[0];
  const set = (key) => (value) => update(key, value);
  const field = (key, label, placeholder, hint, type = 'text', min, max) => <TextField key={key} label={label} value={config[key]} onChange={set(key)} placeholder={placeholder} hint={hint} type={type} min={min} max={max} />;
  const select = (key, label, options, hint) => <SelectField key={key} label={label} value={config[key]} onChange={set(key)} options={options} hint={hint} />;
  const toggle = (key, label, hint) => <ToggleField key={key} label={label} checked={config[key]} onChange={set(key)} hint={hint} />;
  const optionsFor = (kind) => {
    if (!guildData) return [];
    if (kind === 'role') return guildData.roles.map((r) => ({ id: r.id, label: `@${r.name}`, color: r.color, sub: r.managed ? 'integração' : '' }));
    const cats = new Map(guildData.channels.filter((c) => c.type === 4).map((c) => [c.id, c.name]));
    const icon = { 0: '#', 2: '🔊 ', 4: '📁 ', 5: '📢 ', 13: '🎙️ ', 15: '💬 ' };
    const allowed = kind === 'category' ? [4] : kind === 'sendable' ? [0, 5] : kind === 'text' ? [0, 5, 15] : [0, 2, 5, 13, 15];
    const names = new Map(guildData.channels.map((c) => [c.id, c.name]));
    const channels = guildData.channels.filter((c) => allowed.includes(c.type)).map((c) => ({ id: c.id, label: `${icon[c.type]}${c.name}`, sub: cats.get(c.parentId) || '' }));
    const threads = kind === 'category' ? [] : (guildData.threads || []).map((t) => ({ id: t.id, label: `🧵 ${t.name}`, sub: `tópico em #${names.get(t.parentId) || '?'}` }));
    return [...channels, ...threads];
  };
  const pick = (key, label, kind, multi, hint) => guildData
    ? <PickField key={key} label={label} hint={hint} multi={multi} value={config[key]} onChange={set(key)} options={optionsFor(kind)} placeholder={multi ? 'Selecionar vários…' : 'Selecionar…'} />
    : field(key, `${label} (ID)`, 'ID numérico', hint || 'Seletores indisponíveis: informe o ID do Discord.');
  const member = (key, label, hint) => guildData
    ? <MemberField key={key} label={label} hint={hint} value={config[key]} onChange={set(key)} apiFetch={apiFetch} guildId={guildId} />
    : field(key, `${label} (ID)`, 'IDs separados por vírgula', hint);
  const saveBar = <div className="dash-savebar"><div><strong>{savingConfig ? 'Salvando…' : 'Configurações do servidor'}</strong><small>{loadingConfig ? 'Carregando dados do PostgreSQL…' : apiReady ? 'Salvar grava as alterações no PostgreSQL.' : 'Conecte-se com uma conta administradora do servidor para carregar e salvar.'}</small></div><button className="primary-button" onClick={saveDraft} disabled={savingConfig || loadingConfig || !accessToken || !guildId}>{savingConfig ? 'Salvando…' : 'Salvar alterações'}</button></div>;

  return <section className="dashboard-page">
    <div className="dash-heading"><div><span className="section-kicker">PAINEL DE ADMINISTRAÇÃO</span><h1>Dashboard da <span>Minako</span></h1><p>Um lugar só para organizar os módulos do servidor.</p></div><span className="demo-badge"><i /> {apiReady ? 'CONECTADO AO BANCO' : 'DASHBOARD'}</span></div>
    <div className="dash-demo-notice"><strong>Persistência real</strong><span>As configurações são carregadas e salvas por servidor no PostgreSQL. O acesso é restrito a administradores verificados pelo Discord. A criação/publicação de um sorteio real pelo bot será uma etapa separada.</span></div>
    <div className="dash-layout">
      <aside className="dash-sidebar" aria-label="Seções da dashboard">{dashboardSections.map((item) => <button key={item.id} className={`dash-nav-item ${section === item.id ? 'selected' : ''}`} onClick={() => { setSection(item.id); setNotice(''); }}><span className="dash-nav-icon">{item.icon}</span><span><strong>{item.label}</strong><small>{item.desc}</small></span><b>›</b></button>)}</aside>
      <div className="dash-main">
        <div className="dash-panel-heading"><div><span className="section-kicker">CONFIGURAÇÕES DO SERVIDOR</span><h2>{active.label}</h2><p>{active.desc}</p></div><span className="dash-chip">{apiReady ? 'PostgreSQL conectado' : 'Sem conexão'}</span></div>
        {loadError && !loadingConfig && !apiReady && <div className="dash-info-card"><strong>Sem conexão com os dados do servidor</strong><p>{loadError}{health && health.database !== 'ok' ? ` Diagnóstico: banco ${health.database === 'disabled' ? 'não configurado (DATABASE_URL ausente)' : `com erro${health.databaseHint ? ` — ${health.databaseHint}` : ''}`}.` : ''}{health?.database === 'ok' ? ' O banco respondeu normalmente; o problema parece ser de permissão ou de sessão do Discord.' : ''}</p><button type="button" className="primary-button" onClick={() => setConfigTick((n) => n + 1)}>Tentar de novo</button></div>}
        {guildDataError && section !== 'overview' && <div className="dash-info-card"><strong>Seletores indisponíveis</strong><p>{guildDataError} Enquanto isso, os campos aceitam o ID numérico.</p><button type="button" className="primary-button" onClick={() => setGuildTick((n) => n + 1)}>Tentar de novo</button></div>}
        {section === 'overview' && <>
          <div className="dash-overview-grid">
            <button className="dash-overview-card" onClick={() => setSection('week')}><span>📅</span><strong>Semana e ciclo</strong><small>{config.weekStartDay === 'sunday' ? 'Domingo' : config.weekStartDay === 'saturday' ? 'Sábado' : 'Segunda-feira'} · {config.weekStartTime}</small></button>
            <button className="dash-overview-card" onClick={() => setSection('night')}><span>🌙</span><strong>Modo Noturno</strong><small>{config.nightEnabled ? `Ativo · ${config.nightStart}–${config.nightEnd}` : 'Desativado'}</small></button>
            <button className="dash-overview-card" onClick={() => setSection('matchmaking')}><span>🎮</span><strong>Matchmaking</strong><small>{config.centralChannel ? 'Canal configurado' : 'Sem canal definido'}</small></button>
            <button className="dash-overview-card" onClick={() => setSection('giveaways')}><span>🎁</span><strong>Sorteios</strong><small>{config.giveawayName || 'Novo sorteio'} · {config.giveawayWinners} ganhador(es)</small></button>
          </div>
          <div className="dash-info-card"><strong>Configurações conectadas</strong><p>Semana/ciclo, canais gerais, Modo Noturno, personalidade sazonal, cargos e canal da Central são gravados nos módulos/tabelas existentes. Os demais campos da Dashboard são persistidos como configuração por servidor; publicar ou executar ações do sorteio ainda exige integração com o cliente Discord do bot.</p></div>
        </>}
        {section === 'week' && <div className="dash-form-grid">{select('weekStartDay','Dia de início do ciclo',[{value:'monday',label:'Segunda-feira'},{value:'sunday',label:'Domingo'},{value:'saturday',label:'Sábado'}])}{field('weekStartTime','Horário da virada','00:00','Formato 24 horas, horário do servidor.')}{select('timezone','Fuso horário',[{value:'America/Sao_Paulo',label:'Brasília — America/Sao_Paulo'},{value:'UTC',label:'UTC'},{value:'America/Manaus',label:'Manaus — America/Manaus'}])}<div className="dash-info-card span-2"><strong>Semana e ciclo</strong><p>Define quando a Minako considera que começou uma nova semana para os ciclos e rankings que dependem dessa configuração.</p></div></div>}
        {section === 'channels' && <div className="dash-form-grid">{pick('moderationChannel','Canal de moderação','text',false,undefined)}{pick('publicationChannel','Canal de publicação','text',false,undefined)}<div className="dash-info-card span-2"><strong>Seletores do Discord</strong><p>Na integração final, você poderá escolher os canais diretamente, sem precisar copiar IDs.</p></div></div>}
        {section === 'night' && <div className="dash-form-grid">{toggle('nightEnabled','Ativar Modo Noturno','A configuração real aplicará os horários aos canais selecionados.')}{select('timezone','Fuso horário',[{value:'America/Sao_Paulo',label:'Brasília — America/Sao_Paulo'},{value:'UTC',label:'UTC'},{value:'America/Manaus',label:'Manaus — America/Manaus'}])}{field('nightStart','Horário de início','01:00','Formato HH:MM.')}{field('nightEnd','Horário de término','05:00','Formato HH:MM.')}{pick('nightCategories','Categorias afetadas','category',true,undefined)}{pick('nightAffectedChannels','Canais afetados','channel',true,undefined)}{pick('nightImmuneChannels','Canais imunes','channel',true,undefined)}{pick('nightNoticeChannels','Canais de comunicados','text',true,undefined)}{field('nightNoticeUrl','Link da mensagem principal','https://discord.com/channels/...','Link de uma mensagem do Discord.')}</div>}
        {section === 'seasonal' && <div className="dash-form-grid">{toggleSeason('halloween','Halloween','Falas e conteúdo sazonais de Halloween.')}{toggleSeason('christmas','Natal','Falas e conteúdo sazonais de Natal.')}{toggleSeason('newYear','Ano Novo','Falas e conteúdo sazonais de Ano Novo.')}<div className="dash-info-card span-2"><strong>Personalidade compartilhada</strong><p>Os pacotes ativados podem ser usados pelos módulos da Minako que recorrem ao mecanismo de personalidade sazonal.</p></div></div>}
        {section === 'roles' && <div className="dash-form-grid">{pick('starRole','Cargo Estrela da Semana','role',false,undefined)}{pick('matchAdminRoles','Cargos administradores de partidas','role',true,undefined)}</div>}
        {section === 'matchmaking' && <div className="dash-form-grid">{toggle('matchmakingEnabled','Habilitar matchmaking','Controla o estado geral do módulo (simulado).')}{toggle('reviewMatches','Exigir revisão de partidas','Simula a configuração de revisão antes de registrar partidas.')}{pick('centralChannel','Canal da Central de Matchmaking','text',false,undefined)}{field('matchModes','Modos disponíveis','Clássico, Ranqueada, Casual','Separe os modos por vírgula.')}{field('groupCapacity','Capacidade padrão do grupo','5','Número de jogadores.', 'number', 1, 20)}{field('proposalMinutes','Prazo de resposta (minutos)','10','Tempo para responder a uma proposta.', 'number', 1, 1440)}<div className="dash-info-card span-2"><strong>Configuração do matchmaking</strong><p>Esta seção reúne a entrada para as opções do módulo de matchmaking que hoje são acessadas pelo painel de configuração da Minako. Os parâmetros adicionais serão mapeados do painel real na etapa de integração.</p></div></div>}
        {section === 'giveaways' && <>
          <div className="dash-subsection"><span>01</span><div><h3>Geral e participantes</h3><p>Defina o nome, limites, ganhadores e quando o sorteio começa.</p></div></div>
          <div className="dash-form-grid">{field('giveawayName','Nome único do sorteio','Ex.: Skin lendária')}{field('giveawayWinners','Quantidade de ganhadores','1','Aceita um ou vários ganhadores.', 'number', 1, 100)}{field('giveawayMin','Mínimo de participantes','2','O sorteio pode aguardar atingir este mínimo.', 'number', 0, 100000)}{field('giveawayMax','Limite máximo de participantes','100','Use 0 para não impor limite.', 'number', 0, 100000)}{select('giveawayStart','Início do sorteio',[{value:'immediate',label:'Iniciar imediatamente'},{value:'manual',label:'Iniciar manualmente'},{value:'scheduled',label:'Agendar início'}])}{config.giveawayStart === 'scheduled' && field('giveawayScheduledAt','Data e hora de início','','Horário de Brasília.', 'datetime-local')}{select('giveawayCooldownType','Impedir vencedores de participar novamente',[{value:'none',label:'Não impedir'},{value:'giveaways',label:'Próximos sorteios'},{value:'days',label:'Por quantidade de dias'}])}{config.giveawayCooldownType !== 'none' && field('giveawayCooldownAmount','Quantidade','1','Sorteios ou dias, conforme a opção anterior.', 'number', 1, 365)}{config.giveawayCooldownType !== 'none' && config.giveawayCooldownType === 'giveaways' && select('giveawayCooldownUnit','Aplicar por',[{value:'giveaways',label:'Sorteios seguintes'}])}{select('giveawayRulesScope','Escopo das regras de participação',[{value:'local',label:'Somente este sorteio'},{value:'global',label:'Regras globais'}])}</div>
          <div className="dash-subsection"><span>02</span><div><h3>Canal e elegibilidade</h3><p>Defina onde publicar e quem pode participar.</p></div></div>
          <div className="dash-form-grid">{pick('giveawayChannel','Canal do sorteio','sendable',false,undefined)}{pick('giveawayAllowedRoles','Cargos permitidos','role',true,'Vazio = qualquer cargo, salvo outras regras.')}{pick('giveawayBlockedRoles','Cargos bloqueados','role',true,undefined)}{member('giveawayAllowedMembers','Membros permitidos','Busque por nome ou apelido.')}{member('giveawayBlockedMembers','Membros bloqueados','Busque por nome ou apelido.')}</div>
          <div className="dash-subsection"><span>03</span><div><h3>Duração e anúncio</h3><p>Monte a mensagem e escolha as opções de publicação.</p></div></div>
          <div className="dash-form-grid">{select('giveawayDuration','Duração predefinida',[{value:'1h',label:'1 hora'},{value:'6h',label:'6 horas'},{value:'12h',label:'12 horas'},{value:'24h',label:'24 horas'},{value:'3d',label:'3 dias'},{value:'7d',label:'7 dias'},{value:'custom',label:'Definir data de conclusão'}])}{config.giveawayDuration === 'custom' && field('giveawayEndDate','Data e hora de conclusão','','Horário de Brasília. Escolha quando o sorteio termina.', 'datetime-local')}{field('giveawayColor','Cor de destaque','#f6bd4b','Cor hexadecimal para a prévia.')}{toggle('giveawayPin','Fixar o anúncio no canal','Desativado por padrão, como no comando atual.')}
            <Field label="Mensagem do sorteio" hint="Prévia simplificada. Placeholders como {user1}, {host} e outros serão tratados na integração real."><textarea rows="5" value={config.giveawayMessage} onChange={(e) => update('giveawayMessage', e.target.value)} /></Field>
            <div className="dash-preview"><span className="section-kicker">PRÉVIA DO ANÚNCIO</span><div className="preview-card" style={{ borderTopColor: /^#[0-9a-f]{6}$/i.test(config.giveawayColor) ? config.giveawayColor : '#f6bd4b' }}><span className="preview-label">🎁 SORTEIO</span><h3>{config.giveawayName || 'Nome do sorteio'}</h3><p>{config.giveawayMessage || 'Sua mensagem aparecerá aqui.'}</p><div className="preview-meta"><span>👥 {config.giveawayMin}–{Number(config.giveawayMax) === 0 ? '∞' : config.giveawayMax} participantes</span><span>🏆 {config.giveawayWinners} ganhador(es)</span><span>⏳ {config.giveawayDuration === 'custom' ? (config.giveawayEndDate || 'Data não definida') : config.giveawayDuration}</span></div><button type="button" className="preview-join" onClick={() => setNotice('Prévia: o botão de participação ainda não inscreve ninguém.')}>Participar (0)</button></div></div>
          </div>
          <div className="dash-subsection"><span>04</span><div><h3>Experiência dos ganhadores e templates</h3><p>Prepare o espaço privado e reutilize configurações.</p></div></div>
          <div className="dash-form-grid">{toggle('giveawayPrivateThread','Criar tópico privado para host e ganhadores','Criado quando os resultados forem anunciados.')}{field('giveawayPrivateMessage','Mensagem do tópico privado','Mensagem enviada no tópico')}{field('giveawayTemplateName','Nome do template','Ex.: Sorteio mensal')}<Field label="Templates salvos neste servidor" hint="Escolha um template para preencher o formulário.">
            <select value={selectedTemplateId} onChange={(e) => loadTemplate(e.target.value)}>
              <option value="">Carregar template…</option>
              {templates.map((t) => { const id = String(t?.id ?? t); const name = String(t?.name ?? t); return <option key={id} value={id}>{name}</option>; })}
            </select>
          </Field>
          <div className="dash-button-row"><button type="button" className="secondary-button" onClick={saveTemplate}>Salvar como template</button><button type="button" className="secondary-button" onClick={deleteTemplate} disabled={!selectedTemplateId}>Excluir template selecionado</button></div></div>
        </>}
        {section === 'giveaways' && <ErrorBoundary><GiveawayLive apiFetch={apiFetch} guildId={guildId} config={config} setNotice={setNotice} /></ErrorBoundary>}
        {notice && <div className="dash-notice" role="status">{notice}</div>}
        {saveBar}
        <div className="legal-links" aria-label="Documentos legais da Minako">
          <span>Transparência e confiança</span>
          <a href="/legal/termos-de-uso.html" target="_blank" rel="noreferrer">📜 Termos de Uso</a>
          <a href="/legal/politica-de-privacidade.html" target="_blank" rel="noreferrer">🔒 Política de Privacidade</a>
        </div>
      </div>
    </div>
  </section>;

  function toggleSeason(key, label, hint) {
    return <ToggleField key={key} label={label} checked={config.seasonal[key]} onChange={(value) => updateSeasonal(key, value)} hint={hint} />;
  }
}

function ActivityApp() {
  const [page, setPage] = useState('central');
  const [sdkReady, setSdkReady] = useState(false);
  const [sdkError, setSdkError] = useState('');
  const [auth, setAuth] = useState(null);
  const [accessToken, setAccessToken] = useState('');
  const [data, setData] = useState(demoData);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sdk, setSdk] = useState(null);

  useEffect(() => {
    if (!clientId) {
      setSdkError('Configure VITE_DISCORD_CLIENT_ID no arquivo activity/.env para conectar ao Discord.');
      return;
    }
    const instance = new DiscordSDK(clientId);
    setSdk(instance);
    instance.ready()
      .then(() => setSdkReady(true))
      .catch(() => setSdkError('Pré-visualização no navegador. Abra a Activity dentro do Discord para autenticar e carregar dados reais.'));
  }, []);

  const loadCentral = useCallback(async (token, guildId) => {
    if (!guildId) {
      setData(demoData);
      setError('Abra a Activity em um servidor para consultar a Central de Matchmaking.');
      return;
    }
    const response = await fetch(`/api/central?guildId=${encodeURIComponent(guildId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Não foi possível carregar a Central.');
    setData(payload);
    setError('');
  }, []);

  const connect = useCallback(async () => {
    if (!sdk || !sdkReady) {
      setNotice('A conexão com o Discord só fica disponível quando a Activity é aberta dentro do cliente Discord.');
      return;
    }
    if (!clientId) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { code } = await sdk.commands.authorize({
        client_id: clientId,
        response_type: 'code',
        state: crypto.randomUUID(),
        prompt: 'none',
        scope: ['identify', 'guilds'],
      });
      const tokenResponse = await fetch('/api/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      const tokenPayload = await tokenResponse.json().catch(() => ({}));
      if (!tokenResponse.ok || !tokenPayload.access_token) throw new Error(tokenPayload.error || 'A autorização do Discord falhou.');
      const authenticated = await sdk.commands.authenticate({ access_token: tokenPayload.access_token });
      if (!authenticated?.user) throw new Error('O Discord não retornou o usuário autenticado.');
      setAuth(authenticated);
      setAccessToken(tokenPayload.access_token);
      await loadCentral(tokenPayload.access_token, sdk.guildId);
    } catch (e) {
      setError(e.message || 'Não foi possível conectar ao Discord.');
    } finally {
      setBusy(false);
    }
  }, [sdk, sdkReady, loadCentral]);

  const refresh = useCallback(async () => {
    if (!accessToken || !sdk) return;
    setBusy(true);
    setError('');
    try {
      await loadCentral(accessToken, sdk.guildId);
      setNotice('Dados atualizados.');
    } catch (e) {
      setError(e.message || 'Falha ao atualizar os dados.');
    } finally {
      setBusy(false);
    }
  }, [accessToken, sdk, loadCentral]);

  const displayName = auth?.user?.global_name || auth?.user?.username || 'Jogador';
  const isLive = data.mode === 'live';
  const stats = useMemo(() => [
    { icon: 'users', label: 'Disponíveis agora', value: isLive ? data.availableNow : '—', hint: isLive ? 'membros disponíveis' : 'aguardando conexão' },
    { icon: 'groups', label: 'Grupos abertos', value: isLive ? data.openGroups.length : '—', hint: isLive ? `${data.freeSlots} vagas disponíveis` : 'dados do servidor' },
    { icon: 'clock', label: 'Propostas pendentes', value: isLive ? data.pendingProposals : '—', hint: 'aguardando resposta' },
    { icon: 'trophy', label: 'Partidas hoje', value: isLive ? data.matchesToday : '—', hint: 'registros do dia' },
  ], [data, isLive]);

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" /><div className="ambient ambient-two" />
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Minako Central Gamer">
          <span className="brand-mark"><Icon name="gamepad" size={23} /></span>
          <span><strong>MINAKO</strong><small>CENTRAL GAMER</small></span>
        </a>
        <nav className="topbar-nav" aria-label="Navegação principal">
          <button className={page === 'central' ? 'active' : ''} onClick={() => setPage('central')}>Central</button>
          <button className={page === 'dashboard' ? 'active' : ''} onClick={() => setPage('dashboard')}>Dashboard</button>
        </nav>
        <div className="topbar-right">
          <span className={`status-pill ${isLive ? 'status-live' : ''}`}><i />{isLive ? 'Dados ao vivo' : 'Modo inicial'}</span>
          {auth && <span className="user-chip">{displayName}</span>}
        </div>
      </header>

      {page === 'dashboard' ? <AdminDashboard accessToken={accessToken} guildId={sdk?.guildId} /> : <>
      <section className="hero" id="top">
        <div className="hero-copy">
          <div className="eyebrow"><span className="eyebrow-line" /> HONOR OF KINGS · COMUNIDADE</div>
          <h1>Seu próximo<br /><span>time começa aqui.</span></h1>
          <p>Encontre jogadores, descubra grupos abertos e organize suas próximas partidas com a comunidade.</p>
          <div className="hero-actions">
            {!auth ? <button className="primary-button" onClick={connect} disabled={busy || !sdkReady}>
              {busy ? <span className="spinner" /> : <Icon name="shield" size={18} />}
              {busy ? 'Conectando…' : 'Conectar ao Discord'}
              {!busy && <Icon name="arrow" size={17} />}
            </button> : <button className="primary-button" onClick={refresh} disabled={busy}>
              {busy ? <span className="spinner" /> : <Icon name="refresh" size={18} />}
              {busy ? 'Atualizando…' : 'Atualizar Central'}
            </button>}
            <span className="privacy-note"><Icon name="shield" size={14} /> Acesso verificado pelo Discord</span>
          </div>
          {(error || sdkError || notice) && <div className={`inline-message ${error ? 'message-error' : ''}`} role="status">{error || notice || sdkError}</div>}
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="orbit orbit-one" /><div className="orbit orbit-two" />
          <div className="hero-emblem"><Icon name="gamepad" size={62} /></div>
          <span className="float-tag tag-top">TEAM UP <b>↗</b></span>
          <span className="float-tag tag-bottom"><i /> BUSCANDO JOGADORES</span>
          <span className="spark spark-a">✦</span><span className="spark spark-b">✧</span>
        </div>
      </section>

      <section className="stats-grid" aria-label="Indicadores do matchmaking">
        {stats.map((stat) => <article className="stat-card" key={stat.label}>
          <div className="stat-top"><span className="stat-icon"><Icon name={stat.icon} /></span><span className="stat-dot" /></div>
          <div className="stat-value">{stat.value}</div>
          <div className="stat-label">{stat.label}</div>
          <div className="stat-hint">{stat.hint}</div>
        </article>)}
      </section>

      <section className="content-grid">
        <article className="panel groups-panel">
          <div className="panel-heading"><div><span className="section-kicker">ENCONTRE SUA EQUIPE</span><h2>Grupos abertos</h2></div><span className="count-badge">{isLive ? data.openGroups.length : '—'}</span></div>
          {!isLive ? <div className="empty-state"><span className="empty-icon"><Icon name="groups" size={27} /></span><strong>Os grupos vão aparecer aqui</strong><p>Conecte a Activity dentro do Discord para consultar os grupos reais deste servidor.</p></div> : data.openGroups.length === 0 ? <div className="empty-state"><span className="empty-icon"><Icon name="gamepad" size={27} /></span><strong>Nenhum grupo aberto por enquanto</strong><p>Quando alguém abrir um grupo pelo matchmaking da Minako, ele será exibido aqui.</p></div> : <div className="group-list">{data.openGroups.map((group) => <div className="group-row" key={group.id}><div className="group-avatar"><Icon name="gamepad" /></div><div className="group-info"><strong>{group.mode}</strong><span>{group.confirmed}/{group.capacity} jogadores confirmados</span></div><div className="group-spots"><b>{group.free}</b><span>vagas</span></div></div>)}</div>}
          <div className="panel-footer"><span>Os dados vêm do módulo de matchmaking da Minako.</span><span className="footer-mark">✦</span></div>
        </article>

        <article className="panel activity-panel">
          <div className="panel-heading"><div><span className="section-kicker">MOVIMENTO DA COMUNIDADE</span><h2>Atividade recente</h2></div><span className="live-label"><i /> LIVE</span></div>
          {!isLive || !data.recent.length ? <div className="timeline-empty"><div className="timeline-node"><Icon name="clock" size={18} /></div><div><strong>Novidades em breve</strong><p>Eventos recentes aparecerão aqui quando a Activity estiver conectada aos dados do servidor.</p></div></div> : <div className="timeline">{data.recent.map((item, index) => <div className="timeline-item" key={`${item.at}-${index}`}><span className="timeline-node"><Icon name={index === 0 ? 'groups' : 'gamepad'} size={16} /></span><div><strong>{item.text}</strong><p>{formatRelative(item.at)}</p></div></div>)}</div>}
          <div className="weekly-summary"><span className="weekly-icon"><Icon name="trophy" size={18} /></span><div><strong>Últimos 7 dias</strong><p>{isLive ? `${data.weekly.groupsFormed} grupos formados · ${data.weekly.matchesRegistered} partidas registradas` : 'Estatísticas serão exibidas após a conexão'}</p></div></div>
        </article>
      </section>

      <footer className="app-footer"><span>MINAKO <b>·</b> FEITO PARA JOGAR EM EQUIPE</span><span className="footer-legal"><a href="/legal/termos-de-uso.html" target="_blank" rel="noreferrer">Termos de Uso</a><a href="/legal/politica-de-privacidade.html" target="_blank" rel="noreferrer">Política de Privacidade</a></span><span>{isLive && data.updatedAt ? `Atualizado ${formatRelative(data.updatedAt)}` : 'Activity em desenvolvimento'}</span></footer>
      </>}
      <AudioControls />
    </main>
  );
}

// A Activity sempre abre com frame_id na URL; fora do Discord, mostra o site (login web).
const isEmbedded = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('frame_id');
export default function App() {
  return isEmbedded ? <ActivityApp /> : <WebApp Dashboard={AdminDashboard} />;
}
