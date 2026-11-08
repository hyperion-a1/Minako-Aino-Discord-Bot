MINAKO V3.1 — Correção de configuração e limpeza de comandos históricos

Correções:
- Restaura /minako-configurar no conjunto oficial de comandos da V3.
- /minako-quadro passa a ler a mesma configuração persistida por /minako-configurar.
- deploy-commands.js limpa comandos globais antigos antes de registrar os comandos atuais no servidor, evitando duplicidade (ex.: dois /minako-configurar).
- scripts/cleanup-v2.js remove fisicamente os comandos históricos automáticos da V2 que possam ter permanecido no projeto.

Comandos históricos removidos:
- minako-importar-historico.js
- minako-diagnostico-historico.js
- minako-validar-historico.js

Após instalar:
1. Execute: node scripts/cleanup-v2.js
2. Execute: npm run deploy
3. Execute: npm start

A limpeza é segura: o histórico manual da V2.3/V2.3.1 (/minako-registrar-semana) permanece.
