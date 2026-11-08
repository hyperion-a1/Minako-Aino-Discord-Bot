require('dotenv').config();
const { REST, Routes } = require('discord.js');

const commands = [
  require('./commands/minako-configurar').data,
  require('./commands/minako-quadro').data,
  require('./commands/minako-registrar-semana').data,
  require('./commands/partida').data,
  require('./commands/minako-match').data,
  require('./commands/sorteios').data,
  require('./commands/minako-matchmaking').data,
  require('./commands/tiktok').data,
].map(command => command.toJSON());

if (!process.env.MINAKO_TOKEN || !process.env.CLIENT_ID || !process.env.GUILD_ID) {
  throw new Error('MINAKO_TOKEN, CLIENT_ID e GUILD_ID são obrigatórios.');
}

const rest = new REST({ version: '10' }).setToken(process.env.MINAKO_TOKEN);

(async () => {
  // Do not bulk-overwrite global commands with an empty list: Discord protects
  // the application's Activity Entry Point command from that operation.
  // Remove stale global commands individually, preserving Primary Entry Point (type 4).
  const globalCommands = await rest.get(
    Routes.applicationCommands(process.env.CLIENT_ID)
  );

  for (const command of globalCommands) {
    if (command.type === 4) {
      console.log(`Entry Point da Activity preservado: ${command.name}`);
      continue;
    }

    await rest.delete(
      Routes.applicationCommand(process.env.CLIENT_ID, command.id)
    );
    console.log(`Comando global antigo removido: ${command.name}`);
  }

  // Guild commands are then synchronized without touching the global Activity Entry Point.
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
    { body: commands }
  );

  const current = await rest.get(
    Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID)
  );

  console.log(
    `Comandos registrados no servidor ${process.env.GUILD_ID}: ${current.map(command => command.name).join(', ')}`
  );
  console.log('Sincronização concluída. O Entry Point global da Activity foi preservado.');
})().catch(error => {
  console.error('Falha ao sincronizar comandos da Minako:', error);
  process.exit(1);
});
