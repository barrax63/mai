/**
 * HTTP server following the discord-example-app pattern:
 * https://github.com/discord/discord-example-app
 *
 * Exposes:
 *   POST /interactions  Discord interactions endpoint (signature-verified),
 *                       reached from outside through the cloudflared tunnel.
 *   GET  /healthz       Liveness probe for Docker healthchecks.
 *   GET  /              Static landing page for visitors hitting the public
 *                       tunnel URL in a browser (served from ./public).
 */
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  InteractionResponseType,
  InteractionType,
  verifyKeyMiddleware,
} from 'discord-interactions';
import { config, isGuildAllowed } from '../config.js';
import { content } from '../content.js';
import { logger } from '../logger.js';
import { commandHandlers } from '../commands/index.js';
import { pingDatabase } from '../db/index.js';
import { getEnforcerStatus } from '../moderation/enforcer.js';

export function createServer() {
  const app = express();
  app.disable('x-powered-by');

  // Landing page + assets. Static middleware only answers GET/HEAD and never
  // touches the request body, so the raw-body requirement of /interactions
  // below is unaffected. `extensions: ['html']` serves extension-less clean
  // URLs (/privacy-policy -> privacy-policy.html) with the correct MIME type;
  // Discord's app settings link to those.
  app.use(
    express.static(fileURLToPath(new URL('./public', import.meta.url)), {
      extensions: ['html'],
    }),
  );

  // Liveness plus the two things that can fail silently: the database and the
  // moderation tick loop. A wedged enforcer means flagged messages are never
  // deleted, which an HTTP-only probe would not notice.
  app.get('/healthz', (req, res) => {
    const database = pingDatabase();
    const enforcer = getEnforcerStatus();
    const tickAgeMs = enforcer.lastTickAt
      ? Date.now() - new Date(enforcer.lastTickAt).getTime()
      : null;

    // Before the first tick, allow a startup grace period (the gateway has to
    // connect first). After that, three missed ticks count as broken.
    const maxTickAgeMs = config.moderation.tickMs * 3;
    const startingUp = process.uptime() * 1000 < Math.max(maxTickAgeMs, 60_000);
    const enforcerOk = !config.moderation.enabled
      || (tickAgeMs === null ? startingUp : tickAgeMs <= maxTickAgeMs);

    const ok = database && enforcerOk;
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      database,
      enforcer: {
        enabled: config.moderation.enabled,
        lastTickAt: enforcer.lastTickAt,
        tickAgeMs,
        running: enforcer.running,
      },
    });
  });

  // verifyKeyMiddleware validates the Ed25519 request signature and rejects
  // unsigned requests. It must consume the raw body, so no express.json()
  // may run before it on this route.
  app.post(
    '/interactions',
    verifyKeyMiddleware(config.discord.publicKey),
    async (req, res) => {
      const interaction = req.body;

      if (interaction.type === InteractionType.PING) {
        return res.send({ type: InteractionResponseType.PONG });
      }

      if (interaction.type === InteractionType.APPLICATION_COMMAND) {
        const name = interaction.data?.name;

        // Guild allowlist (DISCORD_GUILD_IDS). Raw interactions use snake_case;
        // guild_id is absent for DM commands, which bypass the allowlist like
        // DM chat does. An un-whitelisted guild gets an ephemeral refusal.
        if (!isGuildAllowed(interaction.guild_id)) {
          logger.debug(
            { command: name, guildId: interaction.guild_id },
            'Refusing command: guild not in allowlist',
          );
          return res.send({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: content.commands.notActive,
              flags: 64, // EPHEMERAL
            },
          });
        }

        const handler = commandHandlers.get(name);

        if (!handler) {
          logger.warn({ command: name }, 'Received unknown command');
          return res.status(400).json({ error: 'unknown command' });
        }

        try {
          // Handlers may be async (database access, Discord REST) — Discord
          // still expects the response within ~3 s.
          return res.send(await handler(interaction));
        } catch (error) {
          logger.error({ err: error, command: name }, 'Command handler failed');
          return res.status(500).json({ error: 'internal error' });
        }
      }

      logger.warn({ type: interaction.type }, 'Unhandled interaction type');
      return res.status(400).json({ error: 'unhandled interaction type' });
    },
  );

  return app;
}

export function startServer() {
  const app = createServer();

  return new Promise((resolve) => {
    const server = app.listen(config.http.port, '0.0.0.0', () => {
      logger.info({ port: config.http.port }, 'HTTP server listening');
      resolve(server);
    });
  });
}
