Minako Aino — V3.7 — Snapshot + Preparação Noturna

Este patch transforma o ciclo semanal em um pipeline persistente.

REGRAS
- A Ami continua coletando atividade normalmente.
- A Minako captura na segunda-feira 00:00 o snapshot da semana que acabou de terminar, segunda-feira anterior 00:00 até a virada atual, em America/Sao_Paulo.
- Depois do snapshot, o ranking da edição não volta a consultar a atividade viva da Ami.
- O snapshot é imutável; correções posteriores são alterações editoriais explícitas no rascunho.
- Se a Minako estiver fora do ar durante a janela de snapshot, ela recupera o snapshot da semana anterior ao voltar, porque os dados daquela semana já estão encerrados e não podem mais mudar. O horário de corte continua sendo a virada; a captura tardia não altera o conteúdo.

PIPELINE
- 00:00–00:02: captura do snapshot da semana recém-encerrada.
- 00:15 em diante: prepara o editorial a partir do snapshot.
- 06:00 em diante: finaliza a etapa noturna. Esta etapa é o ponto de extensão para GIF e outros trabalhos pesados futuros.
- 07:00 em diante: envia automaticamente o rascunho pronto para o canal de moderação.
- O estado de cada etapa fica no PostgreSQL, permitindo retomada após reinício.

A etapa pesada futura (GIF, mídia etc.) deve ser conectada a finalizeNightWork() em utils/nightlyScheduler.js.

O comando /minako-quadro agora é seguro: ele nunca recalcula o Top 5 vivo. Sem snapshot, ele informa que a preparação da semana ainda não aconteceu.

INSTALAÇÃO
cd ~/projetos/'Minako Aino'
unzip -o ~/storage/downloads/minako-v3.7-snapshot-preparacao-noturna-flat.zip -d .
npm start

Não é necessário npm run deploy. Nenhum comando slash novo foi adicionado.
