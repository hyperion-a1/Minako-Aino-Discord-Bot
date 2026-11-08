const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  MessageFlags,
} = require("discord.js");
const { getMatches, mutateMatches, findMatch, findMatchByMessageId } = require("../utils/matchStore");
const { EMOJIS } = require("../utils/minakoEmojis");
const { getConfig } = require("../utils/config");

function customEmoji(tag) {
  const match = tag.match(/^<(a)?:(\w+):(\d+)>$/);
  return match ? { animated: Boolean(match[1]), name: match[2], id: match[3] } : tag;
}
const {
  LANES,
  LANE_EMOJI,
  LANE_EMOJI_OBJ,
  TEAM_NAMES,
  TEAM_EMOJI_TAG,
  VERSATILE_VALUE,
  getOccupancy,
  countAllocated,
  getUnallocated,
  tryAllocatePlayer,
  backfillWaitlist,
  shuffleAllocate,
} = require("../utils/matchLogic");

const ENTRAR_TIMEOUT = 120_000; // 2 minutos pra escolher as rotas
const SORTEIO_TIMEOUT = 120_000; // 2 minutos pra confirmar/embaralhar/desistir

// Além de Administrador, os cargos escolhidos em /minako-configurar podem
// criar e administrar partidas. A variável antiga continua como fallback para
// instalações que ainda a utilizem, mas a configuração oficial fica no painel.
async function canManageMatches(interaction) {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;

  const config = await getConfig(interaction.guildId);
  const configuredRoleIds = Array.isArray(config.partidaAdminRoleIds) ? config.partidaAdminRoleIds : [];
  if (configuredRoleIds.some(roleId => interaction.member?.roles?.cache?.has(roleId))) return true;

  const legacyRoleId = process.env.PARTIDA_ADMIN_ROLE_ID;
  return Boolean(legacyRoleId && interaction.member?.roles?.cache?.has(legacyRoleId));
}

// Os botões da mensagem de criação levam o messageId embutido no customId
// (um snowflake — só dígitos, então é seguro usar ":" como separador sem
// ambiguidade, mesmo que o nome da partida tenha caracteres especiais).
function buildControlRow(messageId, disabled) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`partida:entrar-btn:${messageId}`)
      .setLabel("Entrar")
      .setEmoji("✅")
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`partida:desistir-btn:${messageId}`)
      .setLabel("Desistir")
      .setEmoji("↩️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    // Sem label de propósito — é o botão de gerenciamento (só pra quem tem
    // permissão; a checagem acontece no clique, já que o Discord não deixa
    // esconder um botão de um público específico). Abre o painel com
    // Adicionar/Remover participante e Concluir (ver runGerenciarFlow).
    new ButtonBuilder()
      .setCustomId(`partida:gerenciar-btn:${messageId}`)
      .setEmoji(customEmoji(EMOJIS.tools))
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );
}

function buildMatchEmbed(match) {
  const occ = getOccupancy(match);
  const totalInscritos = Object.keys(match.players).length;
  const totalAlocados = countAllocated(match);

  const teamField = (teamKey) =>
    LANES.map((lane) => {
      const userId = occ[teamKey][lane];
      return `${LANE_EMOJI[lane]} **${lane}:** ${userId ? `<@${userId}>` : "_livre_"}`;
    }).join("\n");

  return new EmbedBuilder()
    .setTitle(`${EMOJIS.arcoAzul} Partida: ${match.name}`)
    .setColor(0x2b6cb0)
    .setDescription(
      `${EMOJIS.atencao} *A escalação abaixo é provisória — eu ainda posso reorganizar o time até o fechamento.*`
    )
    .addFields(
      { name: `${TEAM_EMOJI_TAG.blue} ${TEAM_NAMES.blue}`, value: teamField("blue"), inline: true },
      { name: `${TEAM_EMOJI_TAG.red} ${TEAM_NAMES.red}`, value: teamField("red"), inline: true }
    )
    .setFooter({
      text: `${totalAlocados}/10 alocados · ${totalInscritos} inscrito(s) no total · Use **Entrar** para participar`,
    });
}

// Texto puro (NÃO embed) — menções dentro de embeds não notificam ninguém,
// e o objetivo aqui é justamente avisar quem foi sorteado.
function buildFinalResultText(match, unallocated, { preview = false } = {}) {
  const occ = getOccupancy(match);
  const teamBlock = (teamKey, label, emojiTag) => {
    const lines = LANES.map(
      (lane) => `${LANE_EMOJI[lane]} **${lane}:** ${occ[teamKey][lane] ? `<@${occ[teamKey][lane]}>` : "_(vago)_"}`
    );
    return `${emojiTag} **${label}**\n${lines.join("\n")}`;
  };

  const parts = [
    preview
      ? `${EMOJIS.analise} **Prévia do resultado — ${match.name}** _(ainda não é definitivo)_`
      : `${EMOJIS.comemorar} **Times formados: ${match.name}**`,
    "",
    teamBlock("blue", TEAM_NAMES.blue, TEAM_EMOJI_TAG.blue),
    "",
    teamBlock("red", TEAM_NAMES.red, TEAM_EMOJI_TAG.red),
  ];

  if (unallocated.length) {
    parts.push("", `${EMOJIS.atencao} **Na reserva** (mais inscritos do que vagas): ${unallocated.map((id) => `<@${id}>`).join(", ")}`);
  }

  return parts.join("\n");
}

async function updatePinnedEmbed(client, match) {
  if (!match.messageId) return;
  try {
    const channel = await client.channels.fetch(match.channelId);
    const message = await channel.messages.fetch(match.messageId);
    // Reaproveita os componentes (botões) já existentes na mensagem em vez
    // de simplesmente omitir o campo — mais à prova de surpresas do que
    // confiar só no comportamento de "edição parcial" da API do Discord.
    await message.edit({ embeds: [buildMatchEmbed(match)], components: message.components });
  } catch (error) {
    console.error(`Não consegui atualizar a embed fixada da partida "${match.name}":`, error);
  }
}

function laneSelectScreen(nomePartida) {
  const select = new StringSelectMenuBuilder()
    .setCustomId("partida:lanes")
    .setPlaceholder("Escolha uma ou mais rotas")
    .setMinValues(1)
    .setMaxValues(LANES.length + 1)
    .addOptions([
      ...LANES.map((lane) => ({ label: lane, value: lane, emoji: LANE_EMOJI_OBJ[lane] })),
      { label: "Qualquer rota (sou versátil)", value: VERSATILE_VALUE, emoji: "🎲" },
    ]);

  return {
    content:
      `${EMOJIS.hok} **Inscrição — ${nomePartida}**\n` +
      `Eba! Escolha a(s) rota(s) que você aceita jogar e eu cuido do resto. ${EMOJIS.fogo}\n\n` +
      `> ${EMOJIS.lampada} Marque **"Qualquer rota"** se topar jogar em **qualquer posição** (versátil).\n` +
      `> -# ${EMOJIS.atencao} **Marcando mais de uma rota específica**, a prioridade segue a ordem do menu:\n` +
      `> -# ${LANE_EMOJI["Rota Superior"]} Superior → ${LANE_EMOJI["Selva"]} Selva → ${LANE_EMOJI["Rota do Meio"]} Meio → ${LANE_EMOJI["Apoio"]} Apoio → ${LANE_EMOJI["Rota Inferior"]} Inferior\n` +
      `> *(o Discord não guarda a ordem em que você clicou, só a ordem do menu)*\n\n` +
      `Prontinho! ${EMOJIS.estrelinha} Agora é só deixar a capitã Minako cuidar da escalação!`,
    embeds: [],
    components: [new ActionRowBuilder().addComponents(select)],
  };
}

function sorteioButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("partida:sorteio:manter").setLabel("Manter resultado").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("partida:sorteio:embaralhar").setLabel("Embaralhar de novo").setEmoji("🔀").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("partida:sorteio:desistir").setLabel("Desistir da partida").setEmoji("🚫").setStyle(ButtonStyle.Danger)
  );
}

function previewScreen(match, unallocated) {
  return {
    content: buildFinalResultText(match, unallocated, { preview: true }),
    embeds: [],
    components: [sorteioButtons()],
  };
}

// ---------------------------------------------------------------------------
// Painel de gerenciamento (botão ⚙️, só admin/cargo liberado) — Adicionar
// participante, Remover participante e Concluir, tudo num único painel
// efêmero que só quem clicou o ⚙️ enxerga.
// ---------------------------------------------------------------------------

function managerButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("partida:painel:ver-rotas")
      .setLabel("Ver escolhas de rota")
      .setEmoji(customEmoji(EMOJIS.lista))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId("partida:painel:adicionar")
      .setLabel("Adicionar participante")
      .setEmoji(customEmoji(EMOJIS.proximo))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("partida:painel:remover")
      .setLabel("Remover participante")
      .setEmoji(customEmoji(EMOJIS.falha))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId("partida:painel:concluir")
      .setLabel("Concluir")
      .setEmoji(customEmoji(EMOJIS.aprovado))
      .setStyle(ButtonStyle.Success)
  );
}

function managerPanelScreen(match) {
  return {
    content: `${EMOJIS.tools} **Painel de gerenciamento — ${match.name}**\nTudo prontinho! O que vamos fazer agora? ✨`,
    embeds: [],
    components: [managerButtons()],
  };
}

function backToPanelButtonRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("partida:painel:voltar")
      .setLabel("Voltar")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Secondary)
  );
}

// Mostra, pra cada inscrito, TODAS as rotas que ele marcou (ou "versátil")
// e o status atual (alocado em tal time/rota, ou lista de espera) — o
// painel público só mostra quem ficou em cada rota depois de alocado, não
// as escolhas originais de quem está esperando ou o que cada um marcou.
function viewChoicesScreen(match) {
  const entries = Object.entries(match.players);
  const body = entries.length
    ? entries
        .map(([userId, p]) => {
          const rotas = p.versatile
            ? "🎲 Qualquer rota (versátil)"
            : p.lanes.map((lane) => `${LANE_EMOJI[lane]} ${lane}`).join(", ");
          const status = p.allocated
            ? `alocado(a) em **${TEAM_NAMES[p.allocated.team]} — ${p.allocated.lane}**`
            : "na lista de espera";
          return `**${p.username}** (<@${userId}>)\n> Escolheu: ${rotas}\n> Status: ${status}`;
        })
        .join("\n\n")
    : "_Ainda não há ninguém inscrito._";

  return {
    content: `${EMOJIS.lista} **Escolhas de rota — ${match.name}**\n\n${body}`,
    embeds: [],
    components: [backToPanelButtonRow()],
  };
}

function addMemberSelectScreen(match) {
  const select = new UserSelectMenuBuilder()
    .setCustomId("partida:add-membros")
    .setPlaceholder("Selecione o(s) membro(s) para adicionar")
    .setMinValues(1)
    .setMaxValues(25);

  return {
    content: `${EMOJIS.novo} **Adicionar participante(s) — ${match.name}**\nQuem você quer colocar nessa aventura? ✨`,
    embeds: [],
    components: [new ActionRowBuilder().addComponents(select)],
  };
}

function addLaneSelectScreen(nomePartida, userIds) {
  const select = new StringSelectMenuBuilder()
    .setCustomId("partida:add-lanes")
    .setPlaceholder("Escolha uma ou mais rotas")
    .setMinValues(1)
    .setMaxValues(LANES.length + 1)
    .addOptions([
      ...LANES.map((lane) => ({ label: lane, value: lane, emoji: LANE_EMOJI_OBJ[lane] })),
      { label: "Qualquer rota (versátil)", value: VERSATILE_VALUE, emoji: "🎲" },
    ]);

  return {
    content:
      `${EMOJIS.novo} **Adicionar participante(s) — ${nomePartida}**\n` +
      `Escolha a(s) rota(s) para: ${userIds.map((id) => `<@${id}>`).join(", ")}\n\n` +
      `> ${EMOJIS.atencao} A mesma escolha de rota(s) vale para todo mundo selecionado. Marcando mais de uma, a prioridade segue:\n` +
      `> ${LANE_EMOJI["Rota Superior"]} Superior → ${LANE_EMOJI["Selva"]} Selva → ${LANE_EMOJI["Rota do Meio"]} Meio → ${LANE_EMOJI["Apoio"]} Apoio → ${LANE_EMOJI["Rota Inferior"]} Inferior`,
    embeds: [],
    components: [new ActionRowBuilder().addComponents(select)],
  };
}

function removeMemberSelectScreen(match) {
  const entries = Object.entries(match.players);
  const select = new StringSelectMenuBuilder()
    .setCustomId("partida:remove-membros")
    .setPlaceholder("Selecione o(s) participante(s) para remover")
    .setMinValues(1)
    .setMaxValues(entries.length)
    .addOptions(
      entries.map(([userId, p]) => ({
        label: p.username,
        value: userId,
        description: p.allocated ? `${TEAM_NAMES[p.allocated.team]} — ${p.allocated.lane}` : "Lista de espera",
        emoji: p.allocated ? LANE_EMOJI_OBJ[p.allocated.lane] : undefined,
      }))
    );

  return {
    content: `➖ **Remover participante(s) — ${match.name}**\nQuem precisa sair desta rodada?`,
    embeds: [],
    components: [new ActionRowBuilder().addComponents(select)],
  };
}

// ---------------------------------------------------------------------------
// Fluxos compartilhados (chamados tanto pelos subcomandos quanto pelos botões)
// ---------------------------------------------------------------------------

async function runEntrarFlow(interaction, match) {
  if (match.players[interaction.user.id]) {
    return interaction.reply({
      content: `Você já está nessa partida, querido(a)! ${EMOJIS.estrelinha}`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (Object.keys(match.players).length >= 10) {
    return interaction.reply({
      content: `Ops! A partida **${match.name}** já chegou a 10/10. ${EMOJIS.comemorar}`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.reply({ ...laneSelectScreen(match.name), flags: MessageFlags.Ephemeral });
  const panelMessage = await interaction.fetchReply();

  let ci;
  try {
    ci = await panelMessage.awaitMessageComponent({
      filter: (i) => i.user.id === interaction.user.id,
      time: ENTRAR_TIMEOUT,
    });
  } catch {
    return interaction
      .editReply({
        content: '⏱️ Tempo esgotado, inscrição cancelada. Clique de novo em "Entrar" se quiser tentar outra vez.',
        embeds: [],
        components: [],
      })
      .catch(() => {});
  }

  // Reconhece a interação do menu antes de ler/gravar dados. O prazo do
  // Discord é curto; deferUpdate evita que o processamento da inscrição
  // expire e impeça a atualização do painel público.
  try {
    await ci.deferUpdate();
  } catch (error) {
    console.error(`[partida] Não consegui reconhecer a seleção de rota (${match.name}):`, error);
    return;
  }

  const finishSelection = async (payload) => ci.editReply(payload).catch((error) => {
    console.error(`[partida] Não consegui atualizar a resposta da inscrição (${match.name}):`, error);
  });

  try {
    const versatile = ci.values.includes(VERSATILE_VALUE);
    const lanes = LANES.filter((lane) => ci.values.includes(lane));

    // Relê o estado após a escolha, pois a partida pode ter mudado enquanto
    // o membro escolhia as rotas. Não substitui nem recria a partida.
    const mutation = await mutateMatches((draft) => {
      const current = findMatch(draft, match.name);
      if (!current) return { status: 'missing' };
      if (current.players[interaction.user.id]) return { status: 'duplicate' };
      if (Object.keys(current.players).length >= 10) return { status: 'full' };
      current.players[interaction.user.id] = {
        username: interaction.user.username,
        lanes,
        versatile,
        allocated: null,
      };
      tryAllocatePlayer(current, interaction.user.id);
      return { status: 'added', match: current };
    });
    const status = mutation.result?.status;
    const freshMatch = mutation.result?.match;
    if (status === 'missing') return finishSelection({ content: `${EMOJIS.falha} A partida **${match.name}** não existe mais — talvez ela já tenha sido encerrada.`, embeds: [], components: [] });
    if (status === 'duplicate') return finishSelection({ content: `Você já está nessa partida, ${interaction.user.username}! ${EMOJIS.estrelinha}`, embeds: [], components: [] });
    if (status === 'full') return finishSelection({ content: `${EMOJIS.atencao} A partida **${match.name}** já chegou a 10/10. Agora só a torcida! ✨`, embeds: [], components: [] });

    const allocated = freshMatch.players[interaction.user.id].allocated;
    const allocText = allocated
      ? `Você foi alocado em **${TEAM_NAMES[allocated.team]} — ${allocated.lane}**.`
      : "Nenhuma das rotas que você escolheu está livre no momento — você fica na lista de espera.";

    // Atualiza a resposta privada e o painel público de forma independente:
    // uma falha ao editar a resposta efêmera não deve impedir o refresh público.
    await finishSelection({
      content:
        `${EMOJIS.aprovado} **Inscrição confirmada em ${freshMatch.name}!**\n${allocText}\n\n*${EMOJIS.estrelinha} Ainda é uma escalação provisória; no fechamento eu posso reorganizar tudo para equilibrar os times.*`,
      embeds: [],
      components: [],
    });

    await updatePinnedEmbed(interaction.client, freshMatch);
  } catch (error) {
    console.error(`[partida] Falha ao processar inscrição em "${match.name}":`, error);
    await finishSelection({
      content: `${EMOJIS.falha} Não consegui concluir sua inscrição agora. Confira se ela aparece no painel da partida; se não aparecer, tente novamente ou avise a staff.`,
      embeds: [],
      components: [],
    });
  }
}

async function runDesistirFlow(interaction, match) {
  const mutation = await mutateMatches((draft) => {
    const current = findMatch(draft, match.name);
    if (!current || !current.players[interaction.user.id]) return { status: 'not-joined' };
    delete current.players[interaction.user.id];
    backfillWaitlist(current);
    return { status: 'removed', match: current };
  });
  if (mutation.result.status !== 'removed') {
    return interaction.reply({
      content: `${EMOJIS.atencao} Você não está inscrito em **${match.name}**. Se quiser participar, é só clicar em **Entrar**!`,
      flags: MessageFlags.Ephemeral,
    });
  }
  const freshMatch = mutation.result.match;
  await updatePinnedEmbed(interaction.client, freshMatch);
  return interaction.reply({
    content: `Tudo certo! Você saiu de **${freshMatch.name}**. ${EMOJIS.retorno} Se mudar de ideia, a Minako te recebe de volta!`,
    flags: MessageFlags.Ephemeral,
  });
}

// Abre o painel de gerenciamento (ephemeral, só quem clicou o ⚙️ vê) e
// roteia pro pra ação escolhida. "Ver escolhas de rota" e "Voltar" só
// trocam o conteúdo do próprio painel (não é destrutivo, então fica num
// loop); Adicionar/Remover/Concluir são fluxos de tiro único — escolheu,
// segue até o fim (sem voltar pro painel depois).
async function runGerenciarFlow(interaction, match) {
  await interaction.reply({ ...managerPanelScreen(match), flags: MessageFlags.Ephemeral });
  const panelMessage = await interaction.fetchReply();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let ci;
    try {
      ci = await panelMessage.awaitMessageComponent({
        filter: (i) => i.user.id === interaction.user.id,
        time: SORTEIO_TIMEOUT,
      });
    } catch {
      return interaction
        .editReply({ content: "⏱️ Tempo esgotado.", embeds: [], components: [] })
        .catch(() => {});
    }

    if (ci.customId === "partida:painel:ver-rotas") {
      const freshMatch = findMatch(getMatches(), match.name) ?? match;
      await ci.update(viewChoicesScreen(freshMatch));
      continue;
    }

    if (ci.customId === "partida:painel:voltar") {
      const freshMatch = findMatch(getMatches(), match.name) ?? match;
      await ci.update(managerPanelScreen(freshMatch));
      continue;
    }

    if (ci.customId === "partida:painel:concluir") {
      const freshMatch = findMatch(getMatches(), match.name);
      if (!freshMatch) {
        return ci.update({ content: `${EMOJIS.falha} A partida **${match.name}** não existe mais.`, embeds: [], components: [] });
      }
      // `ci` ainda não foi respondido — dá pra passar direto pro fluxo de
      // conclusão, que vai chamar `.reply()` nele normalmente.
      return runConcluirFlow(ci, freshMatch);
    }

    if (ci.customId === "partida:painel:adicionar") {
      return runAdicionarFlow(ci, interaction, panelMessage, match);
    }

    if (ci.customId === "partida:painel:remover") {
      return runRemoverFlow(ci, interaction, panelMessage, match);
    }
  }
}

// `ci` = clique em "Adicionar participante" dentro do painel; `ownerInteraction`
// = interação original do ⚙️ (usada só pra filtro de usuário e pro editReply
// de timeout, já que ela é quem "dona" da mensagem efêmera do painel).
async function runAdicionarFlow(ci, ownerInteraction, panelMessage, match) {
  await ci.update(addMemberSelectScreen(match));

  let selCi;
  try {
    selCi = await panelMessage.awaitMessageComponent({
      filter: (i) => i.user.id === ownerInteraction.user.id,
      time: ENTRAR_TIMEOUT,
    });
  } catch {
    return ownerInteraction
      .editReply({ content: "⏱️ Tempo esgotado, ninguém foi adicionado.", embeds: [], components: [] })
      .catch(() => {});
  }

  const freshMatches = getMatches();
  const freshMatch = findMatch(freshMatches, match.name);
  if (!freshMatch) {
    return selCi.update({ content: `${EMOJIS.falha} A partida **${match.name}** não existe mais.`, embeds: [], components: [] });
  }

  const selectedIds = selCi.values;
  const already = selectedIds.filter((id) => freshMatch.players[id]);
  const candidates = selectedIds.filter((id) => !freshMatch.players[id]);
  const availableSlots = Math.max(0, 10 - Object.keys(freshMatch.players).length);
  const addable = candidates.slice(0, availableSlots);
  const overflow = candidates.slice(availableSlots);

  if (addable.length === 0) {
    const lines = ["Nenhum membro pôde ser adicionado."];
    if (already.length) lines.push(`⚠️ Já inscrito(s): ${already.map((id) => `<@${id}>`).join(", ")}`);
    if (overflow.length) lines.push(`⚠️ Partida lotada, não coube: ${overflow.map((id) => `<@${id}>`).join(", ")}`);
    return selCi.update({ content: lines.join("\n"), embeds: [], components: [] });
  }

  await selCi.update(addLaneSelectScreen(match.name, addable));

  let laneCi;
  try {
    laneCi = await panelMessage.awaitMessageComponent({
      filter: (i) => i.user.id === ownerInteraction.user.id,
      time: ENTRAR_TIMEOUT,
    });
  } catch {
    return ownerInteraction
      .editReply({ content: "⏱️ Tempo esgotado, ninguém foi adicionado.", embeds: [], components: [] })
      .catch(() => {});
  }

  const versatile = laneCi.values.includes(VERSATILE_VALUE);
  const lanes = LANES.filter((lane) => laneCi.values.includes(lane));

  const mutation = await mutateMatches((draft) => {
    const current = findMatch(draft, match.name);
    if (!current) return { status: 'missing', added: [] };
    const added = [];
    for (const userId of addable) {
      if (current.players[userId]) continue;
      if (Object.keys(current.players).length >= 10) break;
      current.players[userId] = {
        username: selCi.users.get(userId)?.username ?? userId,
        lanes,
        versatile,
        allocated: null,
      };
      tryAllocatePlayer(current, userId);
      added.push(userId);
    }
    return { status: 'updated', match: current, added };
  });
  const finalMatch = mutation.result.match;
  const added = mutation.result.added;
  if (!finalMatch) return laneCi.update({ content: `${EMOJIS.falha} A partida **${match.name}** não existe mais.`, embeds: [], components: [] });
  await updatePinnedEmbed(ownerInteraction.client, finalMatch);

  const summary = added.length
    ? `✅ Adicionado(s) à partida **${finalMatch.name}**: ${added.map((id) => `<@${id}>`).join(", ")}`
    : "Ninguém foi adicionado (a partida deve ter lotado ou eles já tinham entrado nesse meio-tempo).";

  return laneCi.update({ content: summary, embeds: [], components: [] });
}

// `ci` = clique em "Remover participante" dentro do painel.
async function runRemoverFlow(ci, ownerInteraction, panelMessage, match) {
  const freshMatches = getMatches();
  const freshMatch = findMatch(freshMatches, match.name);
  if (!freshMatch) {
    return ci.update({ content: `${EMOJIS.falha} A partida **${match.name}** não existe mais.`, embeds: [], components: [] });
  }
  if (Object.keys(freshMatch.players).length === 0) {
    return ci.update({ content: "Não há participantes inscritos para remover.", embeds: [], components: [] });
  }

  await ci.update(removeMemberSelectScreen(freshMatch));

  let selCi;
  try {
    selCi = await panelMessage.awaitMessageComponent({
      filter: (i) => i.user.id === ownerInteraction.user.id,
      time: ENTRAR_TIMEOUT,
    });
  } catch {
    return ownerInteraction
      .editReply({ content: "⏱️ Tempo esgotado.", embeds: [], components: [] })
      .catch(() => {});
  }

  const mutation = await mutateMatches((draft) => {
    const current = findMatch(draft, match.name);
    if (!current) return { status: 'missing', removed: [] };
    const removed = [];
    for (const userId of selCi.values) {
      if (current.players[userId]) {
        delete current.players[userId];
        removed.push(userId);
      }
    }
    backfillWaitlist(current);
    return { status: 'updated', match: current, removed };
  });
  const finalMatch = mutation.result.match;
  const removed = mutation.result.removed;
  if (!finalMatch) return selCi.update({ content: `${EMOJIS.falha} A partida **${match.name}** não existe mais.`, embeds: [], components: [] });
  await updatePinnedEmbed(ownerInteraction.client, finalMatch);

  const summary = removed.length
    ? `✅ Removido(s) da partida **${finalMatch.name}**: ${removed.map((id) => `<@${id}>`).join(", ")}`
    : "Ninguém foi removido.";

  return selCi.update({ content: summary, embeds: [], components: [] });
}

// Abre o painel de confirmação (ephemeral, só o admin vê) com uma prévia do
// sorteio, e espera manter/embaralhar/desistir — repetindo até uma decisão
// final. Nada é publicado nem apagado até o admin confirmar.
// Publica o aviso público de cancelamento, atualiza/desafixa a mensagem
// original e apaga os dados da partida. Reaproveitado tanto pelo fluxo
// normal (com inscritos) quanto pelo caso de partida vazia.
async function finalizeCancelamento(client, interactionForFollowUp, match) {
  try {
    const channel = interactionForFollowUp.channel ?? (await client.channels.fetch(match.channelId));
    await channel.send({
      content: `${EMOJIS.atencao} A partida **${match.name}** foi **cancelada** antes do sorteio. Nenhum time foi formado.`,
    });
  } catch (error) {
    console.error(`Não consegui publicar o cancelamento da partida "${match.name}":`, error);
  }

  try {
    if (match.messageId) {
      const channel = await client.channels.fetch(match.channelId);
      const oldMessage = await channel.messages.fetch(match.messageId);
      await oldMessage.unpin().catch(() => {});
      await oldMessage.edit({
        embeds: [
          buildMatchEmbed(match)
            .setTitle(`${EMOJIS.atencao} Partida: ${match.name} (cancelada)`)
            .setDescription(`${EMOJIS.atencao} *Esta partida foi cancelada antes do sorteio.*`)
            .setColor(0xe53e3e),
        ],
        components: [buildControlRow(match.messageId, true)],
      });
    }
  } catch (error) {
    console.error(`Não consegui atualizar/desafixar a mensagem original da partida "${match.name}":`, error);
  }

  await mutateMatches((draft) => {
    const index = draft.findIndex((m) => m.name.toLowerCase() === match.name.toLowerCase());
    if (index >= 0) draft.splice(index, 1);
  });
}

// Caso especial: admin clicou em "Concluir" mas ninguém se inscreveu ainda.
// Não tem o que sortear, então só oferece desistir da partida ou manter
// aberta (não usa a prévia normal, porque não há nada pra pré-visualizar).
async function runConcluirEmptyFlow(interaction, match) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("partida:sorteio:desistir-vazio")
      .setLabel("Desistir da partida")
      .setEmoji("🚫")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId("partida:sorteio:cancelar-vazio")
      .setLabel("Manter partida aberta")
      .setEmoji("◀️")
      .setStyle(ButtonStyle.Secondary)
  );

  await interaction.reply({
    content: `${EMOJIS.lampada} A partida **${match.name}** ainda está sem inscritos. Quer mesmo encerrar a criação dela?`,
    components: [row],
    flags: MessageFlags.Ephemeral,
  });
  const panelMessage = await interaction.fetchReply();

  let ci;
  try {
    ci = await panelMessage.awaitMessageComponent({
      filter: (i) => i.user.id === interaction.user.id,
      time: SORTEIO_TIMEOUT,
    });
  } catch {
    await interaction
      .editReply({ content: `${EMOJIS.relogio} O tempo acabou, mas a partida continua aberta normalmente.`, components: [] })
      .catch(() => {});
    return;
  }

  if (ci.customId === "partida:sorteio:desistir-vazio") {
    await ci.update({ content: `${EMOJIS.atencao} Partida cancelada.`, components: [] });
    await finalizeCancelamento(interaction.client, ci, match);
    return;
  }

  await ci.update({ content: `${EMOJIS.aprovado} Perfeito! A partida continua aberta normalmente.`, components: [] });
}

// Abre o painel de confirmação (ephemeral, só o admin vê). A prévia inicial
// é EXATAMENTE o que já está no painel público (nenhum sorteio é feito só
// por clicar em "Concluir") — só "Embaralhar de novo" de fato roda
// shuffleAllocate. Nada é publicado nem apagado até o admin confirmar.
async function runConcluirFlow(interaction, match) {
  if (Object.keys(match.players).length === 0) {
    return runConcluirEmptyFlow(interaction, match);
  }

  // Trabalha numa cópia em memória — só mexe nos dados de verdade quando o
  // admin confirmar "Manter resultado" ou "Desistir da partida".
  const workingMatch = JSON.parse(JSON.stringify(match));
  let unallocated = getUnallocated(workingMatch); // estado atual, sem sortear nada ainda

  await interaction.reply({ ...previewScreen(workingMatch, unallocated), flags: MessageFlags.Ephemeral });
  const panelMessage = await interaction.fetchReply();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let ci;
    try {
      ci = await panelMessage.awaitMessageComponent({
        filter: (i) => i.user.id === interaction.user.id,
        time: SORTEIO_TIMEOUT,
      });
    } catch {
      await interaction
        .editReply({
          content: `${EMOJIS.relogio} O tempo acabou. Não alterei nada — a partida continua aberta normalmente.`,
          embeds: [],
          components: [],
        })
        .catch(() => {});
      return;
    }

    if (ci.customId === "partida:sorteio:embaralhar") {
      ({ unallocated } = shuffleAllocate(workingMatch));
      await ci.update(previewScreen(workingMatch, unallocated));
      continue;
    }

    if (ci.customId === "partida:sorteio:manter") {
      await ci.update({ content: `${EMOJIS.aprovado} Resultado confirmado! Já vou publicar a escalação...`, embeds: [], components: [] });

      // followUp() numa interação efêmera continua efêmera — o público não
      // veria os times nem os @menções avisariam ninguém. Publica direto no
      // canal da partida.
      try {
        const channel = interaction.channel ?? (await interaction.client.channels.fetch(workingMatch.channelId));
        await channel.send({
          content: buildFinalResultText(workingMatch, unallocated),
          allowedMentions: { parse: ["users"] },
        });
      } catch (error) {
        console.error(`Não consegui publicar o resultado da partida "${workingMatch.name}":`, error);
      }

      try {
        if (workingMatch.messageId) {
          const channel = await interaction.client.channels.fetch(workingMatch.channelId);
          const oldMessage = await channel.messages.fetch(workingMatch.messageId);
          await oldMessage.unpin().catch(() => {});
          await oldMessage.edit({
            embeds: [
              buildMatchEmbed(workingMatch)
                .setTitle(`${EMOJIS.comemorar} Partida: ${workingMatch.name} (concluída e encerrada)`)
                .setDescription(`${EMOJIS.aprovado} *Resultado confirmado. Esta partida está encerrada!*`)
                .setColor(0x718096),
            ],
            components: [buildControlRow(workingMatch.messageId, true)],
          });
        }
      } catch (error) {
        console.error(`Não consegui atualizar/desafixar a mensagem original da partida "${workingMatch.name}":`, error);
      }

      await mutateMatches((draft) => {
        const index = draft.findIndex((m) => m.name.toLowerCase() === workingMatch.name.toLowerCase());
        if (index >= 0) draft.splice(index, 1);
      });
      return;
    }

    if (ci.customId === "partida:sorteio:desistir") {
      await ci.update({ content: `${EMOJIS.atencao} Partida cancelada. Nada foi sorteado nem publicado.`, embeds: [], components: [] });
      await finalizeCancelamento(interaction.client, ci, match);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Subcomandos (/partida criar | entrar | sair | sortear)
// ---------------------------------------------------------------------------

async function handleCriar(interaction) {
  if (!(await canManageMatches(interaction))) {
    return interaction.reply({
      content: `${EMOJIS.falha} Você não tem permissão para criar partidas.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const nome = interaction.options.getString("nome").trim();
  if (!nome) {
    return interaction.reply({ content: "Me dê um nome válido para a partida, chefia! ✨", flags: MessageFlags.Ephemeral });
  }
  const fixarPainel = interaction.options.getBoolean("fixar_painel") ?? true;

  // Verificação antecipada melhora a resposta comum; a garantia real contra
  // duas criações simultâneas fica dentro de mutateMatches, após obter o ID
  // da mensagem pública.
  if (findMatch(getMatches(), nome)) {
    return interaction.reply({
      content: `${EMOJIS.atencao} Já existe uma partida aberta chamada **${nome}**. Vamos escolher outro nome ou esperar essa terminar?`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const match = {
    name: nome,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: null,
    createdBy: interaction.user.id,
    createdAt: Date.now(),
    players: {},
  };

  await interaction.reply({ embeds: [buildMatchEmbed(match)] });
  const sentMessage = await interaction.fetchReply();

  match.messageId = sentMessage.id;
  const creation = await mutateMatches((draft) => {
    if (findMatch(draft, nome)) return { status: 'duplicate' };
    draft.push(match);
    return { status: 'created', match };
  });

  if (creation.result.status === 'duplicate') {
    // Outra criação com o mesmo nome venceu a corrida. Remove o painel
    // recém-publicado para não deixar uma mensagem órfã sem registro.
    await sentMessage.delete().catch((error) => {
      console.error(`[partida] Não consegui remover o painel duplicado de "${nome}":`, error);
    });
    return interaction.followUp({
      content: `${EMOJIS.atencao} Outra pessoa acabou de criar uma partida chamada **${nome}**. Escolha outro nome, por favor!`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (fixarPainel) {
    try {
      await sentMessage.pin();
    } catch (error) {
      console.error(`Não consegui fixar a mensagem da partida "${nome}" (falta permissão "Gerenciar Mensagens"?):`, error);
    }
  }

  // Só agora dá pra montar os botões, porque o customId precisa do ID desta
  // própria mensagem (só existe depois de enviada).
  try {
    await sentMessage.edit({ components: [buildControlRow(match.messageId, false)] });
  } catch (error) {
    console.error(`Não consegui adicionar os botões à partida "${nome}":`, error);
  }
}

async function handleEntrar(interaction) {
  const nome = interaction.options.getString("partida");
  const match = findMatch(getMatches(), nome);
  if (!match) {
    return interaction.reply({
      content: `${EMOJIS.falha} Não encontrei nenhuma partida aberta chamada **${nome}**.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  return runEntrarFlow(interaction, match);
}

async function handleSair(interaction) {
  const nome = interaction.options.getString("partida");
  const match = findMatch(getMatches(), nome);
  if (!match) {
    return interaction.reply({
      content: `${EMOJIS.falha} Não encontrei nenhuma partida aberta chamada **${nome}**.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  return runDesistirFlow(interaction, match);
}

async function handleConcluir(interaction) {
  if (!(await canManageMatches(interaction))) {
    return interaction.reply({ content: `${EMOJIS.falha} Você não tem permissão para concluir partidas.`, flags: MessageFlags.Ephemeral });
  }
  const nome = interaction.options.getString("partida");
  const match = findMatch(getMatches(), nome);
  if (!match) {
    return interaction.reply({
      content: `${EMOJIS.falha} Não encontrei nenhuma partida aberta chamada **${nome}**.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  return runConcluirFlow(interaction, match);
}

// ---------------------------------------------------------------------------
// Botões da mensagem de criação (persistentes — podem ser clicados dias
// depois, então não usam collector; são roteados via index.js).
// ---------------------------------------------------------------------------

async function handleButton(interaction) {
  const [, action, messageId] = interaction.customId.split(":");
  const match = findMatchByMessageId(getMatches(), messageId);

  if (!match) {
    return interaction.reply({
      content: "❌ Essa partida não existe mais (provavelmente já foi concluída ou cancelada).",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === "entrar-btn") return runEntrarFlow(interaction, match);
  if (action === "desistir-btn") return runDesistirFlow(interaction, match);

  // Mantido por compatibilidade com painéis criados antes desta mudança
  // (o botão "Concluir" separado deixou de ser exibido em painéis novos,
  // que agora usam o botão ⚙️ → "Concluir" dentro do painel de gerenciamento).
  if (action === "concluir-btn") {
    if (!(await canManageMatches(interaction))) {
      return interaction.reply({
        content: `${EMOJIS.falha} Você não tem permissão para concluir esta partida.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return runConcluirFlow(interaction, match);
  }

  if (action === "gerenciar-btn") {
    if (!(await canManageMatches(interaction))) {
      return interaction.reply({
        content: `${EMOJIS.falha} Você não tem permissão para gerenciar esta partida.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return runGerenciarFlow(interaction, match);
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("partida")
    .setDescription("A Minako organiza partidas 5x5 de Honor of Kings com muito carinho!")
    .addSubcommand((sc) =>
      sc
        .setName("criar")
        .setDescription("Abre uma nova partida (admin)")
        .addStringOption((o) => o.setName("nome").setDescription("Nome da nova partida").setRequired(true))
        .addBooleanOption((o) =>
          o.setName("fixar_painel").setDescription('Fixar a mensagem da partida no canal? (padrão: sim)').setRequired(false)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("entrar")
        .setDescription("Entre em uma partida com inscrições abertas")
        .addStringOption((o) =>
          o.setName("partida").setDescription("Partida em que você quer entrar").setRequired(true).setAutocomplete(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("sair")
        .setDescription("Saia da sua inscrição em uma partida")
        .addStringOption((o) =>
          o.setName("partida").setDescription("Partida da qual você quer sair").setRequired(true).setAutocomplete(true)
        )
    )
    .addSubcommand((sc) =>
      sc
        .setName("sortear")
        .setDescription("Revisa, embaralha e fecha uma partida (admin)")
        .addStringOption((o) =>
          o.setName("partida").setDescription("Partida a concluir").setRequired(true).setAutocomplete(true)
        )
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused().toLowerCase();
    const matches = getMatches();
    const filtered = matches
      .filter((m) => m.name.toLowerCase().includes(focused))
      .slice(0, 25)
      .map((m) => ({ name: m.name, value: m.name }));
    await interaction.respond(filtered);
  },

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === "criar") return handleCriar(interaction);
    if (sub === "entrar") return handleEntrar(interaction);
    if (sub === "sair") return handleSair(interaction);
    if (sub === "sortear") return handleConcluir(interaction);
  },

  // Usado por index.js para rotear cliques de botão (customId "partida:...").
  handleButton,
};
