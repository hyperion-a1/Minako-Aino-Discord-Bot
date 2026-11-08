import React, { useCallback, useEffect, useState } from 'react';
import AudioControls from './audio/AudioControls.jsx';
import Fx from './Fx.jsx';

// Experiência pelo navegador: landing → Entrar com Discord → seleção de servidor → Dashboard.
export const APP_VERSION = '2026.11.05-7';

export default function WebApp({ Dashboard }) {
  const [session, setSession] = useState(null);
  const [guilds, setGuilds] = useState(null);
  const [guildId, setGuildId] = useState('');
  const [msg, setMsg] = useState('');
  const [tab, setTab] = useState('dashboard');
  const [db, setDb] = useState('');

  useEffect(() => {
    const login = new URLSearchParams(window.location.search).get('login');
    if (login) {
      setMsg(login === 'cancelado' ? 'Login cancelado.' : 'Não foi possível entrar. Tente novamente.');
      window.history.replaceState(null, '', window.location.pathname);
    }
    fetch('/api/health').then((r) => r.json()).then((h) => setDb(h.database || '')).catch(() => setDb('error'));
    fetch('/api/session', { credentials: 'same-origin' }).then((r) => r.json()).then(setSession).catch(() => setSession({ authenticated: false }));
  }, []);

  useEffect(() => {
    if (!session?.authenticated) return;
    fetch('/api/web/guilds', { credentials: 'same-origin' })
      .then(async (r) => {
        const p = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(p.error || 'Falha ao listar servidores.');
        setGuilds(p.guilds);
        if (p.guilds.length === 1) setGuildId(p.guilds[0].id);
      })
      .catch((e) => { setMsg(e.message); setGuilds([]); });
  }, [session]);

  const logout = useCallback(() => {
    fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'x-csrf-token': session?.csrf || '' } })
      .finally(() => window.location.reload());
  }, [session]);

  if (!session) return <main className="app-shell web-center"><span className="spinner" /></main>;
  const authed = session.authenticated;
  const guild = guilds?.find((g) => g.id === guildId);

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" /><div className="ambient ambient-two" />
      <Fx />
      <header className="topbar">
        <a className="brand" href="/"><span><strong>MINAKO</strong><small>{authed ? 'PAINEL DO SERVIDOR' : 'CENTRAL GAMER'}</small></span></a>
        <div className="topbar-right">
          {db && <span className={`status-pill ${db === 'ok' ? 'status-live' : ''}`}><i />{db === 'ok' ? 'Banco conectado' : db === 'error' ? 'Banco indisponível' : 'Banco não configurado'}</span>}
          {authed && guilds?.length > 1 && guildId && <button className="web-link" onClick={() => setGuildId('')}>Trocar servidor</button>}
          <small className="web-version" title="Versão da interface carregada">v{APP_VERSION}</small>
          {authed && <span className="user-chip">{session.user.username}</span>}
          {authed && <button className="web-link" onClick={logout}>Sair</button>}
        </div>
      </header>

      {!authed && (
        <section className="web-center">
          {[8, 24, 42, 63, 80, 92].map((x, i) => <span key={x} className="fx-float" aria-hidden="true" style={{ left: `${x}%`, animationDelay: `${i * 0.9}s` }}>{i % 2 ? '✧' : '✦'}</span>)}
          <div className="eyebrow">HONOR OF KINGS · COMUNIDADE</div>
          <h1>Minako <span>Central Gamer</span></h1>
          <p>Gerencie as configurações da Minako no seu servidor pelo navegador. Você também pode abrir a Activity direto no Discord.</p>
          <a className="primary-button" href="/auth/login">Entrar com Discord</a>
          {msg && <div className="inline-message message-error" role="status">{msg}</div>}
          <span className="privacy-note">Acesso verificado pelo Discord · só administradores acessam o painel</span>
          <span className="footer-legal"><a href="/legal/termos-de-uso.html">Termos de Uso</a><a href="/legal/politica-de-privacidade.html">Política de Privacidade</a></span>
        </section>
      )}

      {authed && !guildId && (
        <section className="web-center">
          <h2>Escolha um servidor</h2>
          {msg && <div className="inline-message message-error" role="status">{msg}</div>}
          {!guilds ? <span className="spinner" /> : guilds.length === 0 ? (
            <p>Nenhum servidor encontrado onde você é administrador e a Minako está presente.</p>
          ) : (
            <div className="guild-list">
              {guilds.map((g) => (
                <button key={g.id} className="guild-item" onClick={() => setGuildId(g.id)}>
                  {g.icon ? <img src={`https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64`} alt="" width="40" height="40" /> : <span className="guild-fallback">{g.name.slice(0, 1)}</span>}
                  <span>{g.name}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {authed && guildId && (
        <>
          {guild && <p className="web-guild">Servidor: <strong>{guild.name}</strong></p>}
          <div className="web-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'dashboard'} className={tab === 'dashboard' ? 'on' : ''} onClick={() => setTab('dashboard')}>Dashboard</button>
            <button type="button" role="tab" aria-selected={tab === 'central'} className={tab === 'central' ? 'on' : ''} onClick={() => setTab('central')}>Central</button>
          </div>
          {tab === 'dashboard' ? <Dashboard accessToken="cookie" csrf={session.csrf} guildId={guildId} /> : <WebCentral guildId={guildId} />}
        </>
      )}
      <AudioControls />
    </main>
  );
}

// Central de Matchmaking com dados reais do PostgreSQL (mesmo endpoint usado pela Activity).
function WebCentral({ guildId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    setError('');
    fetch(`/api/central?guildId=${encodeURIComponent(guildId)}`, { credentials: 'same-origin' })
      .then(async (r) => { const p = await r.json().catch(() => ({})); if (!r.ok) throw new Error(p.error || 'Falha ao carregar a Central.'); setData(p); })
      .catch((e) => setError(e.message));
  }, [guildId]);
  useEffect(() => { load(); }, [load]);
  const cards = data ? [
    ['Disponíveis agora', data.availableNow, 'membros'], ['Grupos abertos', data.openGroups.length, `${data.freeSlots} vagas`],
    ['Propostas pendentes', data.pendingProposals, 'aguardando resposta'], ['Partidas hoje', data.matchesToday, 'registros do dia'],
  ] : [];
  return <section className="web-central">
    {error && <div className="inline-message message-error" role="status">{error}</div>}
    {!data && !error && <span className="spinner" />}
    {data && <>
      <div className="stats-grid">{cards.map(([label, value, hint]) => <article className="stat-card" key={label}><div className="stat-value">{value}</div><div className="stat-label">{label}</div><div className="stat-hint">{hint}</div></article>)}</div>
      <article className="panel">
        <h2>Grupos abertos</h2>
        {data.openGroups.length === 0 ? <p>Nenhum grupo aberto agora.</p> : <ul>{data.openGroups.map((g) => <li key={g.id}>{g.mode} · {g.confirmed}/{g.capacity} confirmados · {g.free} vaga(s)</li>)}</ul>}
      </article>
      <article className="panel">
        <h2>Atividade recente</h2>
        {data.recent.length === 0 ? <p>Sem eventos recentes.</p> : <ul>{data.recent.map((e, i) => <li key={i}>{e.text} · {new Date(e.at).toLocaleString('pt-BR')}</li>)}</ul>}
        {data.weekly && <p>Últimos 7 dias: {data.weekly.groupsFormed} grupos formados · {data.weekly.matchesRegistered} partidas registradas</p>}
      </article>
      <button type="button" className="primary-button" onClick={load}>Atualizar Central</button>
    </>}
  </section>;
}
