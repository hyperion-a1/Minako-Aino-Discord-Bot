const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const db = require('../utils/db');
const { getConfig } = require('../utils/config');
const { EMOJIS } = require('../utils/minakoEmojis');
const { validateNightConfig, processNightMode, summarizeScope, parseTime } = require('../utils/nightMode');
const { normalizeSeasonalPackages, SEASONAL_PACKAGE_LABELS } = require('../utils/personality/seasonal');

const PANEL_TIMEOUT = 15 * 60 * 1000;
const sessions = new Map();
const MODULES = new Set(['semana', 'canais', 'noturno', 'personalidade', 'cargos']);
const SELECTABLE_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ...(ChannelType.GuildMedia !== undefined ? [ChannelType.GuildMedia] : []),
];

function sessionKey(interaction) { return `${interaction.guildId}:${interaction.user.id}`; }
function dayName(day) { return ['domingo','segunda-feira','terça-feira','quarta-feira','quinta-feira','sexta-feira','sábado'][Number(day)] || 'segunda-feira'; }
function normalizeIds(value) { return [...new Set(Array.isArray(value) ? value.filter(Boolean).map(String) : [])]; }
function normalizeDraft(config) {
  return {
    ...config,
    partidaAdminRoleIds: normalizeIds(config.partidaAdminRoleIds),
    nightModeNoticeChannelIds: normalizeIds(config.nightModeNoticeChannelIds),
    nightModeCategoryIds: normalizeIds(config.nightModeCategoryIds),
    nightModeAffectedChannelIds: normalizeIds(config.nightModeAffectedChannelIds),
    nightModeImmuneChannelIds: normalizeIds(config.nightModeImmuneChannelIds),
    seasonalPackages: normalizeSeasonalPackages(config.seasonalPackages),
  };
}
function channelLabel(guild, id) { if (!id) return 'Não configurado'; return guild.channels.cache.get(id) ? `<#${id}>` : 'Canal não encontrado'; }
function channelsLabel(guild, ids, max = 5) { const list = normalizeIds(ids); if (!list.length) return 'Nenhum'; const shown = list.slice(0, max).map(id => channelLabel(guild, id)); return list.length > max ? `${shown.join(', ')} e mais ${list.length - max}` : shown.join(', '); }
function categoryLabel(guild, id) { if (!id) return 'Não configurada'; const c = guild.channels.cache.get(id); return c ? `<#${id}>` : 'Categoria não encontrada'; }
function categoriesLabel(guild, ids, max = 5) { const list = normalizeIds(ids); if (!list.length) return 'Nenhuma'; const shown = list.slice(0, max).map(id => categoryLabel(guild, id)); return list.length > max ? `${shown.join(', ')} e mais ${list.length - max}` : shown.join(', '); }
function roleLabel(guild, id) { if (!id) return 'Não configurado'; return guild.roles.cache.get(id) ? `<@&${id}>` : 'Cargo não encontrado'; }
function roleListLabel(guild, ids) { const list = normalizeIds(ids); return list.length ? list.map(id => roleLabel(guild,id)).join(', ') : 'Nenhum cargo selecionado'; }
function seasonalPackagesLabel(packages) { const normalized = normalizeSeasonalPackages(packages); const enabled = Object.entries(normalized).filter(([,v])=>v).map(([id])=>SEASONAL_PACKAGE_LABELS[id]||id); return enabled.length ? enabled.join(', ') : 'Nenhum pacote sazonal ativo'; }

function nightScopeSummary(guild, draft) {
  const summary = summarizeScope(guild, draft);
  const warning = summary.overlappingImmuneIds.length
    ? `\n⚠️ **Atenção:** ${channelsLabel(guild, summary.overlappingImmuneIds)} ${summary.overlappingImmuneIds.length === 1 ? 'foi escolhida' : 'foram escolhidas'} como imune(s) e também aparece(m) na seleção de afetados. A imunidade prevalece.`
    : '';
  return `• **Categorias:** ${categoriesLabel(guild, summary.categoryIds)}\n` +
    `• **Canais diretamente afetados:** ${channelsLabel(guild, summary.affectedChannelIds)}\n` +
    `• **Canais imunes:** ${channelsLabel(guild, summary.immuneChannelIds)}\n` +
    `• **Resultado:** **${summary.affectedChannelIds.length} canal(is)** serão bloqueado(s).${warning}`;
}

function timeModal(userId, draft) {
  return new ModalBuilder().setCustomId(`minako-config:horario:${userId}`).setTitle('Horário do Modo Noturno').addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('inicio').setLabel('Início (HH:MM)').setStyle(TextInputStyle.Short).setRequired(true).setValue(draft.nightModeStartTime || '01:00').setMaxLength(5)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('fim').setLabel('Fim (HH:MM)').setStyle(TextInputStyle.Short).setRequired(true).setValue(draft.nightModeEndTime || '05:00').setMaxLength(5)),
  );
}
function linkModal(userId, draft) {
  const input = new TextInputBuilder().setCustomId('url').setLabel('Link da mensagem detalhada').setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('https://discord.com/channels/.../.../...').setMaxLength(200);
  if (draft.nightModeNoticeUrl) input.setValue(draft.nightModeNoticeUrl);
  return new ModalBuilder().setCustomId(`minako-config:link:${userId}`).setTitle('Aviso principal do Modo Noturno').addComponents(new ActionRowBuilder().addComponents(input));
}
function weekTimeModal(userId, draft) {
  return new ModalBuilder().setCustomId(`minako-config:semana-horario:${userId}`).setTitle('Horário do novo ciclo').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('horario').setLabel('Horário (HH:MM)').setStyle(TextInputStyle.Short).setRequired(true).setValue(draft.weekStartTime || '00:00').setMaxLength(5)));
}

function moduleSelect(interaction, current = 'home') {
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(`minako-config:modulo:${interaction.user.id}`)
    .setPlaceholder(current === 'home' ? 'Escolha o que deseja configurar' : 'Trocar de módulo')
    .setMinValues(1).setMaxValues(1)
    .addOptions([
      {value:'semana',label:'Semana e ciclo',description:'Dia e horário da virada semanal.',emoji:'📅',default:current==='semana'},
      {value:'canais',label:'Canais gerais',description:'Moderação e publicação.',emoji:'💬',default:current==='canais'},
      {value:'noturno',label:'Modo Noturno',description:'Horários, avisos e canais afetados.',emoji:'🌙',default:current==='noturno'},
      {value:'personalidade',label:'Personalidade sazonal',description:'Pacotes como Halloween, Natal e Ano Novo.',emoji:'✨',default:current==='personalidade'},
      {value:'cargos',label:'Cargos',description:'Estrela da Semana e administração de partidas.',emoji:'🏅',default:current==='cargos'},
      {value:'matchmaking',label:'Matchmaking',description:'Central, grupos, prazos, modos e revisão de partidas.',emoji:'🎮',default:false},
    ]));
}
function validateEditableNightField(draft) {
  parseTime(draft.nightModeStartTime || '01:00');
  parseTime(draft.nightModeEndTime || '05:00');
  if (draft.nightModeStartTime === draft.nightModeEndTime) throw new Error('O horário de início e o horário de fim do Modo Noturno não podem ser iguais.');
}
function validateNoticeUrl(url) {
  if (!/^https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/.test(String(url || ''))) throw new Error('O link do aviso principal precisa ser um link de mensagem do Discord válido.');
}
function footer(interaction, includeCancel = false) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`minako-config:voltar:${interaction.user.id}`).setLabel('← Visão geral').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`minako-config:salvar:${interaction.user.id}`).setLabel('Salvar alterações').setEmoji('✅').setStyle(ButtonStyle.Success),
  );
  if (includeCancel) row.addComponents(new ButtonBuilder().setCustomId(`minako-config:cancelar:${interaction.user.id}`).setLabel('Cancelar').setStyle(ButtonStyle.Danger));
  return row;
}
function header(title, subtitle) { return new TextDisplayBuilder().setContent(`## ${EMOJIS.coracaoLaranjado} ${title}\n*${subtitle}* ${EMOJIS.estrelaBrilho}`); }

function buildHome(interaction, draft) {
  const scope = summarizeScope(interaction.guild, draft);
  return new ContainerBuilder().setAccentColor(0xffb21a)
    .addTextDisplayComponents(header('Configuração da Minako','Tudo em seu lugar, sem transformar o painel numa caça ao tesouro.'))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `### Visão geral\n`+
      `• **Semana:** ${dayName(draft.weekStartDay)}, às **${draft.weekStartTime}**\n`+
      `• **Moderação:** ${channelLabel(interaction.guild,draft.moderationChannelId)}\n`+
      `• **Publicação:** ${channelLabel(interaction.guild,draft.publicationChannelId)}\n`+
      `• **Modo Noturno:** ${draft.nightModeEnabled ? `**Ativado** — ${draft.nightModeStartTime} → ${draft.nightModeEndTime}` : '**Desativado**'}\n`+
      `• **Escopo noturno:** ${scope.resolvedChannelIds.length} canal(is) efetivamente afetado(s)\n`+
      `• **Avisos noturnos:** ${draft.nightModeNoticeChannelIds.length} canal(is)\n`+
      `• **Pacotes sazonais:** ${seasonalPackagesLabel(draft.seasonalPackages)}\n`+
      `• **Cargo Estrela:** ${roleLabel(interaction.guild,draft.starRoleId)}\n`+
      `• **Admins de partidas:** ${roleListLabel(interaction.guild,draft.partidaAdminRoleIds)}`
    ))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${EMOJIS.lampada} **Escolha um módulo abaixo** para editar. A Minako segura as alterações em rascunho até você salvar.`))
    .addActionRowComponents(moduleSelect(interaction,'home'))
    .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`minako-config:salvar:${interaction.user.id}`).setLabel('Salvar alterações').setEmoji('✅').setStyle(ButtonStyle.Success),new ButtonBuilder().setCustomId(`minako-config:cancelar:${interaction.user.id}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary)));
}

function buildSemana(interaction,draft){
  const day = dayName(draft.weekStartDay);
  return new ContainerBuilder().setAccentColor(0x3498db)
    .addTextDisplayComponents(header('Semana e ciclo','Escolha quando começa a nova semana da Minako.'))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`• **Dia:** ${day}\n• **Horário:** **${draft.weekStartTime}**\n\n-# Fuso usado pelo ciclo: **${draft.timezone || 'America/Sao_Paulo'}**.`))
    .addActionRowComponents(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`minako-config:dia:${interaction.user.id}`).setPlaceholder(`Dia atual: ${day}`).setMinValues(1).setMaxValues(1).addOptions([['0','Domingo'],['1','Segunda-feira'],['2','Terça-feira'],['3','Quarta-feira'],['4','Quinta-feira'],['5','Sexta-feira'],['6','Sábado']].map(([value,label])=>({value,label,default:value===String(draft.weekStartDay)})))))
    .addActionRowComponents(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`minako-config:semana-horario:${interaction.user.id}`).setLabel(`Definir horário: ${draft.weekStartTime || '00:00'}`).setStyle(ButtonStyle.Primary)))
    .addSeparatorComponents(new SeparatorBuilder()).addActionRowComponents(moduleSelect(interaction,'semana'),footer(interaction));
}

// Discord.js builders are kept explicit here to avoid accidental component-count growth.
function buildCanais(interaction,draft){
  const moderation = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`minako-config:moderacao:${interaction.user.id}`).setPlaceholder('Escolher canal de moderação').setChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement).setMinValues(1).setMaxValues(1));
  const publication = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`minako-config:publicacao:${interaction.user.id}`).setPlaceholder('Escolher canal de publicação').setChannelTypes(ChannelType.GuildText,ChannelType.GuildAnnouncement).setMinValues(1).setMaxValues(1));
  return new ContainerBuilder().setAccentColor(0x3498db)
    .addTextDisplayComponents(header('Canais gerais','Onde a Minako organiza moderação e publicação.'))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`• **Moderação:** ${channelLabel(interaction.guild,draft.moderationChannelId)}\n• **Publicação:** ${channelLabel(interaction.guild,draft.publicationChannelId)}`))
    .addActionRowComponents(moderation,publication)
    .addSeparatorComponents(new SeparatorBuilder()).addActionRowComponents(moduleSelect(interaction,'canais'),footer(interaction));
}
function buildNoturno(interaction,draft){
  const scope = summarizeScope(interaction.guild,draft);
  const categorySelect = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`minako-config:categorias-noturno:${interaction.user.id}`).setPlaceholder('Categorias afetadas (até 25)').setChannelTypes(ChannelType.GuildCategory).setMinValues(0).setMaxValues(25));
  const affectedSelect = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`minako-config:canais-noturno:${interaction.user.id}`).setPlaceholder('Canais diretamente afetados (até 25)').setChannelTypes(...SELECTABLE_CHANNEL_TYPES).setMinValues(0).setMaxValues(25));
  const immuneSelect = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`minako-config:imunes-noturno:${interaction.user.id}`).setPlaceholder('Canais imunes (até 25)').setChannelTypes(...SELECTABLE_CHANNEL_TYPES).setMinValues(0).setMaxValues(25));
  const noticeSelect = new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId(`minako-config:avisos-noturno:${interaction.user.id}`).setPlaceholder('Canais que recebem os comunicados (até 25)').setChannelTypes(...SELECTABLE_CHANNEL_TYPES).setMinValues(0).setMaxValues(25));
  const warning = scope.overlappingImmuneIds.length ? `\n\n⚠️ **Imunidade prevalece:** ${channelsLabel(interaction.guild,scope.overlappingImmuneIds)} também está na seleção de afetados.` : '';
  return new ContainerBuilder().setAccentColor(0x6c5ce7)
    .addTextDisplayComponents(header('Modo Noturno','A Minako só mexe no que você escolher — e as imunidades sempre vencem.'))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `• **Estado:** ${draft.nightModeEnabled ? '**Ativado**' : '**Desativado**'}\n`+
      `• **Horário:** **${draft.nightModeStartTime} → ${draft.nightModeEndTime}**\n`+
      `• **Categorias:** ${categoriesLabel(interaction.guild,scope.categoryIds)}\n`+
      `• **Canais diretos:** ${channelsLabel(interaction.guild,scope.affectedChannelIds)}\n`+
      `• **Imunes:** ${channelsLabel(interaction.guild,scope.immuneChannelIds)}\n`+
      `• **Resultado:** **${scope.resolvedChannelIds.length}** canal(is) afetado(s)\n`+
      `• **Comunicados:** ${channelsLabel(interaction.guild,draft.nightModeNoticeChannelIds)}\n`+
      `• **Aviso principal:** ${draft.nightModeNoticeUrl ? 'Configurado' : 'Não configurado'}\n`+
      `\n-# Fuso: **${draft.timezone || 'America/Sao_Paulo'}**.${warning}`
    ))
    .addActionRowComponents(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`minako-config:modo-toggle:${interaction.user.id}`).setLabel(draft.nightModeEnabled?'Desativar Modo Noturno':'Ativar Modo Noturno').setStyle(draft.nightModeEnabled?ButtonStyle.Danger:ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`minako-config:modo-horario:${interaction.user.id}`).setLabel('Definir horários').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`minako-config:modo-link:${interaction.user.id}`).setLabel('Definir link').setStyle(ButtonStyle.Secondary),
    ))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('### Escopo de atuação\nEscolha categorias, canais específicos e, se necessário, canais imunes. **Imunes têm prioridade**.'))
    .addActionRowComponents(categorySelect,affectedSelect,immuneSelect)
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('### Comunicados\nEsses canais recebem os avisos de 30 minutos, ativação, 30 minutos antes do fim e encerramento.'))
    .addActionRowComponents(noticeSelect)
    .addSeparatorComponents(new SeparatorBuilder()).addActionRowComponents(moduleSelect(interaction,'noturno'),footer(interaction));
}
function buildPersonalidade(interaction,draft){
  const seasonal = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`minako-config:pacotes-sazonais:${interaction.user.id}`).setPlaceholder('Pacotes sazonais ativos').setMinValues(0).setMaxValues(3).addOptions([
    {value:'halloween',label:'Halloween',description:'Falas e conteúdos sazonais de Halloween.',default:Boolean(draft.seasonalPackages?.halloween)},
    {value:'natal',label:'Natal',description:'Falas e conteúdos sazonais de Natal.',default:Boolean(draft.seasonalPackages?.natal)},
    {value:'ano_novo',label:'Ano Novo',description:'Falas e conteúdos sazonais de Ano Novo.',default:Boolean(draft.seasonalPackages?.ano_novo)},
  ]));
  return new ContainerBuilder().setAccentColor(0xf39c12)
    .addTextDisplayComponents(header('Personalidade sazonal','Uma chave só para todos os módulos que usam as falas da Minako.'))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`• **Pacotes ativos:** ${seasonalPackagesLabel(draft.seasonalPackages)}\n\nDesativar um pacote aqui impede que suas falas sejam escolhidas no **Modo Noturno, /partida, /perfil-match e módulos futuros** que utilizem o Personality Engine. ${EMOJIS.lampada}`))
    .addActionRowComponents(seasonal)
    .addSeparatorComponents(new SeparatorBuilder()).addActionRowComponents(moduleSelect(interaction,'personalidade'),footer(interaction));
}
function buildCargos(interaction,draft){
  const star = new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`minako-config:cargo-estrela:${interaction.user.id}`).setPlaceholder('Cargo Estrela da Semana').setMinValues(1).setMaxValues(1));
  const partida = new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId(`minako-config:cargos-partida:${interaction.user.id}`).setPlaceholder('Cargos que administram partidas').setMinValues(3).setMaxValues(3));
  return new ContainerBuilder().setAccentColor(0xe67e22)
    .addTextDisplayComponents(header('Cargos','Quem recebe a Estrela e quem pode administrar partidas.'))
    .addSeparatorComponents(new SeparatorBuilder())
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`• **Estrela da Semana:** ${roleLabel(interaction.guild,draft.starRoleId)}\n• **Administradores de partidas:** ${roleListLabel(interaction.guild,draft.partidaAdminRoleIds)}`))
    .addActionRowComponents(star,partida)
    .addSeparatorComponents(new SeparatorBuilder()).addActionRowComponents(moduleSelect(interaction,'cargos'),footer(interaction));
}
function panelPayload(interaction,draft,module='home'){
  const component = module==='home'?buildHome(interaction,draft):module==='semana'?buildSemana(interaction,draft):module==='canais'?buildCanais(interaction,draft):module==='noturno'?buildNoturno(interaction,draft):module==='personalidade'?buildPersonalidade(interaction,draft):buildCargos(interaction,draft);
  return {components:[component],flags:MessageFlags.IsComponentsV2};
}
function getSession(interaction){return sessions.get(sessionKey(interaction));}
function clearSession(interaction){const key=sessionKey(interaction);const s=sessions.get(key);if(s?.timer)clearTimeout(s.timer);sessions.delete(key);}
function createSession(interaction,config){clearSession(interaction);const session={draft:normalizeDraft(config),module:'home'};session.timer=setTimeout(()=>sessions.delete(sessionKey(interaction)),PANEL_TIMEOUT);sessions.set(sessionKey(interaction),session);return session;}
function isOwnConfigInteraction(interaction){return interaction.customId?.startsWith('minako-config:')&&interaction.customId?.endsWith(`:${interaction.user.id}`);}
function selectedValue(interaction){return interaction.values?.[0]??null;}

async function handleInteraction(interaction){
  if(!interaction.customId?.startsWith('minako-config:'))return false;
  if(!isOwnConfigInteraction(interaction)){if(!interaction.replied&&!interaction.deferred)await interaction.reply({content:'Este painel pertence a outra pessoa.',flags:MessageFlags.Ephemeral});return true;}
  const session=getSession(interaction);
  if(!session){await interaction.reply({content:`${EMOJIS.relogio} Este painel expirou. Abra **/minako-configurar** novamente.`,flags:MessageFlags.Ephemeral});return true;}
  const [,action]=interaction.customId.split(':');
  if(action==='modulo'){const module=selectedValue(interaction);if(module==='matchmaking'){await require('../utils/matchmaking/configPanel').open(interaction);return true;}if(MODULES.has(module))session.module=module;await interaction.update(panelPayload(interaction,session.draft,session.module));return true;}
  if(action==='voltar'){session.module='home';await interaction.update(panelPayload(interaction,session.draft));return true;}
  if(action==='moderacao')session.draft.moderationChannelId=selectedValue(interaction);
  else if(action==='publicacao')session.draft.publicationChannelId=selectedValue(interaction);
  else if(action==='cargo-estrela')session.draft.starRoleId=selectedValue(interaction);
  else if(action==='cargos-partida')session.draft.partidaAdminRoleIds=normalizeIds(interaction.values);
  else if(action==='dia')session.draft.weekStartDay=Number(selectedValue(interaction));
  else if(action==='categorias-noturno')session.draft.nightModeCategoryIds=normalizeIds(interaction.values);
  else if(action==='canais-noturno')session.draft.nightModeAffectedChannelIds=normalizeIds(interaction.values);
  else if(action==='imunes-noturno')session.draft.nightModeImmuneChannelIds=normalizeIds(interaction.values);
  else if(action==='avisos-noturno')session.draft.nightModeNoticeChannelIds=normalizeIds(interaction.values);
  else if(action==='pacotes-sazonais'){const selected=new Set(interaction.values||[]);session.draft.seasonalPackages=normalizeSeasonalPackages({halloween:selected.has('halloween'),natal:selected.has('natal'),ano_novo:selected.has('ano_novo')});}
  else if(action==='semana-horario'){if(interaction.isModalSubmit())session.draft.weekStartTime=interaction.fields.getTextInputValue('horario').trim();else{await interaction.showModal(weekTimeModal(interaction.user.id,session.draft));return true;}}
  else if(action==='modo-toggle')session.draft.nightModeEnabled=!session.draft.nightModeEnabled;
  else if(action==='modo-horario'){await interaction.showModal(timeModal(interaction.user.id,session.draft));return true;}
  else if(action==='modo-link'){await interaction.showModal(linkModal(interaction.user.id,session.draft));return true;}
  else if(action==='horario'){session.draft.nightModeStartTime=interaction.fields.getTextInputValue('inicio').trim();session.draft.nightModeEndTime=interaction.fields.getTextInputValue('fim').trim();validateEditableNightField(session.draft);}
  else if(action==='link'){session.draft.nightModeNoticeUrl=interaction.fields.getTextInputValue('url').trim();validateNoticeUrl(session.draft.nightModeNoticeUrl);}
  else if(action==='limpar-modo'){session.draft.nightModeEnabled=false;session.draft.nightModeCategoryIds=[];session.draft.nightModeAffectedChannelIds=[];session.draft.nightModeImmuneChannelIds=[];session.draft.nightModeNoticeChannelIds=[];session.draft.nightModeNoticeUrl=null;}
  else if(action==='salvar'){
    validateNightConfig(session.draft);
    await db.saveConfig(interaction.guildId,session.draft);
    let syncError=null;try{await processNightMode(interaction.guild,session.draft);}catch(error){syncError=error;console.error('[Minako] Falha ao sincronizar o Modo Noturno após salvar:',error.message);}
    const saved=session.draft;
    const savedScope=summarizeScope(interaction.guild,saved);
    const overlapNotice=savedScope.overlappingImmuneIds.length ? `\n\n⚠️ **Aviso de imunidade:** ${channelsLabel(interaction.guild,savedScope.overlappingImmuneIds)} também foi selecionado como afetado. A imunidade prevaleceu e esses canais não serão bloqueados.` : '';
    clearSession(interaction);
    const summary=new ContainerBuilder().setAccentColor(syncError?0xe67e22:0x2ecc71).addTextDisplayComponents(new TextDisplayBuilder().setContent(`${syncError?'⚠️':EMOJIS.aprovado} ## ${syncError?'Configuração salva com um detalhe':'Tudo salvo!'}\n\nA Minako guardou suas configurações.${syncError?`\n\n⚠️ **A sincronização imediata do Modo Noturno falhou:** ${String(syncError.message||syncError).slice(0,600)}`:'\n\n🌙 O Modo Noturno continua sendo verificado automaticamente pelo scheduler.'}${overlapNotice}`));
    await interaction.update({components:[summary],flags:MessageFlags.IsComponentsV2});return true;
  }
  else if(action==='cancelar'){clearSession(interaction);await interaction.update({components:[new ContainerBuilder().setAccentColor(0xffb21a).addTextDisplayComponents(new TextDisplayBuilder().setContent(`${EMOJIS.retorno} **Configuração cancelada.**\nNada foi alterado. Se quiser tentar de novo, abra **/minako-configurar**.`))],flags:MessageFlags.IsComponentsV2});return true;}
  await interaction.update(panelPayload(interaction,session.draft,session.module));return true;
}

module.exports={
  data:new SlashCommandBuilder().setName('minako-configurar').setDescription('Abre o painel de configuração da Minako.').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(interaction){const config=await getConfig(interaction.guildId);createSession(interaction,config);await interaction.reply({...panelPayload(interaction,getSession(interaction).draft),flags:MessageFlags.IsComponentsV2|MessageFlags.Ephemeral});},
  handleInteraction,
};
