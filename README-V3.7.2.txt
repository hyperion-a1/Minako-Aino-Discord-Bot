Minako V3.7.2 — envio verificável do rascunho

Correções:
- /minako-quadro agora usa o mesmo pipeline do scheduler, sem duplicar lógica.
- O comando só informa que o rascunho foi enviado depois de o Discord aceitar a mensagem e a Minako conseguir buscá-la novamente pelo ID.
- O comando retorna um link direto para a mensagem criada/atualizada.
- Validação explícita do canal de moderação e das permissões ViewChannel, SendMessages e EmbedLinks.
- O scheduler registra no log o ID da mensagem e do canal quando envia/atualiza o rascunho.
- Falhas de envio não marcam a semana como SENT_TO_MODERATION.
- O snapshot continua sendo da semana anterior à semana atual; a atividade viva da nova semana não altera o quadro.

Instalação:
cd ~/projetos/'Minako Aino'
unzip -o ~/storage/downloads/minako-v3.7.2-envio-verificavel-flat.zip -d .
npm start

Não é necessário npm run deploy.
