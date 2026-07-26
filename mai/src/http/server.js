/**
 * HTTP server following the discord-example-app pattern:
 * https://github.com/discord/discord-example-app
 *
 * Exposes:
 *   POST /interactions  Discord interactions endpoint (signature-verified),
 *                       reached from outside through the cloudflared tunnel.
 *                       Dispatch lives in interactions/router.js.
 *   GET  /healthz       Liveness probe for Docker healthchecks.
 *   GET  /              Static landing page for visitors hitting the public
 *                       tunnel URL in a browser (served from ./public).
 */
import { fileURLToPath } from 'node:url';
import express from 'express';
import { verifyKeyMiddleware } from 'discord-interactions';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { pingDatabase } from '../db/index.js';
import { routeInteraction } from '../interactions/router.js';
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
      // All routing lives in interactions/router.js; `send` is called exactly
      // once and may be followed by slower work that edits the response.
      const send = (body, status = 200) => {
        if (res.headersSent) {
          logger.error({ status }, 'Interaction response sent twice');
          return;
        }
        res.status(status).json(body);
      };

      try {
        await routeInteraction(req.body, send);
      } catch (error) {
        logger.error({ err: error }, 'Interaction routing failed');
        send({ error: 'internal error' }, 500);
      }
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
