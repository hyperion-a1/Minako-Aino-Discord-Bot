MINAKO — PATCH 04 · PAINEL DE CONFIGURAÇÕES E ANÚNCIO MANUAL DE LIVE

O QUE FOI ADICIONADO
- /tiktok painel: painel administrativo para canal, notificações de vídeos,
  anúncios manuais de LIVE, menção individual ao titular e limites operacionais.
- /tiktok anunciar-live id:<ID> link:<URL>: o próprio titular anuncia a LIVE.
- Validação de titularidade, aprovação, conexão OAuth, URL HTTPS oficial do
  TikTok, username correspondente, canal do servidor e permissões do bot.
- Bloqueio de @everyone/@here e allowlist explícita para a única menção opcional
  (o titular da conta).
- Cooldown persistente e atômico por servidor e por conta, com transação SQL
  para impedir disparos concorrentes e repetição de menções.
- Cooldown padrão: 15 minutos por conta e 3 minutos global por servidor.
- Intervalos configuráveis: 5–60 minutos para monitoramento de vídeos;
  300–3600 segundos por conta; 60–1800 segundos global; 1–10 contas.

COMPORTAMENTO IMPORTANTE
- LIVE NÃO é monitorada nem anunciada automaticamente.
- O monitor automático continua verificando somente vídeos publicados.
- A flag legada live_notifications_enabled passa a ficar sempre FALSE. A nova
  configuração live_announcements_enabled controla apenas o comando manual.
- O link aceito é https://www.tiktok.com/@<username>/live (ou domínio sem www),
  sem query string, fragmento ou redirecionamento.
- A Minako valida o formato e o perfil do link, mas não consegue confirmar pela
  Display API que a transmissão está efetivamente ao vivo. O titular deve usar
  o comando somente enquanto a LIVE estiver ativa.

APLICAÇÃO
1. Substitua os arquivos pelos desta versão.
2. Faça deploy dos comandos com: npm run deploy
3. Reinicie a Minako; ensureSchema aplica as migrações automaticamente.
4. Um administrador executa /tiktok painel, escolhe o canal e ativa anúncios
   manuais. A menção ao titular fica desligada por padrão.
5. O titular executa /tiktok anunciar-live com seu ID e link oficial.

NOTA DE SEGURANÇA
O cooldown é reservado antes da tentativa de envio. Se o Discord falhar ao
publicar, o intervalo permanece ativo de propósito para impedir tentativas
repetidas que possam virar spam.
