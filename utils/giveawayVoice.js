'use strict';
// Falas da Minako para o módulo de sorteios.
// Tom: simpática, leve e com uma pitada de humor — sem exagero (no máximo um emoji por fala,
// sem gritaria nem gírias forçadas). Cada evento tem várias variações; a escolha é aleatória,
// evitando repetir a última fala usada no mesmo evento.
const { E } = require('./personality/phraseBank');

const LINES = {
  // ----- participação -----
  joinOk: [
    ({ name }) => `${E.comemorar} Pronto, você está dentro de **${name}**. Boa sorte!`,
    ({ name }) => `${E.aprovado} Inscrição feita em **${name}**. Agora é torcer e esperar a sorte fazer a parte dela.`,
    ({ name }) => `Anotei seu nome em **${name}**. ${E.estrelinha} Que a sorte esteja com você!`,
    ({ name }) => `${E.brilho} Tudo certo, você está concorrendo em **${name}**. Se mudar de ideia, é só sair e voltar enquanto as inscrições estiverem abertas.`,
  ],
  joinCount: [
    ({ count, plural }) => `Agora são **${plural(count, 'participante', 'participantes')}**.`,
    ({ count, plural }) => `Já somos **${plural(count, 'participante', 'participantes')}**.`,
  ],
  leaveOk: [
    () => 'Tudo bem, tirei você da lista. Se bater o arrependimento, a porta continua aberta enquanto durarem as inscrições. 🙂',
    () => 'Você saiu do sorteio. Sem drama — dá para voltar a qualquer momento enquanto estiver aberto.',
    () => 'Pronto, você não está mais participando. Vou guardar seu lugar na memória, só por garantia. 😉',
  ],
  leaveNot: [
    () => 'Você não estava participando deste sorteio, então não tinha nada para tirar.',
    () => 'Não encontrei você na lista desse sorteio. Tudo certo por aqui!',
  ],
  already: [
    () => 'Você já está na lista deste sorteio. Pode ficar tranquilo, não precisa se inscrever duas vezes. 😉',
    () => 'Seu nome já está aqui! Agora é só esperar o resultado.',
    () => 'Já te inscrevi antes, viu? Fica só na torcida. ✨',
  ],
  closed: [
    () => 'Esse sorteio não está mais aceitando inscrições. Fica de olho no próximo!',
    () => 'As inscrições deste sorteio já fecharam. Da próxima você pega! 🙂',
  ],
  full: [
    ({ max }) => `Esse sorteio já chegou ao limite de **${max}** participantes. Chegou um pouquinho tarde dessa vez.`,
    ({ max }) => `As **${max}** vagas já foram preenchidas. Fica de olho nos próximos!`,
  ],
  blockedRole: [
    ({ roles }) => `Você não pode participar deste sorteio porque tem o cargo ${roles}. Não é nada pessoal, é só a regra que o host definiu.`,
    ({ roles }) => `Este sorteio não aceita quem tem o cargo ${roles}. Desculpe, a regra não é minha!`,
  ],
  notAllowed: [
    ({ roles }) => `Este sorteio é só para quem tem ${roles}. Se você acha que deveria ter, fale com a moderação.`,
    ({ roles }) => `Para entrar neste sorteio é preciso ter ${roles}. Quando tiver, é só voltar aqui.`,
  ],
  cooldown: [
    ({ wait }) => `Você ganhou um sorteio recentemente e está em período de pausa — ${wait}. Deixa os outros terem a vez deles também. 😄`,
    ({ wait }) => `Parabéns de novo pelo prêmio! Mas ainda ${wait} para você poder participar outra vez.`,
  ],
  blockedUser: [
    () => 'Você não pode participar deste sorteio. É uma regra definida para ele; se achar que foi engano, fale com a moderação.',
    () => 'Dessa vez você não pode entrar neste sorteio. Se tiver dúvida, a moderação pode explicar melhor.',
  ],
  notAllowedMembers: [
    () => 'Este sorteio é restrito a membros específicos, e você não está na lista. Se achar que deveria estar, fale com a moderação.',
  ],
  rolesProblems: [
    ({ host, name, list }) => `${host}, o sorteio **${name}** foi anunciado, mas não consegui mexer em alguns cargos: ${list}. Um moderador pode ajustar manualmente.`,
  ],
  rolesProblemsRedraw: [
    ({ host, name, list }) => `${host}, no ressorteio de **${name}** houve cargos que não consegui ajustar: ${list}. Um moderador pode resolver manualmente.`,
  ],
  missing: [
    () => 'Não encontrei esse sorteio — talvez ele já tenha sido removido.',
  ],

  // ----- permissões -----
  notHost: [
    () => 'Essa opção é só para o host do sorteio ou para administradores.',
    () => 'Só o host ou um administrador pode mexer nisso, mas obrigada por querer ajudar!',
  ],
  noCreate: [
    () => 'Você ainda não tem permissão para criar sorteios. Peça para um administrador liberar um cargo para isso em `/sorteios cargos`.',
  ],
  lostCreate: [
    () => 'Você não tem mais permissão para criar sorteios, então precisei pausar essa configuração.',
  ],
  sessionExpired: [
    () => 'Essa configuração expirou por inatividade. Use `/sorteios configurar` para começar de novo — prometo que é rápido.',
  ],

  // ----- criação -----
  published: [
    ({ link }) => `Tudo certo, já está no ar! ${link}`,
    ({ link }) => `Publicado! ${E.comemorar} ${link}`,
  ],
  scheduled: [
    ({ when }) => `${E.relogio} Ele será publicado em ${when}. Eu cuido da hora certa, pode deixar comigo.`,
    ({ when }) => `Agendado! Entra no ar em ${when} e eu cuido do resto.`,
  ],

  // ----- resultado -----
  winnersTitleOne: [
    () => 'Temos um ganhador',
    () => 'Resultado do sorteio',
  ],
  winnersTitleMany: [
    () => 'Temos ganhadores',
    () => 'Resultado do sorteio',
  ],
  winnersIntro: [
    () => 'A sorte fez a escolha. Parabéns!',
    () => 'Sorteio feito, tudo limpinho e sem trapaça. Parabéns!',
    () => 'Os números rodaram e o resultado saiu. Parabéns!',
  ],
  redrawOne: [
    ({ name, added, removed }) => `Ressorteio em **${name}**: ${added} entra no lugar de ${removed}. Parabéns!`,
    ({ name, added, removed }) => `Houve uma troca em **${name}**. ${added} assume a vaga de ${removed}. ${E.estrelinha}`,
  ],
  redrawMany: [
    ({ name, added, removed }) => `Ressorteio em **${name}**: ${added} entram no lugar de ${removed}. Parabéns!`,
    ({ name, added, removed }) => `Houve trocas em **${name}**. ${added} assumem as vagas de ${removed}. ${E.estrelinha}`,
  ],
  redrawThreadNote: [
    () => 'O tópico privado não muda sozinho — um moderador precisa ajustar os membros.',
  ],
  concluded: [
    () => 'Sorteio concluído. Obrigada a todo mundo que participou!',
    () => 'Tudo encerrado por aqui. Valeu a todos que entraram!',
  ],
  cancelledMin: [
    ({ name, count, min, host }) => `O sorteio **${name}** foi cancelado: só houve **${count}** participante(s) e o mínimo era **${min}**. Host: ${host}.`,
    ({ name, count, min, host }) => `Não deu dessa vez: **${name}** teve **${count}** participante(s) e precisava de pelo menos **${min}**, então foi cancelado. ${host}, que tal tentar de novo?`,
  ],
  cancelledNone: [
    ({ name, host }) => `O sorteio **${name}** foi cancelado porque não sobrou nenhum participante válido. Host: ${host}.`,
  ],

  // ----- tópico privado -----
  threadPartial: [
    ({ host, thread, failed }) => `${host}, criei o tópico privado ${thread}, mas não consegui adicionar ${failed}. Um moderador pode incluir essas pessoas manualmente.`,
  ],
  threadFail: [
    ({ host, name, reason }) => `${host}, não consegui criar o tópico privado de **${name}** (${reason}). Um moderador pode criá-lo manualmente.`,
  ],
};

const last = new Map();
function line(event, vars = {}) {
  const bank = LINES[event];
  if (!bank?.length) return '';
  let idx = Math.floor(Math.random() * bank.length);
  if (bank.length > 1 && idx === last.get(event)) idx = (idx + 1 + Math.floor(Math.random() * (bank.length - 1))) % bank.length;
  last.set(event, idx);
  return bank[idx](vars);
}

module.exports = { line, LINES };
