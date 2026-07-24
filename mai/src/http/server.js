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
import { config } from '../config.js';
import { logger } from '../logger.js';
import { commandHandlers } from '../commands/index.js';

export function createServer() {
  const app = express();
  app.disable('x-powered-by');

  // Landing page + assets. Static middleware only answers GET/HEAD and never
  // touches the request body, so the raw-body requirement of /interactions
  // below is unaffected.
  app.use(express.static(fileURLToPath(new URL('./public', import.meta.url))));

  app.get('/healthz', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // verifyKeyMiddleware validates the Ed25519 request signature and rejects
  // unsigned requests. It must consume the raw body, so no express.json()
  // may run before it on this route.
  app.post(
    '/interactions',
    verifyKeyMiddleware(config.discord.publicKey),
    (req, res) => {
      const interaction = req.body;

      if (interaction.type === InteractionType.PING) {
        return res.send({ type: InteractionResponseType.PONG });
      }

      if (interaction.type === InteractionType.APPLICATION_COMMAND) {
        const name = interaction.data?.name;
        const handler = commandHandlers.get(name);

        if (!handler) {
          logger.warn({ command: name }, 'Received unknown command');
          return res.status(400).json({ error: 'unknown command' });
        }

        try {
          return res.send(handler(interaction));
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
