MINAKO V2.3 — HISTÓRICO MANUAL

Este patch desativa os comandos de importação/diagnóstico/validação automática de histórico:
- minako-importar-historico
- minako-diagnostico-historico
- minako-validar-historico

Eles deixam de ser carregados e também deixam de ser registrados no Discord na próxima execução de npm run deploy.

Novo comando:
/minako-registrar-semana

O moderador informa:
- semana no formato YYYY-MM-DD (data de início da semana)
- membro1..membro5
- mensagens1..mensagens5

O comando salva a semana como histórico manual e recalcula, usando somente as semanas manuais:
- número total de participações no Top 5
- sequência atual
- sequência máxima
- crescimento percentual quando houver a semana anterior registrada

Os dados antigos marcados como discord_history não são apagados automaticamente. Eles deixam de participar dos cálculos da Minako e permanecem no PostgreSQL apenas como legado, evitando uma exclusão irreversível durante o patch.


V2.3.1 — histórico com usuários ausentes
- Os campos membro1..membro5 aceitam menção (<@ID>) ou ID numérico.
- Isso permite registrar membros que já saíram do servidor, sem depender de um User Option do Discord.
- O bot grava apenas o ID informado; não precisa que o usuário esteja atualmente no servidor.
