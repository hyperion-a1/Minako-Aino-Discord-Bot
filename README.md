# Patch — /partida para Minako Aino

Migração do módulo `/partida` da Ami Mizuno para a Minako Aino.

## Incluído
- `/partida criar`
- `/partida entrar`
- `/partida sair`
- `/partida sortear`
- Fluxos de botões persistentes `partida:*`
- Seleção de rotas e alocação 5x5 preservadas
- Painel administrativo para ver rotas, adicionar, remover e concluir
- Personalidade da Minako aplicada às mensagens do módulo
- Emojis do catálogo da Minako usados nas rotas, painéis e estados
- Persistência PostgreSQL em `minako_matches`, com `data/matches.json` como fallback local
- Roteamento do módulo no `index.js` e registro em `deploy-commands.js`
- `/minako-configurar` agora abre um painel administrativo em Components V2
- Cargos autorizados a administrar partidas configuráveis pelo painel
- Argumentos opcionais de `/minako-configurar` removidos do comando e transferidos para o painel
- Opção de fuso horário removida da configuração

## Instalação no projeto Minako
A partir da raiz do projeto:

```bash
unzip -o ~/storage/downloads/Minako-partida-03-10-2026.zip -d .
npm run deploy
npm start
```

A autorização de partidas é configurada em **/minako-configurar → Cargos → Administradores de partidas**. Administradores do servidor continuam autorizados automaticamente.

## Observação
O patch não importa partidas abertas da Ami Mizuno automaticamente. Ele migra o módulo e sua estrutura de persistência; partidas antigas podem ser migradas separadamente se houver necessidade.
