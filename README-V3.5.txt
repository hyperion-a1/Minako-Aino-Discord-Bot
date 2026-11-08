# Minako V3.5 — Central de Revisão + Identidade Visual

Este patch é aplicado sobre a V3.4.

## Entrou
- catálogo central dos emojis oficiais enviados pelo usuário;
- quadros de revisão e prévia pública usando os emojis oficiais;
- falas de revisão mais divertidas e amigáveis, mantendo a identidade da Minako;
- correção do cálculo da semana para espelhar a Ami: segunda-feira 00:00 em America/Sao_Paulo;
- correção completa do Top 5: o moderador pode alterar membro e mensagens em cada posição;
- recalculo de movimento, sequência, sequência máxima, participações, crescimento e retorno após correção;
- botão para remover uma conquista do rascunho;
- proteção contra membro duplicado no Top 5;
- limpeza dos arquivos soltos criados acidentalmente pela V3.3 na raiz do projeto.

## Limpeza da V3.3
A V3.3 antiga continha três arquivos na raiz do ZIP. Eles não pertencem à estrutura do projeto.
Depois de aplicar este patch, execute uma vez:

node scripts/cleanup-v3.3.js

Isso remove somente:
- week.js
- ranking.js
- minako-quadro.js

da raiz do projeto. Os arquivos corretos ficam em `utils/` e `commands/`.

## Instalação
cd ~/projetos/'Minako Aino'
unzip -o ~/storage/downloads/minako-v3.5-central-revisao-emojis-flat.zip -d .
node scripts/cleanup-v3.3.js
npm start

Não é necessário `npm run deploy`: os nomes dos comandos slash não foram alterados.
