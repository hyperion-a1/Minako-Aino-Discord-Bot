const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
for (const name of ['week.js', 'ranking.js', 'minako-quadro.js']) {
  const target = path.join(root, name);
  if (fs.existsSync(target)) fs.rmSync(target, { force: true });
}
console.log('[Minako] Limpeza dos arquivos soltos da V3.3 concluída.');
