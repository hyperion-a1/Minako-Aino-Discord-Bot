const STORAGE_KEY = 'minako.activity.audio.v1';

const DEFAULTS = Object.freeze({ effectsEnabled: true, musicEnabled: false, soundStyle: 'classic', effectsVolume: 0.34, musicVolume: 0.18 });
let context;
let masterEffects;
let masterMusic;
let musicTimer = null;
let musicStep = 0;
let currentSettings = { ...DEFAULTS };

function getContext() {
  if (typeof window === 'undefined') return null;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!context) {
    context = new AudioContextClass();
    masterEffects = context.createGain();
    masterEffects.gain.value = currentSettings.effectsVolume;
    masterEffects.connect(context.destination);
    masterMusic = context.createGain();
    masterMusic.gain.value = 0;
    masterMusic.connect(context.destination);
  }
  return context;
}

export function readAudioSettings() {
  if (typeof window === 'undefined') return { ...DEFAULTS };
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
    currentSettings = {
      effectsEnabled: stored.effectsEnabled !== false,
      musicEnabled: stored.musicEnabled === true,
      soundStyle: stored.soundStyle === 'cozy' ? 'cozy' : 'classic',
      effectsVolume: clamp(stored.effectsVolume, 0, 1, DEFAULTS.effectsVolume),
      musicVolume: clamp(stored.musicVolume, 0, 0.5, DEFAULTS.musicVolume),
    };
    return { ...currentSettings };
  } catch { return { ...DEFAULTS }; }
}

export function saveAudioSettings(settings) {
  currentSettings = { ...DEFAULTS, ...settings };
  if (typeof window !== 'undefined') {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(currentSettings)); } catch { /* storage may be unavailable in embedded clients */ }
  }
  if (masterEffects) masterEffects.gain.setTargetAtTime(currentSettings.effectsEnabled ? currentSettings.effectsVolume : 0, context.currentTime, 0.04);
  if (masterMusic) masterMusic.gain.setTargetAtTime(currentSettings.musicEnabled ? currentSettings.musicVolume : 0, context.currentTime, 0.5);
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function tone(frequency, start, duration, { type = 'sine', volume = 0.12, endFrequency, destination = masterEffects, attack = 0.012, release = 0.12 } = {}) {
  if (!context || !destination) return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), start + duration);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), start + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration + release);
  oscillator.connect(gain);
  gain.connect(destination);
  oscillator.start(start);
  oscillator.stop(start + duration + release + 0.03);
}

export async function playUiSound(kind = 'magic') {
  if (!currentSettings.effectsEnabled) return;
  const ctx = getContext();
  if (!ctx) return;
  try { if (ctx.state === 'suspended') await ctx.resume(); } catch { return; }
  const now = ctx.currentTime + 0.004;
  if (currentSettings.soundStyle === 'cozy') { playCozySound(kind, now); return; }
  if (kind === 'energy') {
    tone(420, now, 0.09, { type: 'triangle', volume: 0.11, endFrequency: 690, release: 0.09 });
    tone(680, now + 0.055, 0.12, { type: 'sine', volume: 0.08, endFrequency: 980, release: 0.12 });
    tone(1040, now + 0.105, 0.08, { type: 'sine', volume: 0.035, endFrequency: 780, release: 0.12 });
  } else if (kind === 'success') {
    tone(523.25, now, 0.11, { volume: 0.075, release: 0.1 });
    tone(659.25, now + 0.085, 0.13, { volume: 0.07, release: 0.13 });
    tone(783.99, now + 0.17, 0.18, { volume: 0.065, release: 0.18 });
  } else if (kind === 'error') {
    tone(300, now, 0.13, { type: 'triangle', volume: 0.07, endFrequency: 220, release: 0.13 });
    tone(220, now + 0.1, 0.15, { type: 'sine', volume: 0.055, endFrequency: 180, release: 0.16 });
  } else {
    tone(880, now, 0.045, { volume: 0.035, endFrequency: 1046, release: 0.08 });
    tone(1318.5, now + 0.035, 0.055, { volume: 0.022, release: 0.1 });
  }
}

const ambientNotes = [
  [174.61, 261.63, 349.23], [196.00, 293.66, 392.00],
  [146.83, 220.00, 293.66], [164.81, 246.94, 329.63],
];

function playAmbientChord() {
  if (!context || !masterMusic || !currentSettings.musicEnabled) return;
  if (currentSettings.soundStyle === 'cozy') { playCozyAmbient(); return; }
  const now = context.currentTime + 0.03;
  const chord = ambientNotes[musicStep % ambientNotes.length];
  chord.forEach((frequency, index) => {
    tone(frequency, now + index * 0.16, 3.4, {
      type: 'sine', volume: index === 0 ? 0.14 : 0.065,
      destination: masterMusic, attack: 1.1, release: 2.8,
    });
  });
  // Soft, high harmonics make this an original procedural ambient bed, not a sampled recording.
  if (musicStep % 2 === 0) tone(chord[2] * 2, now + 0.42, 2.2, { type: 'sine', volume: 0.018, destination: masterMusic, attack: 1.2, release: 2.4 });
  musicStep += 1;
  musicTimer = window.setTimeout(playAmbientChord, 3200);
}

export async function setAmbientMusicEnabled(enabled) {
  const ctx = getContext();
  if (!ctx) return false;
  try { if (ctx.state === 'suspended') await ctx.resume(); } catch { return false; }
  currentSettings.musicEnabled = Boolean(enabled);
  if (masterMusic) masterMusic.gain.setTargetAtTime(enabled ? currentSettings.musicVolume : 0, ctx.currentTime, 0.8);
  if (enabled && musicTimer === null) {
    musicStep = 0;
    playAmbientChord();
  } else if (!enabled && musicTimer !== null) {
    window.clearTimeout(musicTimer);
    musicTimer = null;
  }
  return true;
}

export function setAudioVolumes(settings) {
  currentSettings = { ...currentSettings, ...settings };
  if (masterEffects && context) masterEffects.gain.setTargetAtTime(currentSettings.effectsEnabled ? currentSettings.effectsVolume : 0, context.currentTime, 0.04);
  if (masterMusic && context) masterMusic.gain.setTargetAtTime(currentSettings.musicEnabled ? currentSettings.musicVolume : 0, context.currentTime, 0.5);
}

// ---- Estilo "aconchegante": plucks de kalimba/caixa de música em escala pentatônica, tudo gerado em tempo real ----
const PENTA = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99];
const COZY_CHORDS = [[130.81, 261.63, 329.63, 493.88], [110, 220, 261.63, 392], [87.31, 174.61, 261.63, 329.63], [98, 196, 246.94, 329.63]];
const randomNote = () => PENTA[Math.floor(Math.random() * PENTA.length)];

function pluck(frequency, start, volume, destination = masterEffects) {
  tone(frequency, start, 0.1, { type: 'triangle', volume, attack: 0.006, release: 0.5, destination });
  tone(frequency * 2, start, 0.05, { type: 'sine', volume: volume * 0.35, attack: 0.004, release: 0.25, destination });
}

function playCozySound(kind, now) {
  if (kind === 'energy') {
    [523.25, 659.25, 783.99].forEach((f, i) => pluck(f, now + i * 0.07, 0.09));
    tone(220, now, 0.1, { type: 'sine', volume: 0.07, endFrequency: 330, release: 0.12 });
  } else if (kind === 'success') {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => pluck(f, now + i * 0.085, 0.085));
  } else if (kind === 'error') {
    tone(392, now, 0.1, { type: 'sine', volume: 0.07, endFrequency: 349, release: 0.15 });
    tone(330, now + 0.13, 0.12, { type: 'sine', volume: 0.06, endFrequency: 294, release: 0.2 });
  } else {
    const f = randomNote();
    pluck(f, now, 0.07);
    if (Math.random() < 0.35) pluck(f * 2, now + 0.06, 0.03);
  }
}

function playCozyAmbient() {
  const now = context.currentTime + 0.03;
  const chord = COZY_CHORDS[musicStep % COZY_CHORDS.length];
  chord.forEach((f, i) => tone(f, now + i * 0.12, 5.2, { type: 'sine', volume: i === 0 ? 0.12 : 0.05, destination: masterMusic, attack: 1.4, release: 3.2 }));
  const count = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < count; i += 1) pluck(randomNote(), now + 0.6 + i * (0.7 + Math.random() * 0.5), 0.05, masterMusic);
  musicStep += 1;
  musicTimer = window.setTimeout(playAmbientChord, 4800);
}

// Reinicia a trilha ao trocar de estilo, sem esperar o próximo ciclo.
export function restartAmbient() {
  if (musicTimer === null) return;
  window.clearTimeout(musicTimer);
  musicTimer = null;
  musicStep = 0;
  playAmbientChord();
}
