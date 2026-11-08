import { useCallback, useEffect, useState } from 'react';
import { playUiSound, readAudioSettings, restartAmbient, saveAudioSettings, setAmbientMusicEnabled, setAudioVolumes } from './audioEngine.js';

function readInitialSettings() { return readAudioSettings(); }

export default function AudioControls() {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(readInitialSettings);
  const [audioAvailable, setAudioAvailable] = useState(true);
  const [message, setMessage] = useState('');

  const updateSettings = useCallback((patch) => {
    setSettings((previous) => {
      const next = { ...previous, ...patch };
      saveAudioSettings(next);
      setAudioVolumes(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (!settings.musicEnabled) return undefined;
    const activateSavedMusic = () => { void setAmbientMusicEnabled(true); window.removeEventListener('pointerdown', activateSavedMusic, true); window.removeEventListener('keydown', activateSavedMusic, true); };
    window.addEventListener('pointerdown', activateSavedMusic, true);
    window.addEventListener('keydown', activateSavedMusic, true);
    return () => { window.removeEventListener('pointerdown', activateSavedMusic, true); window.removeEventListener('keydown', activateSavedMusic, true); };
  }, [settings.musicEnabled]);

  useEffect(() => {
    let lastText = '';
    const onClick = (event) => {
      const target = event.target instanceof Element ? event.target.closest('button,[role="button"]') : null;
      if (!target || target.disabled || target.closest('[data-audio-controls]') || target.dataset.audioSilent === 'true') return;
      const label = `${target.getAttribute('aria-label') || ''} ${target.innerText || target.textContent || ''}`.toLocaleLowerCase('pt-BR');
      const energetic = /participar|sortear|sorteio|partida|jogar|grupo|buscar jogador|matchmaking|iniciar/.test(label);
      void playUiSound(energetic ? 'energy' : 'magic');
    };
    const onStatusMutation = () => {
      const status = document.querySelector('.dash-notice, .inline-message[role="status"]');
      const text = status?.textContent?.trim() || '';
      if (!text || text === lastText) return;
      lastText = text;
      void playUiSound(/erro|falha|não foi possível|inválid/i.test(text) ? 'error' : 'success');
    };
    const observer = new MutationObserver(onStatusMutation);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    document.addEventListener('click', onClick, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('click', onClick, true);
    };
  }, []);

  const toggleMusic = async () => {
    const nextEnabled = !settings.musicEnabled;
    const ok = await setAmbientMusicEnabled(nextEnabled);
    if (!ok) {
      setAudioAvailable(false);
      setMessage('Este ambiente não disponibiliza reprodução de áudio.');
      return;
    }
    updateSettings({ musicEnabled: nextEnabled });
    setMessage(nextEnabled ? 'Trilha ambiente ativada.' : 'Trilha ambiente pausada.');
    if (settings.effectsEnabled) void playUiSound('success');
  };

  const toggleEffects = () => {
    const next = !settings.effectsEnabled;
    updateSettings({ effectsEnabled: next });
    setMessage(next ? 'Efeitos sonoros ativados.' : 'Efeitos sonoros desativados.');
    if (next) void playUiSound('magic');
  };

  return <div className="audio-widget" data-audio-controls>
    {open && <section className="audio-panel" aria-label="Configurações de áudio">
      <header className="audio-panel-heading"><div><span className="audio-eyebrow">MINAKO SOUND</span><strong>Áudio da Minako</strong></div><button type="button" className="audio-close" aria-label="Fechar configurações de áudio" onClick={() => setOpen(false)}>×</button></header>
      <p className="audio-description">Sons originais gerados em tempo real, sem faixas ou samples de terceiros.</p>
      <div className="audio-style" role="radiogroup" aria-label="Estilo sonoro">
        {[['classic', '✨ Mágico'], ['cozy', '🧸 Aconchegante']].map(([id, label]) => <button type="button" key={id} role="radio" aria-checked={settings.soundStyle === id} className={`audio-style-opt ${settings.soundStyle === id ? 'is-on' : ''}`} onClick={() => { setAudioVolumes({ soundStyle: id }); updateSettings({ soundStyle: id }); restartAmbient(); void playUiSound('success'); }}>{label}</button>)}
      </div>
      <div className="audio-toggle-row"><span><strong>Efeitos sonoros</strong><small>Cliques, navegação e confirmações</small></span><button type="button" className={`audio-switch ${settings.effectsEnabled ? 'is-on' : ''}`} role="switch" aria-checked={settings.effectsEnabled} aria-label="Ativar efeitos sonoros" onClick={toggleEffects}><i /></button></div>
      <label className="audio-range"><span>Volume dos efeitos <b>{Math.round(settings.effectsVolume * 100)}%</b></span><input type="range" min="0" max="100" value={Math.round(settings.effectsVolume * 100)} onChange={(event) => updateSettings({ effectsVolume: Number(event.target.value) / 100 })} /></label>
      <div className="audio-toggle-row"><span><strong>Música ambiente</strong><small>Trilha relaxante e procedural</small></span><button type="button" className={`audio-switch ${settings.musicEnabled ? 'is-on' : ''}`} role="switch" aria-checked={settings.musicEnabled} aria-label="Ativar música ambiente" onClick={toggleMusic}><i /></button></div>
      <label className="audio-range"><span>Volume da música <b>{Math.round(settings.musicVolume * 100)}%</b></span><input type="range" min="0" max="50" value={Math.round(settings.musicVolume * 100)} onChange={(event) => updateSettings({ musicVolume: Number(event.target.value) / 100 })} /></label>
      {message && <p className="audio-status" role="status">{message}</p>}
      {!audioAvailable && <p className="audio-status audio-status-warning">Tente abrir a Activity no cliente atualizado do Discord.</p>}
      <p className="audio-footnote">A música só começa após você ativá-la. Suas preferências ficam salvas neste dispositivo.</p>
    </section>}
    <button type="button" className={`audio-launcher ${settings.musicEnabled ? 'is-playing' : ''}`} aria-expanded={open} aria-label={open ? 'Fechar configurações de áudio' : 'Abrir configurações de áudio'} onClick={() => { setOpen((value) => !value); if (!open) void playUiSound('magic'); }}>
      <span aria-hidden="true">{settings.musicEnabled ? '♫' : '♪'}</span><b>Áudio</b><i className={settings.musicEnabled ? 'audio-indicator active' : 'audio-indicator'} />
    </button>
  </div>;
}
