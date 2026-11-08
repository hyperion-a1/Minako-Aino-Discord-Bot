# Matchmaking da Minako — guia de instalação, operação e validação

Versão da entrega: release 1.1 (fecha pendências da primeira versão) · Briefing: v1.1 · Sem novas dependências (usa discord.js e pg já presentes).

## 1. O que o módulo faz

- **Central** (uma mensagem permanente, editada; conferida na API a cada 60 s e recriada automaticamente se for apagada — o bot não recebe o evento de mensagem apagada, então a conferência é ativa): disponíveis agora, grupos abertos e vagas, propostas em andamento, partidas registradas hoje e nos últimos 7 dias, atividade recente. Estado vazio explícito. Previsão de horário movimentado só aparece com ≥ 14 dias de histórico.
- **Quero jogar agora** (fila): modo, funções e voz → disponibilidade com validade → proposta por DM (Aceitar/Recusar). A equipe só se forma se todos aceitarem. Recusar ou não responder não gera penalidade.
- **Grupos abertos / Criar grupo**: anúncio público, entrada direta ou com aprovação, funções exigidas, faixa de elo, começar incompleto (se o modo permitir), saída com busca de substituto.
- **Tópico privado** por equipe confirmada (um só, criação idempotente), arquivado (nunca apagado) após o prazo.
- **Registro de partida**: conclusão → confirmação/contestação na janela → revisão por cargo de revisor. Silêncio não confirma nem invalida.
- **Minhas preferências** (botão da Central): preferências de jogo (já preenchem "Quero jogar agora"), aviso opcional antes de a disponibilidade expirar e **destino das notificações por categoria** (mensagem privada, tópico do grupo ou não avisar). Se o destino escolhido falhar, o problema aparece ali e a Minako **nunca troca de canal sem autorização**. Mudar notificações não encerra busca nem disponibilidade.
- **Painel** em `/minako-configurar → Matchmaking` e **manutenção** em `/minako-matchmaking` (status, central, backup, encerrar-grupo).

## 1.4 Notificações avançadas (release 1.5)

**Dois tipos de aviso, regras diferentes:**
- **Operacionais** (propostas, pedidos de entrada, decisões, reservas da equipe, convites, lembrete de expiração): ligados a algo que a pessoa iniciou. Chegam **mesmo em pausa ou horário silencioso**; a pessoa escolhe só o destino ou "não avisar".
- **Engajamento** (parceiros e favoritos disponíveis, alerta de atividade da comunidade, resumo de oportunidades): **sempre opt-in (padrão desligado)** e sujeitos a **pausa geral**, **horário silencioso**, limites de frequência e agrupamento.

**Em Minhas preferências → Avisos de engajamento** (fuso de Brasília):
- **Pausa geral** por 1 h, 8 h, 24 h ou 7 dias (volta sozinha; não há pausa infinita esquecida).
- **Horário silencioso** (presets 22–8, 23–7, 0–9 ou personalizado; pode atravessar a meia-noite).
- **Alertas de atividade da comunidade:** mensagem privada quando há bastante gente disponível. Só vai para quem optou e **não está** jogando nem disponível. A administração define o mínimo de pessoas (padrão 6; 0 desliga) e o intervalo entre alertas (padrão 2 h) em `/minako-configurar → Matchmaking → Prazos e busca → Avisos`. Cada pessoa recebe no máximo 1 a cada 6 h e até 40 pessoas por alerta.
- **Resumo de oportunidades:** diário às 19h ou semanal às sextas, 19h. **Nunca é enviado vazio** (só se houver grupos com vaga ou pessoas disponíveis) e no máximo um a cada 12 h por pessoa.
- Limite geral: no máximo **5 avisos de engajamento a cada 24 h** por pessoa, somando todas as categorias.
- **Agrupamento:** parceiros/favoritos que ficam disponíveis quase juntos (janela de 45 s) viram **uma única mensagem**; aviso que ficou velho (mais de 15 min) é descartado, não entregue atrasado.

**Atalhos dentro de cada mensagem de engajamento:** **Ajustar este aviso** (muda o destino daquela categoria direto na DM) e **Pausar avisos por 24 h**. Funcionam sem abrir o servidor e nunca encerram busca ou disponibilidade.

**Mensagens operacionais encerradas quando resolvidas:** ao aprovar/recusar um pedido, decidir uma substituição, responder a uma reserva da equipe ou a um convite, renovar/encerrar a disponibilidade ou quando o grupo é encerrado, as outras mensagens com botões daquela ação perdem os botões e mostram o desfecho. A lista dessas mensagens fica numa tabela transitória (apagada após 14 dias).

**Destino indisponível:** se a DM falhar, o problema aparece em Minhas preferências e **nenhum outro canal é usado sem autorização**.

- **Migração 6** (boot, idempotente, reversível): colunas de horário silencioso, pausa e último resumo em `minako_mm_prefs` (já entram no backup) e tabelas transitórias `minako_mm_op_messages`, `minako_mm_notice_queue`, `minako_mm_alert_state` (não entram no backup).
- **Fora desta release:** alertas de "oportunidade para ajudar jogadores novos", recomendações e notificações de emblemas (dependem das releases seguintes).

## 1.3 Histórico de confiabilidade (release 1.4)

Em **Minhas preferências → Meu histórico** (e `/minako-matchmaking historico`, só administração):
- **O que é registrado** (fatos, um por pessoa/grupo/tipo): entrou num grupo ou sessão; concluiu uma partida; saiu **antes** de a equipe fechar; saiu **depois** de a equipe fechar. **Silêncio, recusa de proposta e "Não posso agora" não são registrados.**
- **O que NÃO existe:** pontuação numérica, ranking, exibição pública e punição automática. Nada disso aparece para outros membros.
- **Quem vê:** a própria pessoa (resumo dos últimos 90 dias + registros recentes) e a administração (nível de manutenção). Cada consulta administrativa fica registrada como evento.
- **Um cancelamento isolado nunca é padrão:** só há "atenção" com ≥ 5 entradas, ≥ 3 saídas tardias e ≥ 40% de saídas tardias; mesmo assim é só um aviso neutro ("sem punição") para a pessoa e a administração. Com poucos dados, o texto diz que não há como falar em padrão.
- **Revisão:** a pessoa pede revisão de um registro (um pedido por registro, até 5 abertos). O registro **sai da conta** enquanto é analisado e a equipe de revisão (canal e cargo configurados) escolhe **Remover** ou **Manter**; a pessoa é avisada. A administração também remove registros comprovadamente incorretos com `/minako-matchmaking registro-remover`. Rejeitar uma partida na revisão remove os registros de "concluiu" dela.
- **Retenção:** registros com mais de 180 dias são apagados automaticamente (limpeza no máximo 1x por hora).
- **Migração 5** (boot, idempotente, reversível): tabela `minako_mm_reliability`. Backup e restauração já incluem a tabela. Falha ao registrar nunca impede a ação principal do usuário.
- Os registros ainda **não influenciam nada** (nem filas nem recomendações). Eles começam a acumular agora para que a release de recomendações possa usá-los de forma discreta e só quando houver dados suficientes.

## 1.2 Equipes e duplas recorrentes (release 1.3)

Pelo botão **Minhas equipes** da Central:
- **Equipes** de 2 a 5 membros (com 2 membros ativos é uma **dupla**). Nome público de 3 a 30 caracteres, sem menções, links ou símbolos especiais; único entre equipes ativas. Limites: até 3 equipes por pessoa e 2 como dono.
- **Convite com aceite**: só o dono convida; o convidado aceita ou recusa (DM, ou em Minhas equipes se a DM estiver fechada). Convite vale 7 dias; recusar não é comunicado ao dono; convite recusado/expirado só se repete após 7 dias.
- **Entrar na equipe não é ficar disponível.** Para jogar, qualquer membro usa **Procurar partida**: escolhe o modo e a entrada de jogadores de fora (com aprovação ou direta). A Minako cria uma **sessão (um grupo comum)** e convida os demais membros, que **confirmam cada sessão** ("Eu vou" / "Não posso agora"). Recusar ou não confirmar não gera penalidade.
- **Só vagas realmente abertas:** a vaga de cada membro convidado fica **reservada** (padrão 10 min, configurável em Prazos e busca). O anúncio mostra só as vagas livres de verdade e quantos membros ainda estão confirmando. Se o membro recusa ou o tempo acaba, a vaga abre ao público e o organizador é avisado.
- **Sem compromissos incompatíveis:** quem já está em outro grupo ativo não é reservado nem consegue confirmar; uma equipe só pode ter uma sessão ativa por vez (garantido por índice único no banco). Se alguém aceitar uma proposta da fila e, nesse meio-tempo, entrar em outro grupo, passa a contar como recusa (sem punição) — correção incluída nesta release.
- **Saída e dissolução:** qualquer membro sai quando quiser; se o dono sai, a liderança passa ao membro ativo mais antigo; o último a sair dissolve a equipe. O dono dissolve (com confirmação) e a moderação pode dissolver com `/minako-matchmaking dissolver-equipe`. Sessões em andamento seguem como grupos.
- **Migração 4** (aplicada no boot; reversível): tabelas `minako_mm_teams` e `minako_mm_team_members`, `team_id` nos grupos, vaga **reservada** nos membros do grupo. Backup e restauração já incluem as tabelas novas (e restauram equipes antes dos grupos).
- A Central ganhou o botão **Minhas equipes** (5 botões); a mensagem é editada uma vez ao subir.

## 1.1 Favoritos e parcerias (release 1.2)

Em **Minhas preferências → Favoritos / Parceiros**:
- **Favoritos** (até 25): lista **privada e unilateral**. Ninguém é avisado de que foi favoritado, e nenhuma tela ou mensagem lista quem favoritou quem.
- **Parceiros recorrentes** (até 10): só existem com **aceite dos dois**. Convite por mensagem privada (vale 7 dias); se a DM estiver fechada, o convite fica salvo e a pessoa aceita em Minhas preferências → Parceiros (sem trocar de canal). Convites cruzados viram parceria na hora. Qualquer parte encerra a qualquer momento, **sem penalidade**; recusa e encerramento não são comunicados à outra pessoa. Convite recusado ou expirado só pode ser refeito após 7 dias.
- **Avisos independentes e opt-in** (padrão: desligados): "parceiro ficou disponível" e "favorito ficou disponível", cada um com seu próprio destino. Quem fica disponível controla **quem pode ser avisado** (padrão: só parceiros; opções: ninguém, ou parceiros e quem o favoritou, sem revelar quem). Limites de frequência: no máximo 1 aviso por pessoa a cada 6 h e 5 por dia. O aviso sai só quando a disponibilidade é **criada**, nunca em renovações.
- A lista de parceiros mostra 🟢 para quem está disponível agora, apenas se a pessoa permite.
- **Migração 3** (aplicada no boot, idempotente e reversível): tabelas `minako_mm_favorites`, `minako_mm_partnerships`, `minako_mm_notice_log` e coluna de visibilidade em `minako_mm_prefs`. Backups e restauração já incluem as tabelas novas (backups antigos continuam válidos).
- Equipes e duplas recorrentes: ver a seção 1.2 (release 1.3).

## 2. Atualização para a release 1.1 (quem já instalou a primeira entrega)

- A release traz a **migração 2** (tabela `minako_mm_prefs` e duas colunas novas). Ela é aplicada sozinha no boot, é idempotente e reversível. Faça o backup do banco antes (`/minako-matchmaking backup` e, se possível, `pg_dump`).
- Extraia o pacote sobre o projeto, rode `npm test`, `node deploy-commands.js` (sem comandos novos, mas mantém o padrão) e reinicie. A mensagem da Central é editada uma vez para trocar o botão "Meu perfil" por "Minhas preferências".
- Também entram nesta release: correção da Central/anúncios apagados (recriação automática), expiração de grupos abertos por inatividade, reconciliação periódica, novos avisos operacionais e composição por vaga.

## 2.1 Instalação do zero (nesta ordem)

1. **Backup do banco** antes de tudo (o PostgreSQL é compartilhado com a Ami Mizuno). Se o plano permitir: `pg_dump "$DATABASE_URL" > backup-antes-matchmaking.sql`.
2. Copie os arquivos desta entrega sobre o projeto (veja `MANIFESTO.txt`: lista de novos, modificados e inalterados).
3. `npm install` (nada novo) e `npm test` (deve terminar sem erro).
4. `node deploy-commands.js` — **atenção:** este script já existente apaga os comandos globais e substitui os do servidor pela lista oficial (comportamento original, mantido). Exige `MINAKO_TOKEN`, `CLIENT_ID` e `GUILD_ID`.
5. Reinicie o bot. No boot, as tabelas `minako_mm_*` são criadas (migração versionada, com trava, em transação). O log mostra `[matchmaking] Módulo pronto.`.
6. Configure o módulo (seção 3). **A Central só aparece depois que um canal for definido.**

## 3. Configuração (`/minako-configurar → Matchmaking`, exige "Gerenciar Servidor")

| Seção | O que ajusta |
|---|---|
| Canais | Central, grupos abertos, canal-pai dos tópicos privados, canal de revisão |
| Papéis | Gestão, moderação, **cargo de revisão**, manutenção |
| Prazos e busca | Proposta (2 min), disponibilidade (120 min), substituto (5 min), confirmação da partida (24 h), arquivamento (3 dias), relaxamento (5 e 10 min), atualização mínima da Central (20 s), **inatividade de grupos abertos (120 min)** |
| Modos e funções | Modos (padrão: Ranqueada, Normal, Casual), tamanho, incompleto, faixa de elo; **composição por vaga** (botão Composição: função fixa ou "livre" por vaga); catálogo de funções (padrão: as 5 rotas) |
| Diagnóstico | Verifica o que falta e as permissões do bot em cada canal |

**Valores informados para a revisão de contestações** (configure no painel; não estão fixos no código):
- Canal de revisão: `1557770673819222137`
- Cargo de revisão: `1244300508034760776`

Elos (ordem): Bronze, Prata, Ouro, Platina, Diamante, Mestre, Grão-Mestre, Mítico, Épico, Lenda.

### Permissões do bot
- Central, grupos, revisão: Ver Canal, Enviar Mensagens.
- Canal-pai dos tópicos: + Criar Tópicos Privados, Enviar Mensagens em Tópicos, Gerenciar Tópicos.
- Não são necessárias novas *intents*.

### Níveis de acesso
Administrador: tudo. Gestão e Moderação: gerenciar/encerrar qualquer grupo. Revisão (e Gestão): resolver contestações. Manutenção (e Gestão): `/minako-matchmaking status|central|backup`. Configurar: "Gerenciar Servidor".

## 4. Operação

- `/minako-matchmaking status` — contagens reais e falhas das últimas 24 h.
- `/minako-matchmaking central` — atualiza ou recria a mensagem da Central.
- `/minako-matchmaking encerrar-grupo id:N` — encerra um grupo sem penalidade.
- `/minako-matchmaking backup` — JSON do servidor (**contém IDs de usuários**; guarde com cuidado).

## 5. Backup, restauração e reversão

- **Restaurar** (substitui só as linhas `minako_mm_*` daquele servidor, em transação):
  - simulação: `node scripts/mm-restore.js --file backup.json --guild <ID>`
  - aplicar: acrescente `--confirm`
- **Reverter o módulo por completo** (remove só tabelas `minako_mm_*`): `node scripts/mm-rollback.js APAGAR-MATCHMAKING`. Faça o backup antes.
- **Reverter o código**: restaure os arquivos modificados a partir do seu backup do projeto (lista no `MANIFESTO.txt`) e rode `node deploy-commands.js`. As tabelas podem ficar; nada existente depende delas.

## 6. O que foi validado e o que NÃO foi

**Validado (testes automatizados, `npm test`):** regras de compatibilidade, relaxamento, estados, expiração, vagas, propostas, registro de partida, painel, permissões, plano de restauração — e os 17 testes que já existiam seguem passando. Os fluxos de Discord foram exercitados com `discord.js` e `pg` **substituídos por stubs**.

**NÃO validado (exige seu ambiente de teste com Discord e PostgreSQL reais):**
as consultas SQL e a concorrência real (duas pessoas disputando a última vaga), o comportamento real da API do Discord (componentes, tópicos, limites de edição), reinício na Shardcloud com propostas pendentes, restauração real.

### Roteiro de validação (servidor e banco de TESTE)
1. Boot limpo: tabelas criadas, log `Módulo pronto`; segundo boot não duplica nada.
2. Painel: configurar canais/papéis/prazos; valor inválido recusado sem gravar; Diagnóstico sem pendências.
3. Central: criada uma vez; apagar a mensagem → recriada uma só; remover permissão do bot → Diagnóstico acusa.
4. Fila: duas contas em "Quero jogar agora" → proposta por DM; aceitar/recusar/ignorar até expirar; DM fechada → proposta aparece em "Quero jogar agora".
5. Última vaga: duas contas clicando "Entrar" ao mesmo tempo → uma entra, a outra recebe aviso; vagas nunca passam da capacidade.
6. Aprovação: pedido não ocupa vaga; aprovar com a vaga já tomada → recusado com aviso.
7. Saída e substituição: sair de grupo confirmado → "procurando substituto"; prazo vence → organizador decide (uma única notificação).
8. Organizador sai → o confirmado mais antigo assume; último a sair → grupo encerrado.
9. Tópico privado: um por grupo; arquivado no prazo (não apagado).
10. Partida: registrar conclusão (idempotente), confirmar, contestar → revisão no canal configurado com ping no cargo; validar/rejeitar.
11. Reinício do bot com propostas, janelas e substituições pendentes → nada se perde nem duplica.
12. Inatividade: criar um grupo e deixá-lo parado além do prazo (reduza para 15 min no painel para testar) → encerrado, anúncio atualizado e aviso ao organizador; um grupo com atividade recente não é encerrado.
13. Backup → alterar dados → restaurar (simulação e `--confirm`).
14. Preferências: escolher "tópico"/"não avisar" e conferir que avisos respeitam; bloquear DMs do bot e conferir o aviso em Minhas preferências (sem troca de canal); ligar o aviso de expiração e renovar pelo botão da DM.
15. Reconciliação: apagar um tópico/anúncio de grupo vivo e esperar ~5 min; com a permissão de tópicos removida e devolvida, o tópico é criado.
16. Composição: definir uma vaga com função fixa e conferir a formação na fila.
17. Migração 2: boot em banco que já tinha a migração 1 (sem perda de dados).
18. Favoritos/parcerias: convite com DM aberta e fechada; aceitar/recusar/expirar (7 dias); convites cruzados; encerrar por qualquer lado; confirmar que favoritar não gera mensagem para a outra pessoa; aviso de disponibilidade com opt-in, visibilidade "ninguém" e limites de frequência (6 h / 5 por dia); migração 3 sobre banco que já tinha a 2.
19. Confiabilidade: sair de um grupo aberto e de um grupo já fechado (registros "cedo"/"tarde"); conferir que recusar proposta, ignorar e "Não posso agora" não geram registro; registrar uma conclusão (um "concluiu" por participante); pedir revisão e conferir que o registro sai da conta; Remover/Manter pela equipe (e o aviso à pessoa); rejeitar uma partida e conferir que os "concluiu" dela somem; consulta administrativa; migração 5 sobre banco que já tinha a 4.
20. Equipes: criar (nome válido/inválido/repetido), convidar com DM aberta e fechada, aceitar/recusar/expirar, sair como dono (liderança passa) e como último (dissolve), dissolver pelo dono e pela moderação.
21. Sessão da equipe: iniciar com 3 membros num modo de 5; só os outros recebem "Eu vou/Não posso"; o anúncio mostra as vagas realmente abertas; membro recusa → vaga abre e o organizador é avisado; tempo esgota → vaga abre; um membro já em outro grupo não é reservado; uma segunda sessão da mesma equipe é recusada.
22. Corrida: dois membros confirmando e dois de fora disputando a última vaga ao mesmo tempo (reserva ativa nunca perde a vaga para quem é de fora).
23. Migração 4 sobre banco que já tinha a 3, e reversão (as reservas pendentes são descartadas).
24. Notificações avançadas: ligar parceiros/favoritos disponíveis e fazer 3 pessoas ficarem disponíveis em menos de 1 min (chega UMA mensagem); pausa geral e horário silencioso (não chegam avisos de engajamento, mas chegam propostas e pedidos); alerta de atividade com o mínimo configurado (e com a pessoa já disponível: não recebe); resumo às 19h (não vazio, uma vez por dia) com DM aberta e fechada; botões "Ajustar este aviso" e "Pausar 24 h" direto na DM; aprovar um pedido pelo painel "Gerenciar" e conferir que a DM antiga do pedido perde os botões; reserva da equipe respondida pelo anúncio encerra a DM; migração 6 sobre banco que já tinha a 5.
25. Testes de regressão: sorteios, `/partida`, `/minako-match`, Modo Noturno, Quadro.

## 7. Decisões e suposições (confira)

Aprovadas por você: prazos padrão; relaxamento em 5/10 min; revisão configurável; fluxo de DM fechada; elos; fila como caminho principal; organizador = primeiro a aceitar; sucessão do organizador pelo confirmado mais antigo.
Minhas suposições (não estavam no briefing): quem recusa uma proposta não é reproposto com a mesma combinação por 30 min; contestação não pune ninguém; registros em revisão não liberam "recompensas" (não existem recompensas na v1).

## 8. Limites conhecidos da v1

- **Grupos abertos expiram por inatividade** (padrão 120 min, configurável de 15 min a 24 h). Qualquer entrada, pedido, aprovação ou saída conta como atividade. O organizador recebe um aviso, sem penalidade. Não há aviso prévio antes de encerrar. Grupos já confirmados não expiram por esse prazo.
- Notificações: só as **operacionais** (propostas, pedidos e decisões, entradas/saídas, equipe completa, encerramentos, aviso de expiração opcional). Notificações de engajamento, horários silenciosos, limites de frequência e resumos ficam para um release futuro, como o briefing prevê.
- DM fechada: a Minako registra o problema, mostra em **Minhas preferências** e a proposta continua visível em **Quero jogar agora**. Não há aviso agregado na Central.
- Equipes: máximo de 5 membros por equipe; a sessão usa o tamanho ideal do modo escolhido. "Busca avançada de vagas" para equipes (recomendações de jogadores para completar) continua no escopo futuro; hoje a equipe completa vagas pelo anúncio e pela fila de grupos abertos.
- Destino "tópico" só funciona quando o grupo já tem tópico; antes disso, o aviso não é enviado (sem desvio para DM).
- **Reconciliação:** a cada ~5 min os grupos vivos são conferidos: tópico que faltou é criado (com permissão) e anúncios apagados são recriados.
- Cada pessoa tem uma disponibilidade por vez (um modo).
- O fuso para "hoje" e para a previsão é `America/Sao_Paulo` (fixo no código).
- **Composição por vaga** (painel → Modos → Composição): vagas com função fixa só aceitam, na fila, quem declarou essa função em "Quero jogar agora". Funções exigidas também valem para grupos criados manualmente.
- "Meu perfil" abre o painel já existente do `/minako-match`.
