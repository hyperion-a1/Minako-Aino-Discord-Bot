Minako V3.4 — Revisão persistente

Mudanças:
- Mantém uma única prévia efêmera durante a revisão; alterações substituem a mesma mensagem.
- Seleção de conquista usa a mesma prévia, sem criar uma nova mensagem efêmera.
- Submissões de modais atualizam a prévia original quando a sessão ainda é editável pelo Discord.
- O botão Atualizar Quadro sincroniza a prévia efêmera com o rascunho persistente no canal de moderação.
- Conquistas passam a ter unicidade por servidor + membro + tipo no PostgreSQL.
- Ao tentar adicionar uma conquista já existente no rascunho ou já concedida anteriormente, a Minako mantém a revisão e informa o moderador de forma amigável.
- O banco deduplica registros antigos de concessões antes de criar a proteção de unicidade.

Arquivos:
- utils/editorialInteraction.js
- utils/db.js

Instalação:
cd ~/projetos/'Minako Aino'
unzip -o ~/storage/downloads/minako-v3.4-revisao-persistente-flat.zip -d .
npm start

Não é necessário npm run deploy: os comandos slash não mudaram nesta versão.
