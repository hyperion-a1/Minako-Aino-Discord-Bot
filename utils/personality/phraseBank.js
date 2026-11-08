const E = Object.freeze({
  alerta: '<:s_alerta:1433865932392103956>',
  lampada: '<:sLampadaBulb:1535760149497520259>',
  relogio: '<:s_relogio:1530600778631352611>',
  lua: '<:s_starry_moon:1399781752704336042>',
  bastao: '<:s_moonlight_rod:1399782103645683843>',
  brilho: '<a:sa_estrela_brilho:1438631984237772830>',
  estrelinha: '<a:sa_estrelinha:1432444239467380858>',
  comemorar: '<a:sa_comemorar:1433498800319758456>',
  foguete: '<a:sa_foguete:1438632341235830804>',
  sino: '<a:sa_sino_animado:1425994614908780545>',
  shine: '<a:sa99_shine:1413414940408152127>',
  retorno: '<:s_estrelaRetorno:1518657572859678782>',
  fogo: '<:s_fogo:1485680995721281597>',
  fogoAzul: '<:s_fogoAzul:1500901034476835007>',
  luna: '<:s_luna_sticker:1399781963820306482>',
  aprovado: '<:s_aprovado:1415427639900110991>',
  coracao: '<a:sa_coracao_laranjado:1438632662758719781>',
  top1: '<a:sa_top1:1470448900832755762>',
});

// 40 falas: 10 para cada evento. Halloween está marcado como pacote sazonal.
// {apelido} é substituído pelo apelido Discord sem mencionar/pingar a pessoa.
const PHRASES = [
  // 30 min antes da ativação
  { id:'night-start-warning-01', event:'start-warning', seasonalPackage:null, text:`${E.relogio} Faltam **30 minutinhos** para o Modo Noturno. Quem ainda estiver por aqui, aproveite a reta final — depois até a Lua vai pedir silêncio. ${E.brilho}` },
  { id:'night-start-warning-02', event:'start-warning', seasonalPackage:null, text:`${E.shine} Avisinho luminoso: daqui a **30 minutos**, o Modo Noturno começa. Se você estava pensando em fazer “só mais uma coisinha”... eu conheço essa história. 👀` },
  { id:'night-start-warning-03', event:'start-warning', seasonalPackage:'halloween', text:`${E.alerta} **30 minutos para o Modo Noturno.** Hora de terminar o que estiver fazendo, guardar a capa de vampiro e fingir que amanhã você vai dormir cedo. 🎃` },
  { id:'night-start-warning-04', event:'start-warning', seasonalPackage:null, text:`${E.lampada} Pequeno lembrete antes da noite chegar: faltam **30 minutos**. Se alguém precisar resolver alguma coisa por aqui, *agora é uma boa hora*. Depois eu viro fiscal do soninho. ${E.brilho}` },
  { id:'night-start-warning-05', event:'start-warning', seasonalPackage:null, text:`${E.retorno} **{apelido}**, eu vi você por aqui... não adianta tentar desaparecer na sombra. 👀 Faltam **30 minutos** para o Modo Noturno. Aproveite enquanto ainda está tudo aberto! ${E.lua}` , usesNickname:true},
  { id:'night-start-warning-06', event:'start-warning', seasonalPackage:'halloween', text:`${E.luna} Se você ouvir um “boo!” daqui a pouco, provavelmente é só o Halloween lembrando que faltam **30 minutos** para a noite. Prometo que o fantasma não tem cargo de moderador. 🎃` },
  { id:'night-start-warning-07', event:'start-warning', seasonalPackage:null, text:`${E.sino} Última chamada antes do silêncio: faltam **30 minutos**. Resolva o que precisar, pegue sua água e depois pode ir de boa descansar. ✨` },
  { id:'night-start-warning-08', event:'start-warning', seasonalPackage:null, text:`${E.foguete} **Daqui a 30 minutos**, eu fecho as portinhas por aqui. Se tinha uma mensagem importante para mandar, essa é a hora — não deixa pra depois, visse?` },
  { id:'night-start-warning-09', event:'start-warning', seasonalPackage:'halloween', text:`${E.alerta} Faltam **30 minutos**. Os morcegos já estão fazendo check-in e eu só estou esperando o relógio colaborar. 🎃🦇` },
  { id:'night-start-warning-10', event:'start-warning', seasonalPackage:null, text:`${E.brilho} O relógio avisou e eu vim avisar também: **30 minutos** para o Modo Noturno. Se a conversa estiver boa, aproveitem o último capítulo antes do intervalo. ${E.lua}` },

  // Ativação
  { id:'night-start-01', event:'start', seasonalPackage:null, text:`${E.lua} **Modo Noturno ativado!** A noite chegou, as portas foram fechadas e até os morcegos receberam autorização para circular. Durmam bem, estrelas. ${E.brilho}` },
  { id:'night-start-02', event:'start', seasonalPackage:null, text:`${E.bastao} **Modo Noturno: ON.** A biblioteca entrou em modo silencioso. Quem continuar acordado por aqui, por favor, não conte para a Lua. ${E.lua}` },
  { id:'night-start-03', event:'start', seasonalPackage:'halloween', text:`${E.luna} Chegou a hora. **O Modo Noturno está ativo.** As conversas vão descansar um pouquinho — e o Halloween agradece a oportunidade de deixar alguns fantasmas fazendo plantão. 🎃` },
  { id:'night-start-04', event:'start', seasonalPackage:null, text:`${E.fogoAzul} **Modo Noturno ativado.** Podem guardar as espadas, desligar os motores e recolher os morcegos. O expediente da madrugada foi oficialmente encerrado.` },
  { id:'night-start-05', event:'start', seasonalPackage:null, text:`${E.sino} **{apelido}**, se você ainda estiver por aqui... este é o seu sinal para ir descansar. 😌 **Modo Noturno ativado.** Até amanhã!`, usesNickname:true },
  { id:'night-start-06', event:'start', seasonalPackage:'halloween', text:`${E.fogo} **Modo Noturno ativado!** Portas fechadas, luzes baixas e nenhum vampiro autorizado a pedir “só mais uma partida”. 🎃` },
  { id:'night-start-07', event:'start', seasonalPackage:null, text:`${E.estrelinha} **Modo Noturno ativado.** A Minako assumiu o turno da noite. Vocês podem descansar tranquilos — eu fico de olho por aqui. ✨` },
  { id:'night-start-08', event:'start', seasonalPackage:null, text:`${E.aprovado} **Tudo certo: Modo Noturno ativado.** Agora é hora de deixar as conversas dormirem um pouquinho. Amanhã elas voltam novinhas em folha.` },
  { id:'night-start-09', event:'start', seasonalPackage:'halloween', text:`${E.lua} **Modo Noturno ativado!** A lua subiu, os fantasmas saíram e eu já deixei o café imaginário preparado para o plantão. 🎃☕` },
  { id:'night-start-10', event:'start', seasonalPackage:null, text:`${E.coracao} Pronto, estrelas: **o Modo Noturno começou**. Fechamos as janelas por algumas horas e deixamos a madrugada respirar. Boa noite!` },

  // 30 min antes da desativação
  { id:'night-end-warning-01', event:'end-warning', seasonalPackage:null, text:`${E.relogio} Bom dia, criaturas da madrugada! Faltam **30 minutos** para o Modo Noturno acabar. Preparem-se: daqui a pouco as portas se abrem novamente. ${E.brilho}` },
  { id:'night-end-warning-02', event:'end-warning', seasonalPackage:null, text:`${E.foguete} **30 minutos para o despertar!** Se você passou a noite acordado, meus parabéns. Se não passou... finja que não viu esta mensagem. 😌` },
  { id:'night-end-warning-03', event:'end-warning', seasonalPackage:'halloween', text:`${E.shine} Atenção, sobreviventes da madrugada: faltam **30 minutos** para o servidor voltar ao expediente normal. O sol já está a caminho — os fantasmas podem ir dormir. 🎃` },
  { id:'night-end-warning-04', event:'end-warning', seasonalPackage:null, text:`${E.luna} A Lua já está preparando a saída de cena. Faltam **30 minutos** para o Modo Noturno terminar — espero que ninguém tenha feito amizade demais com um fantasma. 🌙` },
  { id:'night-end-warning-05', event:'end-warning', seasonalPackage:null, text:`${E.relogio} **{apelido}**, você ainda está acordado? Eu respeito a dedicação. Só mais **30 minutos** e o Modo Noturno termina. Depois disso, oficialmente não fui eu que mandei você dormir.`, usesNickname:true },
  { id:'night-end-warning-06', event:'end-warning', seasonalPackage:'halloween', text:`${E.sino} O feitiço está quase acabando: faltam **30 minutos**. Aproveite para se despedir dos morcegos antes que eles batam o ponto e vão embora. 🎃🦇` },
  { id:'night-end-warning-07', event:'end-warning', seasonalPackage:null, text:`${E.brilho} Faltam **30 minutos** para a abertura. Já pode separar o café, alongar os dedos e preparar aquela mensagem que ficou esperando a manhã chegar. ✨` },
  { id:'night-end-warning-08', event:'end-warning', seasonalPackage:null, text:`${E.lampada} **Últimos 30 minutos de silêncio.** Depois disso, as conversas voltam a florescer. E sim, eu também vou fingir que ninguém ficou acordado até aqui.` },
  { id:'night-end-warning-09', event:'end-warning', seasonalPackage:null, text:`${E.retorno} A madrugada está dando tchau. Faltam **30 minutos** para o Modo Noturno acabar — vai se preparando, meu povo.` },
  { id:'night-end-warning-10', event:'end-warning', seasonalPackage:'halloween', text:`${E.alerta} Faltam **30 minutos** para abrir as portas. Se algum fantasma estiver confortável demais por aqui, avisa que a gente manda ele embora junto com o Halloween. 🎃` },

  // Desativação
  { id:'night-end-01', event:'end', seasonalPackage:null, text:`${E.comemorar} **Modo Noturno encerrado!** As portas estão abertas novamente. Bom dia, boa tarde ou boa sorte para quem ainda nem foi dormir. 😌✨` },
  { id:'night-end-02', event:'end', seasonalPackage:null, text:`${E.brilho} **A noite acabou!** O servidor está oficialmente acordado outra vez. Podem voltar — mas tentem não trazer um vampiro junto.` },
  { id:'night-end-03', event:'end', seasonalPackage:'halloween', text:`${E.aprovado} **Modo Noturno desativado com sucesso.** Permissões restauradas, portas abertas e nenhum morcego ficou preso no servidor. Considero isso uma vitória. 🎃🦇` },
  { id:'night-end-04', event:'end', seasonalPackage:null, text:`${E.fogo} **E o sol venceu mais uma vez.** ☀️ O Modo Noturno terminou e o servidor está liberado novamente. Agora sim: bom dia, minha gente!` },
  { id:'night-end-05', event:'end', seasonalPackage:null, text:`${E.top1} **{apelido}**, você sobreviveu à madrugada! O **Modo Noturno terminou** e as portas estão abertas novamente. Agora pode voltar a causar... digo, *participar normalmente*. 😌`, usesNickname:true },
  { id:'night-end-06', event:'end', seasonalPackage:'halloween', text:`${E.sino} **Fim do Modo Noturno!** Os fantasmas podem guardar suas correntes, os morcegos podem voltar para casa e nós podemos abrir as janelas. 🎃` },
  { id:'night-end-07', event:'end', seasonalPackage:null, text:`${E.foguete} **Portas abertas!** O Modo Noturno acabou e a comunidade pode voltar ao movimento normal. Espero que o café esteja forte o bastante. ☕` },
  { id:'night-end-08', event:'end', seasonalPackage:null, text:`${E.coracao} **Modo Noturno encerrado.** Tudo restaurado e pronto para mais um dia de conversa. Vamos com calma — ninguém precisa chegar correndo na primeira mensagem. ✨` },
  { id:'night-end-09', event:'end', seasonalPackage:null, text:`${E.estrelinha} **Bom dia, estrelas!** A pausa terminou, as portas se abriram e a Minako devolveu o palco para vocês. ${E.brilho}` },
  { id:'night-end-10', event:'end', seasonalPackage:'halloween', text:`${E.lua} **O sol venceu o Halloween por mais uma manhã.** 🎃☀️ O Modo Noturno acabou, as permissões foram restauradas e o servidor está livre novamente.` },
];

const EVENTS = new Set(['start-warning','start','end-warning','end']);
if (PHRASES.length !== 40) throw new Error(`Banco de personalidade inválido: esperado 40 falas, encontrado ${PHRASES.length}.`);
if (PHRASES.some(p => !EVENTS.has(p.event))) throw new Error('Banco de personalidade contém evento inválido.');
if (new Set(PHRASES.map(p => p.id)).size !== PHRASES.length) throw new Error('Banco de personalidade contém IDs duplicados.');

module.exports = { E, PHRASES };
