const {
  SlashCommandBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
} = require('discord.js');
const db = require('../utils/db');
const { EMOJIS } = require('../utils/minakoEmojis');
const { normalizeText, normalizeProfile, isComplete } = require('../utils/matchmaking/profile');
const { getHeroCatalog, resolveHeroIds, namesForIds } = require('../utils/matchmaking/catalog');

const HERO_PAGE_SIZE = 25;
const MAX_HEROES = 5;
const MAX_ROUTES = 5;
const MAX_MODES = 3;

// Catálogos controlados pela Minako. Heróis NÃO ficam aqui: vêm da Mizuno.
const RANKS = [
  ['bronze', 'Bronze'],
  ['prata', 'Prata'],
  ['ouro', 'Ouro'],
  ['platina', 'Platina'],
  ['diamante', 'Diamante'],
  ['mestre', 'Mestre'],
  ['grao-mestre', 'Grão-Mestre'],
  ['mitico', 'Mítico'],
  ['epico', 'Épico'],
  ['lenda', 'Lenda'],
];

const ROUTES = [
  ['Rota Superior', 'Superior'],
  ['Selva', 'Selva'],
  ['Rota do Meio', 'Meio'],
  ['Apoio', 'Apoio'],
  ['Rota Inferior', 'Inferior'],
];

const MODES = [
  ['ranqueada', 'Ranqueada', 'Foco em subir ou manter o elo'],
  ['normal', 'Normal', 'Partidas normais'],
  ['casual', 'Casual', 'Jogar sem foco competitivo'],
];

const TIME_SLOTS = [
  ['00-04', '00h–04h'],
  ['04-08', '04h–08h'],
  ['08-12', '08h–12h'],
  ['12-16', '12h–16h'],
  ['16-20', '16h–20h'],
  ['20-24', '20h–24h'],
];

const DAYS = [
  ['domingo', 'Domingo'],
  ['segunda', 'Segunda'],
  ['terca', 'Terça'],
  ['quarta', 'Quarta'],
  ['quinta', 'Quinta'],
  ['sexta', 'Sexta'],
  ['sabado', 'Sábado'],
];

function list(value) { return value?.length ? value.join(', ') : 'Ainda não definido'; }
function activeLabel(profile) { return profile.active ? '🟢 Ativo' : '⚪ Pausado'; }
function rankLabel(value) { return RANKS.find(([id]) => id === value)?.[1] || value || 'Ainda não definido'; }
function routeLabel(value) { return ROUTES.find(([id]) => id === value)?.[1] || value; }
function modeLabel(value) { return MODES.find(([id]) => id === value)?.[1] || value; }
function scheduleDays(schedule) { return DAYS.filter(([id]) => Array.isArray(schedule?.[id]) && schedule[id].length).map(([, label]) => label); }
function scheduleText(schedule) {
  const lines = [];
  for (const [day, label] of DAYS) {
    const slots = Array.isArray(schedule?.[day]) ? schedule[day] : [];
    if (slots.length) lines.push(`• **${label}:** ${slots.map(slotLabel).join(', ')}`);
  }
  return lines.join('\n') || 'Ainda não definida';
}
function slotLabel(value) { return TIME_SLOTS.find(([id]) => id === value)?.[1] || value; }

function mainPanel(profile, catalog) {
  const complete = isComplete(profile);
  const heroNames = namesForIds(profile.heroes, catalog);
  const body = new TextDisplayBuilder().setContent(
    `## ${EMOJIS.hok} Perfil de Partidas da Minako\n` +
    `*Vamos montar seu perfil com calma — tudo por seleção, sem precisar decorar nomes ou escrever formatos estranhos.* ${EMOJIS.estrelaBrilho}\n\n` +
    `### Seu perfil\n` +
    `• **Status:** ${complete ? activeLabel(profile) : '🟡 Incompleto'}\n` +
    `• **Elo atual:** ${rankLabel(profile.currentRank)}\n` +
    `• **Maior elo:** ${rankLabel(profile.peakRank)}\n` +
    `• **Rotas:** ${profile.routes.map(routeLabel).join(', ') || 'Ainda não definido'}\n` +
    `• **Heróis principais:** ${list(heroNames)}\n` +
    `• **Modalidades:** ${profile.modes.map(modeLabel).join(', ') || 'Ainda não definido'}\n` +
    `• **Tamanho preferido:** ${profile.groupSize === 'trio' ? 'Trio' : profile.groupSize === 'five' ? 'Equipe de 5' : 'Dupla'}\n\n` +
    `### Disponibilidade\n${scheduleText(profile.schedule)}\n\n` +
    `-# ${complete ? 'Seu perfil está pronto para a próxima fase do matchmaking. ✨' : 'Ainda faltam alguns campos. Escolha cada um nos botões abaixo.'}`
  );

  const row1 = new ActionRowBuilder().addComponents(
    button('minako-match:rank', 'Elo atual', '🏅', ButtonStyle.Secondary),
    button('minako-match:peak', 'Maior elo', '👑', ButtonStyle.Secondary),
    button('minako-match:routes', 'Rotas', '🛣️', ButtonStyle.Secondary),
    button('minako-match:heroes:0', 'Heróis', '✨', ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    button('minako-match:modes', 'Modalidades', '🎮', ButtonStyle.Secondary),
    button('minako-match:schedule-day', 'Horários', '🕐', ButtonStyle.Secondary),
  );
  const row3 = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('minako-match:group')
      .setPlaceholder('Tamanho do grupo')
      .setMinValues(1).setMaxValues(1)
      .addOptions([
        { value: 'duo', label: 'Dupla', description: 'Encontrar mais uma pessoa', default: profile.groupSize === 'duo' },
        { value: 'trio', label: 'Trio', description: 'Encontrar mais duas pessoas', default: profile.groupSize === 'trio' },
        { value: 'five', label: 'Equipe de 5', description: 'Buscar uma equipe completa', default: profile.groupSize === 'five' },
      ])
  );
  const row4 = new ActionRowBuilder().addComponents(
    button(`minako-match:${profile.active ? 'pause' : 'activate'}`, profile.active ? 'Pausar matchmaking' : 'Ativar matchmaking', profile.active ? '⏸️' : '▶️', profile.active ? ButtonStyle.Secondary : ButtonStyle.Success),
    button('minako-match:close', 'Fechar', '✖️', ButtonStyle.Secondary),
  );

  return new ContainerBuilder()
    .setAccentColor(0xffb21a)
    .addTextDisplayComponents(body)
    .addSeparatorComponents(new SeparatorBuilder())
    .addActionRowComponents(row1)
    .addActionRowComponents(row2)
    .addActionRowComponents(row3)
    .addActionRowComponents(row4);
}

function button(customId, label, emoji, style) {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setEmoji(emoji).setStyle(style);
}
function payload(profile, catalog) { return { components: [mainPanel(profile, catalog)], flags: MessageFlags.IsComponentsV2 }; }
function editorPayload(title, description, rows) {
  const container = new ContainerBuilder().setAccentColor(0xffb21a)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${title}\n${description}`));
  for (const row of rows) container.addActionRowComponents(row);
  return { components: [container], flags: MessageFlags.IsComponentsV2 };
}

function rankPicker(profile) {
  return editorPayload('🏅 Elo atual', 'Escolha o seu elo atual. A Minako salva apenas uma opção válida.', [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('minako-match:set-current-rank').setPlaceholder('Selecione seu elo atual').setMinValues(1).setMaxValues(1)
        .addOptions(RANKS.map(([value, label]) => ({ value, label, default: profile.currentRank === value })))
    ),
    new ActionRowBuilder().addComponents(button('minako-match:back', 'Voltar', '↩️', ButtonStyle.Primary)),
  ]);
}
function peakPicker(profile) {
  return editorPayload('👑 Maior elo alcançado', 'Escolha o maior elo que você já alcançou.', [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('minako-match:set-peak-rank').setPlaceholder('Selecione seu maior elo').setMinValues(1).setMaxValues(1)
        .addOptions(RANKS.map(([value, label]) => ({ value, label, default: profile.peakRank === value })))
    ),
    new ActionRowBuilder().addComponents(button('minako-match:back', 'Voltar', '↩️', ButtonStyle.Primary)),
  ]);
}
function routesPicker(profile) {
  return editorPayload('🛣️ Rotas', 'Escolha de 1 a 5 rotas. As opções são as mesmas usadas pelo módulo de partidas da Mizuno.', [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('minako-match:set-routes').setPlaceholder('Escolha suas rotas principais').setMinValues(1).setMaxValues(MAX_ROUTES)
        .addOptions(ROUTES.map(([value, label]) => ({ value, label, default: profile.routes.includes(value) })))
    ),
    new ActionRowBuilder().addComponents(button('minako-match:clear-routes', 'Limpar rotas', '🧹', ButtonStyle.Danger), button('minako-match:back', 'Voltar', '↩️', ButtonStyle.Primary)),
  ]);
}
function modesPicker(profile) {
  return editorPayload('🎮 Modalidades', 'Escolha as modalidades em que você procura companhia.', [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('minako-match:set-modes').setPlaceholder('Escolha suas modalidades').setMinValues(1).setMaxValues(MAX_MODES)
        .addOptions(MODES.map(([value, label, description]) => ({ value, label, description, default: profile.modes.includes(value) })))
    ),
    new ActionRowBuilder().addComponents(button('minako-match:clear-modes', 'Limpar modalidades', '🧹', ButtonStyle.Danger), button('minako-match:back', 'Voltar', '↩️', ButtonStyle.Primary)),
  ]);
}
function heroPicker(profile, catalog, page = 0) {
  const totalPages = Math.max(1, Math.ceil(catalog.length / HERO_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const visible = catalog.slice(safePage * HERO_PAGE_SIZE, safePage * HERO_PAGE_SIZE + HERO_PAGE_SIZE);
  const selected = new Set(profile.heroes);
  const select = new StringSelectMenuBuilder().setCustomId(`minako-match:set-heroes:${safePage}`).setPlaceholder('Escolha até 5 heróis principais').setMinValues(1).setMaxValues(Math.min(MAX_HEROES, visible.length));
  select.addOptions(visible.map(hero => ({
    value: hero.id,
    label: hero.name.slice(0, 100),
    description: hero.routes?.length ? hero.routes.join(' • ').slice(0, 100) : 'Rotas ainda não informadas na Mizuno',
    default: selected.has(hero.id),
  })));
  const nav = new ActionRowBuilder();
  if (safePage > 0) nav.addComponents(button(`minako-match:hero-page:${safePage - 1}`, 'Anterior', '◀️', ButtonStyle.Secondary));
  nav.addComponents(button('minako-match:clear-heroes', 'Limpar', '🧹', ButtonStyle.Danger));
  if (safePage < totalPages - 1) nav.addComponents(button(`minako-match:hero-page:${safePage + 1}`, 'Próxima', '▶️', ButtonStyle.Secondary));
  nav.addComponents(button('minako-match:back', 'Voltar', '↩️', ButtonStyle.Primary));
  return editorPayload('✨ Heróis principais', `Escolha até ${MAX_HEROES}. Só existem aqui os heróis fornecidos pela Mizuno.\n\n**Selecionados:** ${namesForIds(profile.heroes, catalog).join(', ') || 'nenhum'}\n-# Página ${safePage + 1}/${totalPages}`, [new ActionRowBuilder().addComponents(select), nav]);
}
function dayPicker(profile) {
  return editorPayload('🕐 Disponibilidade', 'Primeiro escolha o dia que deseja configurar. Depois você poderá marcar os períodos disponíveis.', [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('minako-match:choose-day').setPlaceholder('Escolha um dia').setMinValues(1).setMaxValues(1)
        .addOptions(DAYS.map(([value, label]) => ({ value, label, description: profile.schedule?.[value]?.length ? `${profile.schedule[value].length} período(s) marcado(s)` : 'Nenhum período marcado' })))
    ),
    new ActionRowBuilder().addComponents(button('minako-match:clear-schedule', 'Limpar horários', '🧹', ButtonStyle.Danger), button('minako-match:back', 'Voltar', '↩️', ButtonStyle.Primary)),
  ]);
}
function timePicker(profile, day) {
  const label = DAYS.find(([id]) => id === day)?.[1] || day;
  const selected = Array.isArray(profile.schedule?.[day]) ? profile.schedule[day] : [];
  return editorPayload(`🕐 ${label}`, 'Marque todos os períodos em que você normalmente pode jogar. A seleção é salva imediatamente.', [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`minako-match:set-times:${day}`).setPlaceholder('Escolha seus períodos').setMinValues(1).setMaxValues(TIME_SLOTS.length)
        .addOptions(TIME_SLOTS.map(([value, text]) => ({ value, label: text, default: selected.includes(value) })))
    ),
    new ActionRowBuilder().addComponents(button('minako-match:schedule-day', 'Escolher outro dia', '📅', ButtonStyle.Secondary), button('minako-match:back', 'Voltar ao perfil', '↩️', ButtonStyle.Primary)),
  ]);
}

async function loadCatalog() {
  const catalog = await getHeroCatalog();
  if (!catalog.length) throw new Error('O catálogo de heróis da Mizuno ainda está vazio. Cadastre os heróis na biblioteca antes de configurar o matchmaking.');
  return catalog;
}
async function getProfile(guildId, userId, catalog) {
  const profile = normalizeProfile(await db.loadMatchProfile(guildId, userId)) || { guildId, userId, currentRank: '', peakRank: '', heroes: [], routes: [], modes: [], groupSize: 'duo', schedule: {}, active: false };
  const resolved = resolveHeroIds(profile.heroes, catalog);
  if (resolved.join('|') !== profile.heroes.join('|')) { profile.heroes = resolved; await db.saveMatchProfile(guildId, userId, profile); }
  return profile;
}
async function updatePanel(interaction, profile, catalog) { return interaction.update(payload(profile, catalog)); }
async function replyPanel(interaction, profile, catalog) { return interaction.reply({ ...payload(profile, catalog), flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral }); }

async function execute(interaction) {
  if (!interaction.guildId) return interaction.reply({ content: `${EMOJIS.alerta} Este comando só pode ser usado dentro de um servidor.`, flags: MessageFlags.Ephemeral });
  const catalog = await loadCatalog();
  const profile = await getProfile(interaction.guildId, interaction.user.id, catalog);
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'perfil' || subcommand === 'editar' || subcommand === 'horarios') return replyPanel(interaction, profile, catalog);
  if (subcommand === 'pausar') { await db.setMatchProfileActive(interaction.guildId, interaction.user.id, false); profile.active = false; return replyPanel(interaction, profile, catalog); }
  if (subcommand === 'ativar') {
    if (!isComplete(profile)) return interaction.reply({ content: `${EMOJIS.atencao} Ainda faltam dados no seu perfil. Abra **/minako-match perfil** e preencha tudo pelos seletores. ✨`, flags: MessageFlags.Ephemeral });
    await db.setMatchProfileActive(interaction.guildId, interaction.user.id, true); profile.active = true; return replyPanel(interaction, profile, catalog);
  }
}

// Atalho usado pela Central (botão "Meu perfil"): abre o mesmo painel do /minako-match perfil.
async function openProfile(interaction) {
  const catalog = await loadCatalog();
  const profile = await getProfile(interaction.guildId, interaction.user.id, catalog);
  return replyPanel(interaction, profile, catalog);
}

async function handleInteraction(interaction) {
  const id = interaction.customId || '';
  if (!id.startsWith('minako-match')) return false;
  const catalog = await loadCatalog();
  const profile = await getProfile(interaction.guildId, interaction.user.id, catalog);
  if (interaction.isButton()) {
    const parts = id.split(':');
    const action = parts[1];
    if (action === 'rank') return interaction.update(editorPayload('🏅 Elo atual', 'Escolha o seu elo atual.', [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('minako-match:set-current-rank').setPlaceholder('Selecione seu elo atual').addOptions(RANKS.map(([value, label]) => ({ value, label, default: profile.currentRank === value })))), new ActionRowBuilder().addComponents(button('minako-match:back', 'Voltar', '↩️', ButtonStyle.Primary))]));
    if (action === 'peak') return interaction.update(peakPicker(profile));
    if (action === 'routes') return interaction.update(routesPicker(profile));
    if (action === 'modes') return interaction.update(modesPicker(profile));
    if (action === 'heroes') return interaction.update(heroPicker(profile, catalog, Number(parts[2]) || 0));
    if (action === 'hero-page') return interaction.update(heroPicker(profile, catalog, Number(parts[2]) || 0));
    if (action === 'schedule-day') return interaction.update(dayPicker(profile));
    if (action === 'back') return updatePanel(interaction, profile, catalog);
    if (action === 'clear-routes') { profile.routes = []; await db.saveMatchProfile(interaction.guildId, interaction.user.id, profile); return updatePanel(interaction, profile, catalog); }
    if (action === 'clear-modes') { profile.modes = []; await db.saveMatchProfile(interaction.guildId, interaction.user.id, profile); return updatePanel(interaction, profile, catalog); }
    if (action === 'clear-heroes') { profile.heroes = []; await db.saveMatchProfile(interaction.guildId, interaction.user.id, profile); return updatePanel(interaction, profile, catalog); }
    if (action === 'clear-schedule') { profile.schedule = {}; await db.saveMatchProfile(interaction.guildId, interaction.user.id, profile); return updatePanel(interaction, profile, catalog); }
    if (action === 'pause' || action === 'activate') {
      if (action === 'activate' && !isComplete(profile)) return interaction.reply({ content: `${EMOJIS.atencao} Ainda faltam dados. Complete o perfil pelos seletores antes de ativar. ✨`, flags: MessageFlags.Ephemeral });
      profile.active = action === 'activate'; await db.setMatchProfileActive(interaction.guildId, interaction.user.id, profile.active); return updatePanel(interaction, profile, catalog);
    }
    if (action === 'close') return interaction.deleteReply();
    return true;
  }
  if (!interaction.isStringSelectMenu()) return true;
  const parts = id.split(':');
  const action = parts[1];
  if (action === 'group') profile.groupSize = interaction.values[0];
  else if (action === 'set-current-rank') profile.currentRank = interaction.values[0];
  else if (action === 'set-peak-rank') profile.peakRank = interaction.values[0];
  else if (action === 'set-routes') profile.routes = interaction.values.slice(0, MAX_ROUTES);
  else if (action === 'set-modes') profile.modes = interaction.values.slice(0, MAX_MODES);
  else if (action === 'set-heroes') {
    const page = Number(parts[2]) || 0;
    const visibleIds = new Set(catalog.slice(page * HERO_PAGE_SIZE, page * HERO_PAGE_SIZE + HERO_PAGE_SIZE).map(hero => hero.id));
    const kept = profile.heroes.filter(id => !visibleIds.has(id));
    profile.heroes = [...new Set([...kept, ...interaction.values.filter(id => visibleIds.has(id))])].slice(0, MAX_HEROES);
    await db.saveMatchProfile(interaction.guildId, interaction.user.id, profile);
    return interaction.update(heroPicker(profile, catalog, page));
  } else if (action === 'choose-day') return interaction.update(timePicker(profile, interaction.values[0]));
  else if (action === 'set-times') {
    const day = parts[2];
    profile.schedule = { ...(profile.schedule || {}), [day]: interaction.values.slice(0, TIME_SLOTS.length) };
    await db.saveMatchProfile(interaction.guildId, interaction.user.id, profile);
    return interaction.update(dayPicker(profile));
  } else return true;
  await db.saveMatchProfile(interaction.guildId, interaction.user.id, profile);
  return updatePanel(interaction, profile, catalog);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('minako-match')
    .setDescription('Configure seu perfil para o matchmaking da Minako.')
    .addSubcommand(s => s.setName('perfil').setDescription('Abrir seu perfil de partidas.'))
    .addSubcommand(s => s.setName('editar').setDescription('Abrir a edição do perfil.'))
    .addSubcommand(s => s.setName('horarios').setDescription('Abrir a edição da disponibilidade.'))
    .addSubcommand(s => s.setName('ativar').setDescription('Ativar seu perfil para o matchmaking.'))
    .addSubcommand(s => s.setName('pausar').setDescription('Pausar seu perfil no matchmaking.')),
  execute,
  handleInteraction,
  openProfile,
};
