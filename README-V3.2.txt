MINAKO V3.2 — CONFIGURAÇÃO E LIMPEZA

Correções:
- normaliza a configuração PostgreSQL snake_case para o formato usado pelo motor editorial;
- /minako-quadro agora respeita /minako-configurar;
- deploy registra exclusivamente os 3 comandos oficiais;
- limpa comandos globais antigos e substitui integralmente os comandos do GUILD_ID;
- index.js carrega somente os 3 comandos oficiais;
- scripts/cleanup-v2.js remove fisicamente comandos e utilitários legados do histórico automático.

Após extrair o patch, execute:
node scripts/cleanup-v2.js
npm run deploy
npm start

Comandos oficiais:
/minako-configurar
/minako-quadro
/minako-registrar-semana
