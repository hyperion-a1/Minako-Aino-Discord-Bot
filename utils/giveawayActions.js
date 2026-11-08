'use strict';
// Ações dos sorteios publicados. Padrões herdados do /partida:
//  - ACK imediato (deferReply/deferUpdate) antes de qualquer trabalho pesado;
//  - toda regra é (re)validada dentro da transação do PostgreSQL;
//  - permissões de host/admin conferidas no servidor a cada clique;
//  - customIds estritos e mentions sempre limitadas por allowedMentions.
const {
  PermissionFlagsBits, ChannelType, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, UserSelectMenuBuilder, ContainerBuilder, TextDisplayBuilder,
} = require('discord.js');
const store = require('./giveawayStore');
const core = require('./giveawayCore');
const msg = require('./giveawayMessage');
const { line } = require('./giveawayVoice');

const { PREFIX } = msg;
const EPHEMERAL = MessageFlags.Ephemeral;
const PAGE_SIZE = 10;
const NO_PING = { parse: [] };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// Permissões
// ---------------------------------------------------------------------------
const isAdmin = (i) => Boolean(i.memberPermissions?.has(PermissionFlagsBits.Administrator));
// Host ou administrador — exigido em Participantes→Remover, Ressortear e Concluir.
const canManageGiveaway = (i, g) => isAdmin(i) || g.hostId === i.user.id;

function memberRoleIds(member) {
  if (!member?.roles) return [];
  return Array.isArray(member.roles) ? member.roles : [...member.roles.cache.keys()];
}

const reply = (i, content, extra = {}) => i.reply({ content, flags: EPHEMERAL, allowedMentions: NO_PING, ...extra });

// ---------------------------------------------------------------------------
// Atualização da mensagem pública (agrupada: vários cliques seguidos = 1 edição)
// ---------------------------------------------------------------------------
const pending = new Map();

function stateOf(g) {
  if (g.status === 'cancelled') return 'cancelled';
  return g.status === 'active' ? 'active' : 'drawn';
}

async function fetchTextChannel(client, channelId) {
  const ch = await client.channels.fetch(channelId).catch(() => null);
  return ch && ch.isTextBased?.() ? ch : null;
}

async function refreshPublic(client, guildId, id) {
  const g = await store.getGiveaway(guildId, id);
  if (!g || !g.messageId) return;
  const channel = await fetchTextChannel(client, g.channelId);
  if (!channel) return;
  const count = await store.countEntries(g.id);
  await channel.messages.edit(g.messageId, msg.buildPublicMessage(g, { count, state: stateOf(g) })).catch((error) => {
    console.warn(`[sorteios] Não consegui atualizar a mensagem do sorteio ${id}:`, error.message);
  });
}

function scheduleRefresh(client, guildId, id, delayMs = 1200) {
  const key = `${guildId}:${id}`;
  if (pending.has(key)) return;
  const timer = setTimeout(() => {
    pending.delete(key);
    refreshPublic(client, guildId, id).catch((e) => console.warn('[sorteios] refresh falhou:', e.message));
  }, delayMs);
  timer.unref?.();
  pending.set(key, timer);
}

// ---------------------------------------------------------------------------
// Entrar / Sair
// ---------------------------------------------------------------------------
function joinReply(check, g) {
  const roles = (ids) => ids.slice(0, 10).map((r) => `<@&${r}>`).join(', ');
  switch (check.reason) {
    case 'missing': return `❌ ${line('missing')}`;
    case 'closed': return `🔒 ${line('closed')}`;
    case 'already': return line('already');
    case 'full': return `🚫 ${line('full', { max: g?.config.maxParticipants })}`;
    case 'blocked_user': return `🚫 ${line('blockedUser')}`;
    case 'blocked_role': return `🚫 ${line('blockedRole', { roles: roles(check.roleIds) })}`;
    case 'not_allowed':
      if (!check.roleIds?.length) return `🚫 ${line('notAllowedMembers')}`;
      return `🚫 ${line('notAllowed', { roles: roles(check.roleIds) })}${check.members ? ' (ou estar entre os membros liberados pelo host)' : ''}`;
    case 'cooldown': {
      const parts = [];
      if (check.giveaways > 0) parts.push(`**${plural(check.giveaways, 'sorteio', 'sorteios')}**`);
      if (check.days > 0) parts.push(`**${plural(check.days, 'dia', 'dias')}**${check.until ? ` (libera <t:${Math.floor(check.until.getTime() / 1000)}:R>)` : ''}`);
      const single = parts.length === 1 && (check.giveaways === 1 || check.days === 1);
      return `⏳ ${line('cooldown', { wait: `${single ? 'falta' : 'faltam'} ${parts.join(' e ')}` })}`;
    }
    default: return '❌ Não consegui concluir sua inscrição agora. Tente de novo em instantes.';
  }
}

async function handleJoin(i, id) {
  await i.deferReply({ flags: EPHEMERAL });
  const result = await store.joinEntry(i.guildId, id, i.user.id, memberRoleIds(i.member));
  if (!result.check.ok) return i.editReply({ content: joinReply(result.check, result.giveaway), allowedMentions: NO_PING });
  scheduleRefresh(i.client, i.guildId, id);
  return i.editReply({
    content: `${line('joinOk', { name: core.breakMentions(result.giveaway.name) })}\n${line('joinCount', { count: result.count, plural })}`,
    allowedMentions: NO_PING,
  });
}

async function handleLeave(i, id) {
  await i.deferReply({ flags: EPHEMERAL });
  const r = await store.leaveEntry(i.guildId, id, i.user.id);
  if (r.missing) return i.editReply(`❌ ${line('missing')}`);
  if (r.closed) return i.editReply(`🔒 ${line('closed')}`);
  if (!r.left) return i.editReply(line('leaveNot'));
  scheduleRefresh(i.client, i.guildId, id);
  return i.editReply(`👋 ${line('leaveOk')}`);
}

// ---------------------------------------------------------------------------
// Participantes (10 por página, por ordem de inscrição) + remoção
// ---------------------------------------------------------------------------
async function memberNames(guild, ids) {
  const names = new Map();
  if (!ids.length) return names;
  try {
    const found = await guild.members.fetch({ user: ids });
    for (const m of found.values()) names.set(m.id, m.displayName);
  } catch { /* usa o ID como rótulo */ }
  return names;
}

async function peoplePayload(i, g, page, mode = 'list', note = '') {
  const total = await store.countEntries(g.id);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const ids = await store.listEntries(g.id, PAGE_SIZE, p * PAGE_SIZE);
  const lines = ids.length ? ids.map((u, n) => `${p * PAGE_SIZE + n + 1}. <@${u}>`) : ['Ninguém entrou ainda.'];
  const content = `${note ? `${note}\n\n` : ''}**Participantes de ${core.breakMentions(g.name)}** — ${total} no total (página ${p + 1}/${pages})\n${lines.join('\n')}`;
  const manage = canManageGiveaway(i, g);
  const rows = [];

  if (mode === 'remove' && manage && ids.length) {
    const names = await memberNames(i.guild, ids);
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`${PREFIX}rm:${g.id}:${p}`).setPlaceholder('Escolha quem remover').addOptions(
        ids.map((u, n) => ({ label: `${p * PAGE_SIZE + n + 1}. ${names.get(u) || u}`.slice(0, 100), value: u, description: `ID ${u}` }))
      )
    ));
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}pg:${g.id}:${p}`).setLabel('Voltar').setStyle(ButtonStyle.Secondary)
    ));
  } else {
    const nav = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIX}pg:${g.id}:${Math.max(0, p - 1)}`).setLabel('Anterior').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(p === 0),
      new ButtonBuilder().setCustomId(`${PREFIX}pg:${g.id}:${p + 1}`).setLabel('Próxima').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(p + 1 >= pages)
    );
    if (manage) {
      nav.addComponents(new ButtonBuilder().setCustomId(`${PREFIX}rmopen:${g.id}:${p}`).setLabel('Remover participante').setEmoji('🗑️').setStyle(ButtonStyle.Danger).setDisabled(!ids.length || g.status !== 'active'));
    }
    rows.push(nav);
  }
  return { content, components: rows, allowedMentions: NO_PING };
}

async function handlePeopleOpen(i, id) {
  const g = await store.getGiveaway(i.guildId, id);
  if (!g) return reply(i, `❌ ${line('missing')}`);
  return i.reply({ ...(await peoplePayload(i, g, 0)), flags: EPHEMERAL });
}

async function handlePeoplePage(i, id, page, mode = 'list') {
  const g = await store.getGiveaway(i.guildId, id);
  if (!g) return i.update({ content: `❌ ${line('missing')}`, components: [] });
  if (mode === 'remove' && !canManageGiveaway(i, g)) return reply(i, `🚫 ${line('notHost')}`);
  return i.update(await peoplePayload(i, g, page, mode));
}

async function handleRemove(i, id, page) {
  const g = await store.getGiveaway(i.guildId, id);
  if (!g) return i.update({ content: `❌ ${line('missing')}`, components: [] });
  if (!canManageGiveaway(i, g)) return reply(i, `🚫 ${line('notHost')}`);
  const userId = i.values?.[0];
  if (!core.isSnowflake(userId)) return reply(i, '❌ Seleção inválida.');
  await i.deferUpdate();
  const r = await store.removeEntry(i.guildId, id, userId);
  if (r.removed) scheduleRefresh(i.client, i.guildId, id);
  const note = r.removed ? `✅ <@${userId}> foi removido do sorteio.` : (r.closed ? '🔒 As inscrições já foram encerradas.' : 'Essa pessoa já não estava no sorteio.');
  const fresh = await store.getGiveaway(i.guildId, id);
  return i.editReply(await peoplePayload(i, fresh || g, page, 'list', note));
}

// ---------------------------------------------------------------------------
// Verificação de participantes no Discord (saíram do servidor / perderam elegibilidade)
// ---------------------------------------------------------------------------
async function findInvalid(guild, ids, cfg, globalRules = null) {
  const invalid = new Set();
  for (let n = 0; n < ids.length; n += 100) {
    const chunk = ids.slice(n, n + 100);
    let found;
    try { found = await guild.members.fetch({ user: chunk }); } catch (error) {
      console.warn('[sorteios] Não consegui verificar um lote de participantes (mantidos como válidos):', error.message);
      continue;
    }
    for (const id of chunk) {
      const m = found.get(id);
      if (!m) { invalid.add(id); continue; }
      const roles = new Set(m.roles.cache.keys());
      if (core.ruleViolation(globalRules, id, roles) || core.ruleViolation(cfg, id, roles)) invalid.add(id);
    }
  }
  return invalid;
}

async function guildOf(client, guildId) { return client.guilds.cache.get(guildId) || client.guilds.fetch(guildId).catch(() => null); }

// ---------------------------------------------------------------------------
// Publicação
// ---------------------------------------------------------------------------
function computeTimes(cfg, startsAt) {
  const endsAt = cfg.end.mode === 'date' ? new Date(cfg.end.at) : new Date(startsAt.getTime() + cfg.end.durationMinutes * 60_000);
  return { startsAt, endsAt };
}

// Confere o que o bot precisa no canal escolhido. errors bloqueiam; warnings só avisam.
function preflight(guild, channel, cfg) {
  const errors = []; const warnings = [];
  const me = guild.members.me;
  const perms = me && channel.permissionsFor ? channel.permissionsFor(me) : null;
  if (!perms) return { errors: ['Não consegui verificar minhas permissões nesse canal.'], warnings };
  if (!perms.has(PermissionFlagsBits.ViewChannel)) errors.push(`Não consigo ver ${channel}.`);
  const sendBit = channel.isThread?.() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages;
  if (!perms.has(sendBit)) errors.push(`Não tenho permissão para enviar mensagens em ${channel}.`);
  if (cfg.pin && !perms.has(PermissionFlagsBits.PinMessages ?? PermissionFlagsBits.ManageMessages)) warnings.push('Não tenho permissão para **fixar** mensagens nesse canal — o sorteio será publicado sem fixar.');
  if (cfg.privateThread.enabled) {
    const parent = channel.isThread?.() ? channel.parent : channel;
    const pp = parent && me ? parent.permissionsFor(me) : null;
    if (!parent || parent.type !== ChannelType.GuildText) warnings.push('Tópicos privados só podem ser criados em canais de texto — o tópico privado não será criado nesse canal.');
    else if (!pp?.has(PermissionFlagsBits.CreatePrivateThreads) || !pp?.has(PermissionFlagsBits.SendMessagesInThreads)) warnings.push('Não tenho permissão para **criar tópicos privados** nesse canal.');
  }
  return { errors, warnings };
}

// Envia a mensagem pública de um sorteio em status 'starting' e o ativa.
async function publishGiveaway(client, g) {
  const channel = await fetchTextChannel(client, g.channelId);
  if (!channel) throw new Error('Canal do sorteio indisponível.');
  const { startsAt, endsAt } = computeTimes(g.config, new Date());
  if (endsAt.getTime() < Date.now() + 30_000) throw new Error('A data de conclusão já passou.');
  const draft = { ...g, startsAt, endsAt };
  const sent = await channel.send(msg.buildPublicMessage(draft, { count: 0, state: 'active' }));
  const active = await store.markActive(g.id, { messageId: sent.id, channelId: channel.id, startsAt, endsAt });
  if (!active) { await sent.delete().catch(() => {}); throw new Error('O sorteio mudou de estado durante a publicação.'); }
  if (active.config.pin) await sent.pin().catch((e) => console.warn('[sorteios] Não consegui fixar a mensagem:', e.message));
  if (JSON.stringify(active.config.message.blocks).includes('{link}')) await refreshPublic(client, g.guildId, g.id);
  return { message: sent, giveaway: active };
}

// ---------------------------------------------------------------------------
// Cargos dos ganhadores (conferir/remover, permanente ou temporário)
// Aplicados no anúncio; no ressorteio os cargos dos substituídos são desfeitos e os dos novos aplicados.
// Toda operação é registrada ANTES no banco (para poder desfazer, mesmo após reinício).
// ---------------------------------------------------------------------------
const DAY_MS = 86_400_000;
const auditReason = (g) => `Sorteio "${String(g.name).replace(/[\r\n]+/g, ' ').slice(0, 80)}"`;

function roleOpsOf(wr) {
  return [
    ...wr.grantRoleIds.map((roleId) => ({ roleId, action: 'add', days: wr.grantDays })),
    ...wr.removeRoleIds.map((roleId) => ({ roleId, action: 'remove', days: wr.removeDays })),
  ];
}

// Motivo pelo qual um cargo não pode ser usado (ou null). `allowed` = lista liberada pelos administradores.
function roleProblem(guild, roleId, allowed) {
  const role = guild.roles.cache.get(roleId);
  if (!allowed.includes(roleId)) return `<@&${roleId}> não está na lista liberada pelos administradores (\`/sorteios cargos\`)`;
  if (!role) return `o cargo ${roleId} não existe mais`;
  if (role.id === guild.id || role.managed || !role.editable) return `não consigo gerenciar o cargo **${core.breakMentions(role.name)}** (está acima do meu cargo ou é de integração)`;
  return null;
}

// Usado na criação do sorteio: devolve a lista de problemas (vazia = tudo certo).
async function checkRewardRoles(guild, wr) {
  const ids = [...wr.grantRoleIds, ...wr.removeRoleIds];
  if (!ids.length) return [];
  const problems = [];
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) problems.push('preciso da permissão **Gerenciar Cargos** para dar/remover cargos dos ganhadores');
  const allowed = await store.getRewardRoles(guild.id);
  for (const id of ids) { const p = roleProblem(guild, id, allowed); if (p) problems.push(p); }
  return [...new Set(problems)];
}

async function applyWinnerRoles(client, g, userIds) {
  const ops = roleOpsOf(g.config.winnerRoles);
  const ids = [...new Set(userIds || [])];
  if (!ops.length || !ids.length) return { problems: [] };
  const guild = await guildOf(client, g.guildId);
  if (!guild) return { problems: ['o servidor não está disponível agora'] };
  const allowed = await store.getRewardRoles(g.guildId);
  const problems = [];
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) return { problems: ['preciso da permissão **Gerenciar Cargos**'] };
  const usable = [];
  for (const op of ops) { const p = roleProblem(guild, op.roleId, allowed); if (p) problems.push(p); else usable.push(op); }
  for (const userId of ids) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) { problems.push(`<@${userId}> não está mais no servidor`); continue; }
    for (const op of usable) {
      const has = member.roles.cache.has(op.roleId);
      if ((op.action === 'add') === has) continue;               // já está como queremos: nada a registrar nem a desfazer
      const opId = await store.insertRoleOp({
        guildId: g.guildId, giveawayId: g.id, userId, roleId: op.roleId, action: op.action,
        revertAt: op.days > 0 ? new Date(Date.now() + op.days * DAY_MS) : null,
      });
      if (!opId) continue;                                        // outra instância já fez
      try {
        if (op.action === 'add') await member.roles.add(op.roleId, auditReason(g));
        else await member.roles.remove(op.roleId, auditReason(g));
      } catch (error) {
        await store.deleteRoleOp(opId).catch(() => {});
        problems.push(`falhou em ${op.action === 'add' ? 'conferir' : 'remover'} <@&${op.roleId}> de <@${userId}> (${error.message})`);
      }
    }
  }
  return { problems: [...new Set(problems)] };
}

// Desfaz a operação inversa: cargo conferido → remove; cargo removido → devolve. Lança em caso de erro.
async function undoRoleOp(client, op, reason) {
  const guild = await guildOf(client, op.guildId);
  if (!guild) throw new Error('servidor indisponível');
  const role = guild.roles.cache.get(op.roleId);
  const member = await guild.members.fetch(op.userId).catch((e) => (e?.code === 10007 ? null : Promise.reject(e)));
  if (!member || !role) return 'gone';                            // saiu do servidor / cargo apagado: nada a fazer
  const has = member.roles.cache.has(op.roleId);
  if (op.action === 'add' && has) await member.roles.remove(op.roleId, reason);
  if (op.action === 'remove' && !has) await member.roles.add(op.roleId, reason);
  return 'done';
}

// Ressorteio: tira os cargos conferidos (e devolve os removidos) dos ganhadores substituídos.
async function revertWinnerRoles(client, g, userIds) {
  const ops = await store.listAppliedRoleOps(g.id, [...new Set(userIds || [])]);
  const problems = [];
  for (const op of ops) {
    try { await undoRoleOp(client, op, `${auditReason(g)} — ganhador substituído`); await store.markRoleOp(op.id, 'reverted'); } catch (error) {
      await store.markRoleOp(op.id, 'failed').catch(() => {});
      problems.push(`não consegui ${op.action === 'add' ? 'tirar' : 'devolver'} <@&${op.roleId}> ${op.action === 'add' ? 'de' : 'a'} <@${op.userId}> (${error.message})`);
    }
  }
  return { problems };
}

// Chamado pelo agendador: devolve os cargos temporários vencidos.
async function processDueRoleOps(client) {
  for (const op of await store.claimDueRoleOps(20)) {
    try {
      await undoRoleOp(client, op, 'Sorteio — fim do cargo temporário');
      await store.markRoleOp(op.id, 'reverted');
    } catch (error) {
      const gaveUp = await store.retryRoleOp(op.id, op.attempts).catch(() => false);
      console.warn(`[sorteios] Cargo temporário ${op.id} não revertido${gaveUp ? ' (desisti)' : ' (nova tentativa em 10 min)'}:`, error.message);
    }
  }
}

async function reportRoleProblems(client, g, problems, kind = 'rolesProblems') {
  if (!problems.length) return;
  const channel = await fetchTextChannel(client, g.channelId);
  await channel?.send({
    content: `⚠️ ${line(kind, { host: `<@${g.hostId}>`, name: core.breakMentions(g.name), list: problems.slice(0, 6).join('; ') })}`,
    allowedMentions: { users: [g.hostId] },
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Sortear / anunciar
// ---------------------------------------------------------------------------
async function announceWinners(client, g) {
  const channel = await fetchTextChannel(client, g.channelId);
  if (!channel) throw new Error('Canal do sorteio indisponível.');
  const payload = msg.buildWinnersMessage(g);
  const sent = await channel.send({ ...payload, ...(g.messageId ? { reply: { messageReference: g.messageId, failIfNotExists: false } } : {}) });
  await store.setAnnounceMessage(g.id, sent.id);
  await openPrivateThread(client, g, channel);               // falha aqui nunca derruba o anúncio
  try {
    const res = await applyWinnerRoles(client, g, g.winners);
    await reportRoleProblems(client, g, res.problems);
  } catch (e) { console.warn('[sorteios] Cargos dos ganhadores:', e.message); }
  return sent;
}

// Tópico privado criado junto com o anúncio (host + ganhadores). Depois disso, qualquer mudança
// (ex.: ressorteio) é feita manualmente por um moderador: o bot não mexe mais no tópico.
async function openPrivateThread(client, g, channel) {
  if (!g.config.privateThread.enabled || g.threadId) return;
  let claimed = false;
  try { claimed = await store.claimThread(g.id); } catch (e) { console.warn('[sorteios] claimThread:', e.message); return; }
  if (!claimed) return;
  try {
    const { thread, failed, messageSent } = await createPrivateThread(client, g);
    if (!messageSent) await channel?.send({ content: `⚠️ ${line('threadFail', { host: `<@${g.hostId}>`, name: core.breakMentions(g.name), reason: 'não consegui enviar a mensagem dentro dele' })} O tópico ${thread} já foi criado.`, allowedMentions: { users: [g.hostId] } }).catch(() => {});
    if (failed.length) {
      await channel?.send({ content: `⚠️ ${line('threadPartial', { host: `<@${g.hostId}>`, thread: `${thread}`, failed: failed.map((u) => `<@${u}>`).join(', ') })}`, allowedMentions: { users: [...new Set([g.hostId, ...failed])] } }).catch(() => {});
    }
  } catch (error) {
    console.warn('[sorteios] Tópico privado falhou:', error.message);
    await store.setThread(g.id, 'failed').catch(() => {});
    await channel?.send({ content: `⚠️ ${line('threadFail', { host: `<@${g.hostId}>`, name: core.breakMentions(g.name), reason: error.message })}`, allowedMentions: { users: [g.hostId] } }).catch(() => {});
  }
}

async function unpinSafe(client, g) {
  if (!g.messageId || !g.config.pin) return;
  const channel = await fetchTextChannel(client, g.channelId);
  await channel?.messages.unpin(g.messageId).catch(() => {});
}

// force=true: sorteia agora (antes do prazo). Sem force, só sorteia se o prazo venceu.
async function drawGiveaway(client, guildId, id, { force = false } = {}) {
  const g = await store.getGiveaway(guildId, id);
  if (!g) return { kind: 'missing' };
  if (g.status === 'drawn' && !g.announceMessageId) {          // reenvio do anúncio que falhou
    try { await announceWinners(client, g); } catch (e) { console.error('[sorteios] Reenvio do anúncio falhou:', e.message); }
    return { kind: 'reannounced', giveaway: g };
  }
  if (g.status !== 'active') return { kind: 'noop', giveaway: g };

  const guild = await guildOf(client, guildId);
  const entries = await store.listAllEntries(g.id);
  const invalidIds = guild ? await findInvalid(guild, entries, g.config, await store.getGlobalRules(guildId)) : new Set();
  const r = await store.drawTx(guildId, id, { invalidIds, force });

  if (r.kind === 'cancelled') {
    await unpinSafe(client, g);
    await refreshPublic(client, guildId, id);
    const channel = await fetchTextChannel(client, g.channelId);
    const nm = core.breakMentions(g.name);
    const text = r.reason === 'min_participants'
      ? `🚫 ${line('cancelledMin', { name: nm, count: r.count, min: g.config.minParticipants, host: `<@${g.hostId}>` })}`
      : `🚫 ${line('cancelledNone', { name: nm, host: `<@${g.hostId}>` })}`;
    await channel?.send({ content: text, allowedMentions: { users: [g.hostId] } }).catch(() => {});
    return r;
  }
  if (r.kind === 'drawn') {
    await refreshPublic(client, guildId, id);                  // expira Participar/Sair
    try { await announceWinners(client, r.giveaway); } catch (e) { console.error('[sorteios] Falha ao anunciar (será reenviado):', e.message); }
  }
  return r;
}

// ---------------------------------------------------------------------------
// Ressortear (painel efêmero do host/admin)
// ---------------------------------------------------------------------------
const redrawSessions = new Map();
const REDRAW_TTL = 10 * 60_000;
const rkey = (id, userId) => `${id}:${userId}`;

function redrawState(id, userId) {
  const k = rkey(id, userId);
  const s = redrawSessions.get(k);
  if (s && s.expires > Date.now()) return s;
  const fresh = { replaceIds: [], excluded: [], expires: Date.now() + REDRAW_TTL };
  redrawSessions.set(k, fresh);
  return fresh;
}

async function redrawPanel(i, g, state, note = '') {
  const names = await memberNames(i.guild, g.winners);
  const nameOf = (u) => names.get(u) || u;
  const lines = [
    `## 🔁 Ressortear — ${core.breakMentions(g.name)}`,
    `Ganhador(es) atual(is): ${g.winners.map((u) => `<@${u}>`).join(', ')}`,
    g.winners.length > 1
      ? 'Escolha quais ganhadores serão substituídos. Serão sorteados tantos novos ganhadores quanto você selecionar. Os ganhadores atuais não voltam a concorrer nesta rodada, e você pode evitar outras pessoas.'
      : 'O ganhador atual será substituído por um novo sorteado. Ele não volta a concorrer nesta rodada, e você pode evitar outras pessoas.',
  ];
  if (note) lines.push('', note);
  const container = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
  if (g.winners.length > 1) {
    const opts = g.winners.slice(0, 25);
    container.addActionRowComponents(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`${PREFIX}rd-who:${g.id}`).setPlaceholder('Quais ganhadores substituir?')
        .setMinValues(1).setMaxValues(opts.length)
        .addOptions(opts.map((u) => ({ label: nameOf(u).slice(0, 100), value: u, default: state.replaceIds.includes(u) })))
    ));
  }
  const avoid = new UserSelectMenuBuilder().setCustomId(`${PREFIX}rd-avoid:${g.id}`).setPlaceholder('Evitar que estas pessoas sejam sorteadas (opcional)').setMinValues(0).setMaxValues(25);
  if (state.excluded.length) avoid.setDefaultUsers(state.excluded.slice(0, 25));
  container.addActionRowComponents(new ActionRowBuilder().addComponents(avoid));
  container.addActionRowComponents(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${PREFIX}rd-go:${g.id}`).setLabel('Ressortear').setEmoji('🎲').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${PREFIX}rd-x:${g.id}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary)
  ));
  return { components: [container], flags: msg.V2 | EPHEMERAL, allowedMentions: NO_PING };
}

async function loadManaged(i, id) {
  const g = await store.getGiveaway(i.guildId, id);
  if (!g) { await reply(i, `❌ ${line('missing')}`); return null; }
  if (!canManageGiveaway(i, g)) { await reply(i, `🚫 ${line('notHost')}`); return null; }
  return g;
}

async function handleRedrawOpen(i, id) {
  const g = await loadManaged(i, id);
  if (!g) return undefined;
  if (g.status !== 'drawn') return reply(i, '🔒 Este sorteio já foi concluído (ou ainda não foi sorteado).');
  const state = redrawState(id, i.user.id);
  state.excluded = []; state.replaceIds = g.winners.length === 1 ? [g.winners[0]] : [];
  return i.reply(await redrawPanel(i, g, state));
}

async function handleRedrawControl(i, action, id) {
  const g = await loadManaged(i, id);
  if (!g) return undefined;
  const state = redrawState(id, i.user.id);
  if (action === 'rd-x') return i.update({ components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('Ressorteio cancelado.'))], flags: msg.V2 | EPHEMERAL });
  if (action === 'rd-who') {
    state.replaceIds = [...new Set(i.values || [])].filter((u) => g.winners.includes(u));
    return i.update(await redrawPanel(i, g, state));
  }
  if (action === 'rd-avoid') {
    state.excluded = (i.values || []).filter(core.isSnowflake).slice(0, 25);
    return i.update(await redrawPanel(i, g, state));
  }
  // rd-go
  if (g.status !== 'drawn') return i.update({ components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent('🔒 Este sorteio já foi concluído.'))], flags: msg.V2 | EPHEMERAL });
  if (!state.replaceIds.length) return i.update(await redrawPanel(i, g, state, '⚠️ Escolha pelo menos um ganhador para substituir.'));
  await i.deferUpdate();
  const guild = i.guild;
  const entries = await store.listAllEntries(g.id);
  const invalidIds = await findInvalid(guild, entries, g.config, await store.getGlobalRules(i.guildId));
  const r = await store.redrawTx(i.guildId, id, { replaceIds: state.replaceIds, excludedIds: state.excluded, invalidIds });
  const done = (text) => i.editReply({ components: [new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent(text))], flags: msg.V2 | EPHEMERAL, allowedMentions: NO_PING });
  if (r.kind === 'not_enough') return i.editReply(await redrawPanel(i, g, state, `⚠️ Só há **${r.available}** participante(s) elegível(is) e preciso de **${r.needed}**. Ajuste a lista de pessoas evitadas ou escolha menos ganhadores para substituir.`));
  if (r.kind === 'not_drawn') return done('🔒 Este sorteio já foi concluído.');
  if (r.kind !== 'redrawn') return done('❌ Não foi possível ressortear (a lista de ganhadores mudou — abra o ressorteio de novo).');

  redrawSessions.delete(rkey(id, i.user.id));
  const channel = await fetchTextChannel(i.client, g.channelId);
  if (channel && r.giveaway.announceMessageId) await channel.messages.edit(r.giveaway.announceMessageId, msg.buildWinnersMessage(r.giveaway)).catch(() => {});
  try {
    const undone = await revertWinnerRoles(i.client, r.giveaway, r.removed);
    const applied = await applyWinnerRoles(i.client, r.giveaway, r.added);
    await reportRoleProblems(i.client, r.giveaway, [...undone.problems, ...applied.problems], 'rolesProblemsRedraw');
  } catch (e) { console.warn('[sorteios] Cargos no ressorteio:', e.message); }
  const nm = core.breakMentions(g.name);
  const mention = (u) => `<@${u}>`;
  const text = r.added.length === 1
    ? `🔁 ${line('redrawOne', { name: nm, added: mention(r.added[0]), removed: mention(r.removed[0]) })}`
    : `🔁 ${line('redrawMany', { name: nm, added: r.added.map(mention).join(', '), removed: r.removed.map(mention).join(', ') })}`;
  const threadNote = g.threadId && g.threadId !== 'failed' && g.threadId !== 'pending' ? `\n-# 🔐 ${line('redrawThreadNote')}` : '';
  await channel?.send({
    content: text + threadNote, allowedMentions: { users: r.added },
    ...(r.giveaway.announceMessageId ? { reply: { messageReference: r.giveaway.announceMessageId, failIfNotExists: false } } : {}),
  }).catch((e) => console.warn('[sorteios] Não consegui avisar o ressorteio:', e.message));
  return done(`✅ Ressorteio feito: ${r.winners.map((u) => `<@${u}>`).join(', ')}`);
}

// ---------------------------------------------------------------------------
// Concluir (encerra o sorteio e expira os botões do anúncio)
// ---------------------------------------------------------------------------
async function createPrivateThread(client, g) {
  const channel = await fetchTextChannel(client, g.channelId);
  const parent = channel?.isThread?.() ? channel.parent : channel;
  if (!parent || parent.type !== ChannelType.GuildText) throw new Error('tópicos privados só funcionam em canais de texto');
  const thread = await parent.threads.create({
    name: `🎁 ${g.name}`.slice(0, 100), type: ChannelType.PrivateThread, invitable: false,
    autoArchiveDuration: 10080, reason: `Sorteio "${g.name}" concluído`,
  });
  const failed = [];
  for (const userId of [...new Set([g.hostId, ...g.winners])].slice(0, 25)) {
    await thread.members.add(userId).catch(() => failed.push(userId));
  }
  await store.setThread(g.id, thread.id).catch(() => {});   // o tópico existe: nunca fica marcado como falho
  let messageSent = true;
  try { await thread.send(msg.buildThreadMessage(g)); } catch (e) { messageSent = false; console.warn('[sorteios] Mensagem do tópico falhou:', e.message); }
  return { thread, failed, messageSent };
}

async function handleConclude(i, id) {
  const g = await loadManaged(i, id);
  if (!g) return undefined;
  await i.deferUpdate();
  const r = await store.concludeTx(i.guildId, id);
  if (r.kind === 'noop') {
    await i.editReply({ ...msg.buildWinnersMessage(g, { final: true }), allowedMentions: NO_PING }).catch(() => {});
    return i.followUp({ content: 'Este sorteio já tinha sido concluído por aqui. ✅', flags: EPHEMERAL });
  }
  if (r.kind !== 'concluded') return i.followUp({ content: `❌ ${line('missing')}`, flags: EPHEMERAL });

  const done = r.giveaway;
  await i.editReply({ ...msg.buildWinnersMessage(done, { final: true, note: `✅ ${line('concluded')}` }), allowedMentions: NO_PING });
  await unpinSafe(i.client, done);
  await refreshPublic(i.client, i.guildId, id);

  return undefined;
}

// ---------------------------------------------------------------------------
// Cancelar (comando /sorteios cancelar)
// ---------------------------------------------------------------------------
async function cancelGiveaway(client, guildId, id) {
  const r = await store.cancelTx(guildId, id, 'cancelled_by_host', ['scheduled', 'active']);
  if (r.kind !== 'cancelled') return r;
  await unpinSafe(client, r.giveaway);
  if (r.giveaway.messageId) await refreshPublic(client, guildId, id);
  return r;
}

module.exports = {
  isAdmin, canManageGiveaway, memberRoleIds, preflight, computeTimes,
  refreshPublic, scheduleRefresh,
  handleJoin, handleLeave, handlePeopleOpen, handlePeoplePage, handleRemove,
  publishGiveaway, drawGiveaway, cancelGiveaway,
  handleRedrawOpen, handleRedrawControl, handleConclude,
  findInvalid, createPrivateThread, checkRewardRoles, applyWinnerRoles, revertWinnerRoles, processDueRoleOps, guildOf,
};
