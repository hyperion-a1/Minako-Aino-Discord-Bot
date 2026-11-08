MINAKO — PATCH V3.8: HISTÓRICO UNIFICADO DO QUADRO

Objetivo
- Fazer os indicadores do Top 5 considerarem também as edições semanais congeladas em minako_weekly_snapshots.
- Manter o histórico manual existente como fonte de legado quando não houver snapshot da mesma semana.
- Quando uma semana possui snapshot e histórico manual, o snapshot é a fonte prioritária, pois representa o quadro congelado daquela edição.

Alterações
- Novo utilitário utils/rankingHistory.js para unificar semanas manuais e snapshots sem duplicar uma edição.
- Novo método db.listActivitySnapshots(guildId).
- utils/ranking.js passa a usar snapshots históricos ao calcular posição anterior, crescimento, sequência, sequência máxima, participações e retorno.
- utils/editorialInteraction.js usa a mesma fonte histórica ao corrigir o Top 5, evitando indicadores divergentes entre prévia e revisão.
- Teste unitário de precedência de snapshot, exclusão da semana em edição e detecção de lacunas.

Segurança
- Não altera nem apaga dados do PostgreSQL.
- Não altera comandos slash nem seus nomes; não precisa executar npm run deploy.
- Não publica quadros nem concede cargos automaticamente por causa deste patch.
- O snapshot da semana em edição é excluído do histórico auxiliar durante o recálculo, para que a correção use o Top 5 atual do rascunho.

Instalação (Termux)
cd ~/projetos/'Minako Aino'
unzip -o ~/storage/downloads/minako-quadro-historico-v3.8.zip -d .
npm test
npm start

Observação
O patch foi validado localmente por testes de lógica e sintaxe. A verificação com os dados reais do PostgreSQL só ocorre quando o bot estiver conectado ao banco de produção.
