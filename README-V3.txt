Minako V3 — Motor Editorial + Rascunho

Novidades:
- /minako-quadro gera o quadro da semana atual usando os dados vivos da Ami.
- O rascunho é persistido em minako_editorials no PostgreSQL.
- A Minako envia o rascunho ao canal de moderação configurado.
- Botão Conferir Quadro abre revisão privada.
- A revisão permite corrigir as quantidades de mensagens do Top 5.
- A revisão permite adicionar manualmente as três conquistas definidas:
  Estrela em Ascensão, Estreia Dominante e Estrela da Harmonia.
- A revisão permite atualizar a visualização e abrir uma prévia da publicação.
- Ainda NÃO publica o quadro e NÃO aplica cargos/recompensas.
- A publicação definitiva e recompensas ficam para a próxima etapa.

Instalação:
cd ~/projetos/'Minako Aino'
unzip -o ~/storage/downloads/minako-v3-motor-editorial-rascunho-flat.zip -d .
npm run deploy
npm start

Requisitos já existentes:
- MINAKO_TOKEN
- CLIENT_ID
- GUILD_ID
- DATABASE_URL
- /minako-configurar com canal de moderação e publicação configurados.
