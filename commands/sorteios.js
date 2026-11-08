'use strict';
// /sorteios — módulo de sorteios da Minako.
//   /sorteios configurar        painel (V2) com preview ao vivo para criar/agendar um sorteio
//   /sorteios encerrar nome     sorteia agora os ganhadores (host ou administrador)
//   /sorteios cancelar nome     cancela um sorteio que ainda não foi sorteado (host ou administrador)
//   /sorteios template-excluir  exclui um template (administrador ou cargos de criação)
//   /sorteios cargos            define quem pode criar sorteios e quais cargos os hosts podem dar/remover dos ganhadores (admin)
//   /sorteios regras-globais    regras de cargos/membros que valem para TODOS os sorteios (admin)
const { SlashCommandBuilder, MessageFlags, ActionRowBuilder, RoleSelectMenuBuilder, UserSelectMenuBuilder } = require('discord.js');
const db = require('../utils/db');
const store = require('../utils/giveawayStore');
const actions = require('../utils/giveawayActions');
const panel = require('../utils/giveawayPanel');
const core = require('../utils/giveawayCore');
const { line } = require('../utils/giveawayVoice');

const EPHEMERAL = MessageFlags.Ephemeral;
const PREFIX = 'minako-giveaway:';

const data = new SlashCommandBuilder()
  .setName('sorteios')
  .setDescription('Cria e administra os sorteios da Minako')
  .setDMPermission(false)
  .addSubcommand((s) => s.setName('cargos').setDescription('Quem cria sorteios e quais cargos podem ser dados/removidos dos ganhadores (administradores)'))
  .addSubcommand((s) => s.setName('regras-globais').setDescription('Regras de cargos/membros válidas para todos os sorteios (administradores)'))
  .addSubcommand((s) => s.setName('configurar').setDescription('Abre o painel para configurar e publicar um sorteio'))
  .addSubcommand((s) => s.setName('encerrar').setDescription('Sorteia agora os ganhadores de um sorteio ativo')
    .addStringOption((o) => o.setName('nome').setDescription('Nome do sorteio').setRequired(true).setAutocomplete(true)))
  .addSubcommand((s) => s.setName('cancelar').setDescription('Cancela um sorteio que ainda não foi sorteado')
    .addStringOption((o) => o.setName('nome').setDescription('Nome do sorteio').setRequired(true).setAutocomplete(true)))
  .addSubcommand((s) => s.setName('template-excluir').setDescription('Exclui um template de sorteio')
    .addStringOption((o) => o.setName('nome').setDescription('Nome do template').setRequired(true).setAutocomplete(true)));

async function autocomplete(i) {
  if (!i.inGuild() || !db.isEnabled()) return i.respond([]);
  const sub = i.options.getSubcommand();
  const focused = i.options.getFocused();
  try {
    if (sub === 'template-excluir') {
      const names = await store.searchTemplateNames(i.guildId, focused, 25);
      return i.respond(names.map((n) => ({ name: n.slice(0, 100), value: n.slice(0, 100) })));
    }
    const rows = await store.searchLiveNames(i.guildId, focused, 25);
    return i.respond(rows.map((r) => ({ name: r.name.slice(0, 100), value: r.name.slice(0, 100) })));
  } catch (error) {
    console.warn('[sorteios] autocomplete:', error.message);
    return i.respond([]);
  }
}

const listOf = (ids, prefix, empty) => (ids.length ? ids.map((r) => `<${prefix}${r}>`).join(', ') : empty);

async function rolesPayload(guildId, note = '') {
  const creators = await store.getCreatorRoles(guildId);
  const rewards = await store.getRewardRoles(guildId);
  const creatorMenu = new RoleSelectMenuBuilder().setCustomId(`${PREFIX}roles`).setPlaceholder('Cargos que podem criar sorteios').setMinValues(0).setMaxValues(10);
  if (creators.length) creatorMenu.setDefaultRoles(creators);
  const rewardMenu = new RoleSelectMenuBuilder().setCustomId(`${PREFIX}rewardroles`).setPlaceholder('Cargos que os hosts podem dar/remover dos ganhadores').setMinValues(0).setMaxValues(25);
  if (rewards.length) rewardMenu.setDefaultRoles(rewards);
  return {
    content: [
      note,
      '**Quem pode criar sorteios**',
      `Administradores sempre podem. Cargos liberados: ${listOf(creators, '@&', '*nenhum — só administradores*')}`,
      '',
      '**Cargos que os hosts podem conferir ou remover dos ganhadores**',
      `${listOf(rewards, '@&', '*nenhum — os hosts não conseguem usar essa função*')}`,
      '-# O bot só mexe em cargos abaixo do cargo dele. Cargos de integração e @everyone são ignorados. Esta lista é só dos sorteios.',
    ].filter((x, n) => x !== '' || n > 0).join('\n').trim(),
    components: [new ActionRowBuilder().addComponents(creatorMenu), new ActionRowBuilder().addComponents(rewardMenu)],
    flags: EPHEMERAL,
    allowedMentions: { parse: [] },
  };
}

async function handleRoles(i, action) {
  if (!i.isRoleSelectMenu?.()) return i.reply({ content: '❌ Ação desconhecida.', flags: EPHEMERAL });
  if (!actions.isAdmin(i)) return i.reply({ content: '🚫 Só administradores podem alterar isso.', flags: EPHEMERAL });
  const picked = (i.values || []).filter((r) => core.isSnowflake(r) && r !== i.guildId);
  if (action === 'rewardroles') {
    const usable = picked.filter((r) => !i.guild.roles.cache.get(r)?.managed);
    await store.setRewardRoles(i.guildId, usable);
  } else {
    await store.setCreatorRoles(i.guildId, picked);
  }
  const { flags, ...payload } = await rolesPayload(i.guildId, '✅ Pronto, lista atualizada.');
  return i.update(payload);
}

async function globalRulesPayload(guildId, note = '') {
  const r = await store.getGlobalRules(guildId);
  const roleMenu = (id, placeholder, ids) => { const m = new RoleSelectMenuBuilder().setCustomId(`${PREFIX}${id}`).setPlaceholder(placeholder).setMinValues(0).setMaxValues(25); if (ids.length) m.setDefaultRoles(ids); return m; };
  const userMenu = (id, placeholder, ids) => { const m = new UserSelectMenuBuilder().setCustomId(`${PREFIX}${id}`).setPlaceholder(placeholder).setMinValues(0).setMaxValues(25); if (ids.length) m.setDefaultUsers(ids); return m; };
  return {
    content: [
      note,
      '**Regras globais — valem para TODOS os sorteios da Minako**',
      `Cargos permitidos: ${listOf(r.allowedRoleIds, '@&', 'qualquer cargo')}`,
      `Cargos bloqueados: ${listOf(r.blockedRoleIds, '@&', '—')}`,
      `Membros permitidos: ${listOf(r.allowedUserIds, '@', 'qualquer membro')}`,
      `Membros bloqueados: ${listOf(r.blockedUserIds, '@', '—')}`,
      '-# Bloqueio vence permissão. Estas regras somam-se às de cada sorteio (quem participa precisa passar nas duas). Também podem ser adicionadas ao criar um sorteio com escopo global.',
    ].filter(Boolean).join('\n'),
    components: [
      new ActionRowBuilder().addComponents(roleMenu('gr-ar', 'Cargos permitidos (vazio = todos)', r.allowedRoleIds)),
      new ActionRowBuilder().addComponents(roleMenu('gr-br', 'Cargos bloqueados', r.blockedRoleIds)),
      new ActionRowBuilder().addComponents(userMenu('gr-au', 'Membros permitidos (vazio = todos)', r.allowedUserIds)),
      new ActionRowBuilder().addComponents(userMenu('gr-bu', 'Membros bloqueados', r.blockedUserIds)),
    ],
    flags: EPHEMERAL,
    allowedMentions: { parse: [] },
  };
}

async function handleGlobalRules(i, action) {
  if (!actions.isAdmin(i)) return i.reply({ content: '🚫 Só administradores podem alterar as regras globais.', flags: EPHEMERAL });
  const roleAction = action === 'gr-ar' || action === 'gr-br';
  if (roleAction ? !i.isRoleSelectMenu?.() : !i.isUserSelectMenu?.()) return i.reply({ content: '❌ Ação desconhecida.', flags: EPHEMERAL });
  const ids = (i.values || []).filter((x) => core.isSnowflake(x) && x !== i.guildId);
  const cur = await store.getGlobalRules(i.guildId);
  const key = { 'gr-ar': 'allowedRoleIds', 'gr-br': 'blockedRoleIds', 'gr-au': 'allowedUserIds', 'gr-bu': 'blockedUserIds' }[action];
  await store.setGlobalRules(i.guildId, { ...cur, [key]: ids });
  const { flags, ...payload } = await globalRulesPayload(i.guildId, '✅ Regras globais atualizadas.');
  return i.update(payload);
}

async function execute(i) {
  if (!i.inGuild()) return i.reply({ content: 'Este comando só pode ser usado em um servidor.', flags: EPHEMERAL });
  if (!db.isEnabled()) return i.reply({ content: '❌ O PostgreSQL precisa estar configurado (DATABASE_URL) para usar sorteios.', flags: EPHEMERAL });
  const sub = i.options.getSubcommand();

  if (sub === 'configurar') {
    if (!(await panel.canCreate(i))) return i.reply({ content: `🚫 ${line('noCreate')}`, flags: EPHEMERAL });
    return panel.open(i);
  }

  if (sub === 'regras-globais') {
    if (!actions.isAdmin(i)) return i.reply({ content: '🚫 Só administradores podem alterar as regras globais.', flags: EPHEMERAL });
    return i.reply(await globalRulesPayload(i.guildId));
  }

  if (sub === 'cargos') {
    if (!actions.isAdmin(i)) return i.reply({ content: '🚫 Só administradores podem escolher quem cria sorteios.', flags: EPHEMERAL });
    return i.reply(await rolesPayload(i.guildId));
  }

  if (sub === 'template-excluir') {
    if (!(await panel.canCreate(i))) return i.reply({ content: `🚫 ${line('noCreate')}`, flags: EPHEMERAL });
    const ok = await store.deleteTemplate(i.guildId, i.options.getString('nome', true));
    return i.reply({ content: ok ? '🗑️ Template excluído.' : 'Não encontrei um template com esse nome.', flags: EPHEMERAL });
  }

  // encerrar / cancelar
  await i.deferReply({ flags: EPHEMERAL });
  const g = await store.findLiveByName(i.guildId, i.options.getString('nome', true));
  if (!g) return i.editReply('Não encontrei um sorteio ativo com esse nome.');
  if (!actions.canManageGiveaway(i, g)) return i.editReply(`🚫 ${line('notHost')}`);

  if (sub === 'cancelar') {
    const r = await actions.cancelGiveaway(i.client, i.guildId, g.id);
    return i.editReply(r.kind === 'cancelled' ? '🚫 Sorteio cancelado.' : 'Esse sorteio já foi sorteado ou concluído — use os botões do anúncio dos ganhadores.');
  }

  // encerrar = sortear agora
  const r = await actions.drawGiveaway(i.client, i.guildId, g.id, { force: true });
  if (r.kind === 'drawn') return i.editReply('🎲 Pronto! Os ganhadores foram sorteados e anunciados no canal do sorteio.');
  if (r.kind === 'reannounced') return i.editReply('📣 Reenviei o anúncio dos ganhadores.');
  if (r.kind === 'below_min') return i.editReply(`Só há **${r.count}** participante(s) e o mínimo é **${r.min}**. Aguarde mais inscrições ou use \`/sorteios cancelar\`.`);
  if (r.kind === 'cancelled') return i.editReply('O sorteio foi cancelado (nenhum participante válido).');
  return i.editReply('Esse sorteio já foi sorteado. Use os botões **Ressortear** ou **Concluir** no anúncio.');
}

async function handleInteraction(i) {
  const [prefix, action, id, arg] = String(i.customId || '').split(':');
  if (`${prefix}:` !== PREFIX || !/^[a-z0-9-]{2,16}$/.test(action || '')) return false;
  try {
    if (!i.inGuild()) return i.reply({ content: 'Use isto em um servidor.', flags: EPHEMERAL });
    if (!db.isEnabled()) return i.reply({ content: '❌ O banco de dados não está disponível.', flags: EPHEMERAL });

    // Painel de configuração (customId: cfg-*:<rascunho de 8 hex>[:arg])
    if (action.startsWith('cfg-')) return await panel.handle(i);
    if (action === 'noop') return await i.deferUpdate();         // botões inertes da prévia
    if (action === 'roles' || action === 'rewardroles') return await handleRoles(i, action);
    if (action.startsWith('gr-')) return await handleGlobalRules(i, action);

    // Sorteios publicados: o ID é numérico (BIGINT) e sempre conferido contra o servidor da interação.
    if (!/^\d{1,18}$/.test(id || '')) return i.reply({ content: '❌ Botão inválido.', flags: EPHEMERAL });
    const page = Math.max(0, Math.min(100000, Number.parseInt(arg, 10) || 0));

    if (i.isButton()) {
      if (action === 'join') return await actions.handleJoin(i, id);
      if (action === 'leave') return await actions.handleLeave(i, id);
      if (action === 'people') return await actions.handlePeopleOpen(i, id);
      if (action === 'pg') return await actions.handlePeoplePage(i, id, page, 'list');
      if (action === 'rmopen') return await actions.handlePeoplePage(i, id, page, 'remove');
      if (action === 'redraw') return await actions.handleRedrawOpen(i, id);
      if (action === 'conclude') return await actions.handleConclude(i, id);
      if (action === 'rd-go' || action === 'rd-x') return await actions.handleRedrawControl(i, action, id);
    } else if (i.isStringSelectMenu() || i.isUserSelectMenu?.()) {
      if (action === 'rm') return await actions.handleRemove(i, id, page);
      if (['rd-who', 'rd-avoid'].includes(action)) return await actions.handleRedrawControl(i, action, id);
    }
    return i.reply({ content: '❌ Ação desconhecida.', flags: EPHEMERAL });
  } catch (error) {
    // Nunca devolve a mensagem crua (pode conter detalhes de SQL/IDs) para quem clicou.
    console.error(`[sorteios] Erro em ${action}:`, error);
    const payload = { content: '❌ Algo deu errado ao processar isso. Tente de novo em instantes.', flags: EPHEMERAL };
    if (i.deferred || i.replied) await i.followUp(payload).catch(() => {});
    else await i.reply(payload).catch(() => {});
    return undefined;
  }
}

module.exports = { data, execute, autocomplete, handleInteraction };
