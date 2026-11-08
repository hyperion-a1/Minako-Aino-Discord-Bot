# Modo Noturno — Minako

## Escopo de atuação

O Modo Noturno não bloqueia mais o servidor inteiro por padrão. O administrador define pelo `/minako-configurar`:

1. **Categorias afetadas** — todos os canais utilizáveis dentro dessas categorias entram no escopo;
2. **Canais diretamente afetados** — canais específicos fora ou dentro dessas categorias também podem ser escolhidos;
3. **Canais imunes** — sempre prevalecem sobre as duas escolhas anteriores.

Se um canal aparecer simultaneamente como afetado e imune, o painel mostra um aviso e a imunidade vence.

A Minako calcula o escopo a cada ciclo. Assim, um novo canal criado dentro de uma categoria afetada também será considerado no próximo ciclo do scheduler.

## O que foi adicionado

- Modo Noturno automático configurável pelo `/minako-configurar`.
- Horário de início e fim configurável em `HH:MM`.
- Ativação/desativação sem reiniciar a Minako.
- Canais de aviso configuráveis separadamente do escopo de bloqueio (até 25 pela interface de seleção do Discord).
- Link obrigatório do aviso principal do servidor quando o modo estiver ativado.
- Quatro avisos amigáveis:
  - 30 minutos antes do início;
  - na ativação;
  - 30 minutos antes do fim;
  - na desativação.
- Na mensagem de ativação, o horário de encerramento aparece em uma linha discreta.
- Persistência no PostgreSQL para evitar avisos duplicados e recuperar o estado após reinício.
- Preservação dos overwrites existentes do `@everyone`; ao terminar, a Minako restaura exatamente o que havia antes do bloqueio.
- Se o administrador alterar o escopo enquanto o Modo Noturno estiver ativo, a Minako restaura o escopo anterior e aplica o novo conjunto com segurança.
- Migração automática das configurações antigas: os antigos 3 canais de teste são preservados como escopo inicial, sem repetir essa migração depois que a nova configuração for salva.
- Testes automatizados de horários normais, virada de meia-noite, transições, idempotência, categorias, imunidades e reconfiguração durante o período ativo.

## Permissões necessárias

A Minako precisa de **Gerenciar Canais** para aplicar os overwrites e de **Ver Canal + Enviar Mensagens** nos canais escolhidos para os avisos.

A implementação altera o overwrite do `@everyone`. Se algum cargo de membro tiver um **allow explícito** para essas permissões no canal, esse cargo pode continuar tendo a capacidade de falar; isso é uma característica da hierarquia de permissões do Discord e não é seguro sobrescrever automaticamente todos os cargos do servidor.

## Painel de configuração

O `/minako-configurar` agora abre uma **visão geral** com o estado atual da Minako e um menu de módulos. Cada módulo é configurado em seu próprio painel, reduzindo a quantidade de componentes exibidos de uma vez.

Módulos atuais:

- Semana e ciclo;
- Canais gerais;
- Modo Noturno;
- Personalidade sazonal;
- Cargos.

## Horários configuráveis para testes

Os horários de início e fim são gravados na configuração do servidor e usados diretamente pelo scheduler. O fuso padrão permanece `America/Sao_Paulo`. Ao clicar em **Salvar alterações**, a Minako sincroniza imediatamente o estado atual do Modo Noturno; não é necessário esperar um novo ciclo para iniciar um teste. O scheduler continua verificando a configuração automaticamente a cada 20 segundos.

## Instalação

```bash
cd ~/projetos/'Minako Aino'
unzip -o ~/storage/downloads/Minako_modo_noturno_v7.zip -d .
npm test
npm start
```

Não é necessário `npm run deploy`, pois o nome e a estrutura do comando `/minako-configurar` continuam os mesmos.
