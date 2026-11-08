Minako Aino — V3.6 — Publicação Idempotente + Emojis Moderados

Este patch parte da V3.5.

Novidades:
- Adiciona o botão Publicar Quadro à Central de Revisão.
- Publicação usa estado CLOSING para permitir retomada segura em caso de falha.
- Registra publication_message_id no PostgreSQL antes de aplicar recompensas.
- Procura uma publicação já existente no canal para reduzir risco de duplicação após reinício/falha.
- Publicação finaliza a edição como CLOSED somente depois de aplicar as recompensas.
- Concede o cargo Estrela da Semana aos cinco membros do quadro.
- Registra conquistas com proteção de unicidade por membro + conquista.
- Se uma conquista tiver role_id configurado em minako_achievements, tenta conceder esse cargo também.
- Atualiza o rascunho no canal de moderação para indicar que o quadro foi publicado e remove os controles de revisão.
- Modera os emojis dos botões: Ver quadro final usa o emoji de lista; Remover conquista usa o emoji de atenção.

Importante:
- Não adiciona slash commands novos; não é necessário npm run deploy.
- A publicação exige canal de publicação e cargo Estrela da Semana configurados.
- Se uma recompensa falhar, a edição permanece CLOSING para que a publicação possa ser retomada sem criar outra mensagem pública.

Instalação:
cd ~/projetos/'Minako Aino'
unzip -o ~/storage/downloads/minako-v3.6-publicacao-idempotente-emojis-flat.zip -d .
npm start
