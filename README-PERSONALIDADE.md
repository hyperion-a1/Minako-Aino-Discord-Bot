# Personality Engine — Minako Aino

## Banco atual

- 40 falas no total.
- 10 para cada evento do Modo Noturno:
  - `start-warning`
  - `start`
  - `end-warning`
  - `end`
- 12 falas marcadas como sazonais do pacote `halloween` (3 por evento).
- Falas com `{apelido}` podem usar o apelido de um membro que apareceu recentemente nos canais configurados, sem mencionar/pingar a pessoa.

## Rotação

O uso é persistido por servidor e semana. A Minako evita repetir uma fala até esgotar as falas elegíveis do ciclo; ao esgotar, inicia uma nova rodada sem repetir imediatamente a última fala.

## Pacotes sazonais globais

A configuração fica em `minako_guilds.seasonal_packages` e é carregada junto da configuração geral do servidor. Atualmente existem:

- `halloween`
- `natal`
- `ano_novo`

Desativar um pacote no `/minako-configurar` impede que qualquer módulo que use o Personality Engine selecione falas desse pacote. Assim, a decisão é global e não precisa ser repetida em `/partida`, `/perfil-match` ou módulos futuros.

## Extensão futura

Para adicionar um pacote novo:

1. Registrar o ID e o rótulo em `utils/personality/seasonal.js`.
2. Adicionar as falas com `seasonalPackage: '<id>'` no `phraseBank.js`.
3. Adicionar a opção ao seletor do `/minako-configurar`.
4. Módulos que gerarem mensagens via Personality Engine devem filtrar pelo pacote através de `isSeasonalPackageEnabled`/`availablePhrases`.
