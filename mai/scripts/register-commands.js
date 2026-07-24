/**
 * Registers all slash commands with Discord (global commands).
 * Run once after adding or changing a command definition:
 *
 *   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... npm run register
 *
 * Global commands can take up to an hour to propagate.
 */
import { config } from '../src/config.js';
import { commandDefinitions } from '../src/commands/index.js';

const appId = config.discord.appId;
if (!appId) {
  console.error('DISCORD_APP_ID is required to register commands.');
  process.exit(1);
}

const response = await fetch(
  `https://discord.com/api/v10/applications/${appId}/commands`,
  {
    method: 'PUT',
    headers: {
      Authorization: `Bot ${config.discord.botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commandDefinitions),
  },
);

if (!response.ok) {
  console.error(`Registration failed: ${response.status} ${await response.text()}`);
  process.exit(1);
}

const registered = await response.json();
console.log(`Registered ${registered.length} command(s): ${registered.map((c) => c.name).join(', ')}`);
