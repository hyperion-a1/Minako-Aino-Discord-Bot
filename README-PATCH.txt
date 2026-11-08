Minako matchmaking — correção do painel de perfil

- O painel /minako-match agora é efêmero, preservando elo, disponibilidade e preferências do usuário.
- Corrige o layout Components V2: String Select e botões não compartilham a mesma ActionRow.
- Corrige o botão Voltar, que passa a conseguir reconstruir o painel sem COMPONENT_LAYOUT_WIDTH_EXCEEDED.
- Corrige Fechar: remove a resposta original com deleteReply(), em vez de tentar atualizar para uma mensagem V2 vazia.

Instalação:
cd ~/projetos/'Minako Aino'
unzip -o ~/storage/downloads/Minako_matchmaking_profile_panel_fix_v1.zip -d .
npm start

Não é necessário npm run deploy.
