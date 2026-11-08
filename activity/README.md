# Minako Activity — Central Gamer

Estrutura inicial de uma Discord Activity em React + Vite, com backend Node.js/Express e integração com o módulo real de matchmaking da Minako.

## O que já está preparado

- Interface responsiva inicial para a Central de Matchmaking.
- Integração inicial com `@discord/embedded-app-sdk`.
- Fluxo OAuth2: o frontend recebe o código do SDK e o backend troca esse código por um token. O Client Secret nunca é enviado ao navegador.
- Endpoint `/api/central` que valida o token com o Discord e confirma que a pessoa pertence ao servidor solicitado antes de consultar os dados.
- Reutilização dos módulos existentes `utils/db.js`, `utils/matchmaking/store.js`, `schema.js` e `centralView.js` — sem duplicar a lógica de negócio.
- Interface mostra estado vazio de forma explícita; não inventa contagens quando não está conectada.

## Pré-requisitos

- Node.js 20 ou superior (recomendado).
- npm.
- A aplicação Minako criada no Discord Developer Portal.
- Acesso ao Client ID e ao OAuth2 Client Secret dessa aplicação.
- `DATABASE_URL` do PostgreSQL já usado pela Minako, caso queira dados reais.

## Configuração local

1. Copie `.env.example` para `.env` dentro da pasta `activity/`.
2. Preencha `VITE_DISCORD_CLIENT_ID` e `DISCORD_CLIENT_ID` com o Application/Client ID da Minako.
3. Preencha `DISCORD_CLIENT_SECRET` com o OAuth2 Client Secret da aplicação. **Não use o token do bot neste campo.**
4. Copie para `DATABASE_URL` a mesma URL PostgreSQL já usada pela Minako. Não publique nem envie esse segredo em mensagens.
5. Na pasta `activity/`, instale as dependências e inicie os serviços:

   ```bash
   npm install
   npm run dev
   ```

6. O frontend fica em `http://localhost:5173` e a API em `http://localhost:3001`. A interface pode ser visualizada no navegador, mas autenticação e contexto do Discord precisam ser testados dentro do cliente Discord.

## Configuração no Discord Developer Portal

Os nomes exatos das opções podem mudar com a interface do portal. Na aplicação já utilizada pela Minako:

1. Abra **Activities** e habilite a Activity.
2. Configure o URL Mapping de desenvolvimento para apontar o caminho `/` ao endereço público de desenvolvimento (por exemplo, o domínio HTTPS do seu túnel para a porta 5173). O caminho `/api` deve ser encaminhado ao backend ou servido por um proxy; não exponha a API diretamente sem HTTPS.
3. Em OAuth2, configure um Redirect URI permitido para o fluxo de Activity. O guia oficial atual usa `https://127.0.0.1` como placeholder para o fluxo iniciado pelo Embedded App SDK; confirme a configuração exigida no seu portal.
4. Habilite os scopes `identify` e `guilds` usados pelo scaffold.
5. Ative Developer Mode no Discord e teste no servidor de desenvolvimento.

Documentação oficial: https://docs.discord.com/developers/activities/building-an-activity

## Como funciona a autenticação

- O SDK pede autorização dentro do Discord usando `identify` e `guilds`.
- O servidor troca o código OAuth pelo token usando o Client Secret privado.
- O token fica em memória no frontend e é enviado ao endpoint de dados como Bearer token.
- O backend consulta `users/@me` e `users/@me/guilds`, confirma a associação ao servidor e só então lê os dados daquele servidor.
- A Activity recebe contagens agregadas e eventos recentes genéricos; não recebe IDs de outros membros no feed público.

## Integração com o banco da Minako

O servidor da Activity importa os módulos existentes do projeto. Ao iniciar, se `DATABASE_URL` estiver definida, executa `db.initSchema()` e as migrações idempotentes do módulo de matchmaking. Use uma credencial PostgreSQL com permissões apropriadas; para produção, é preferível separar credenciais e limitar privilégios ao necessário.

O endpoint de leitura é somente de consulta. Esta primeira estrutura **não altera disponibilidade, não entra em grupos e não cria partidas**. Essas ações devem ser adicionadas depois, com validação de permissões, proteção contra repetição e transações através dos métodos já existentes no módulo `utils/matchmaking/store.js`.

## Desenvolvimento e publicação

- `npm run check` — verifica sintaxe do servidor.
- `npm run build` — gera o frontend em `activity/dist`.
- `npm start` — serve o frontend compilado e a API na mesma porta, se `NODE_ENV=production` estiver definido.
- Para desenvolvimento local, use um túnel HTTPS para a porta 5173 e configure o URL Mapping do Discord de acordo com a documentação atual.
- Para produção, publique o frontend e a API em endpoints HTTPS. Se forem hospedados separadamente, ajuste o proxy/API base e as regras de segurança; não coloque segredos no bundle do frontend.

## Limitações desta primeira versão

- A Activity ainda não foi habilitada nem publicada no Developer Portal — isso exige acesso à sua conta.
- A configuração OAuth2 e o URL Mapping precisam ser concluídos no portal.
- O fluxo de autenticação só pode ser validado dentro do cliente Discord.
- A primeira versão é de leitura; os botões de matchmaking reais serão conectados em uma etapa posterior.
