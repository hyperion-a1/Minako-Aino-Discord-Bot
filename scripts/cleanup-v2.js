const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const obsolete=[
  'commands/minako-importar-historico.js',
  'commands/minako-diagnostico-historico.js',
  'commands/minako-validar-historico.js',
  'utils/historyImporter.js',
  'utils/historyValidator.js',
  'utils/historyDiagnostic.js'
];
for(const rel of obsolete){const target=path.join(root,rel); if(fs.existsSync(target)){fs.unlinkSync(target); console.log(`Removido: ${rel}`);}}
console.log('Limpeza física dos componentes legados concluída.');
