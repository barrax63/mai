/**
 * HTTP server following the discord-example-app pattern:
 * https://github.com/discord/discord-example-app
 *
 * Exposes:
 *   POST /interactions  Discord interactions endpoint (signature-verified),
 *                       reached from outside through the cloudflared tunnel.
 *                       Dispatch lives in interactions/router.js.
 *   GET  /healthz       Liveness probe for Docker healthchecks.
 *   GET  /metrics       Prometheus text format, operator-only: 404 unless
 *                       METRICS_TOKEN is set, then a bearer token is required.
 *   GET  /              Static landing page plus /privacy-policy and
 *                       /terms-of-service, for visitors hitting the public
 *                       tunnel URL in a browser (served from ./public).
 */
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { verifyKeyMiddleware } from 'discord-interactions';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { pingDatabase } from '../db/index.js';
import { routeInteraction } from '../interactions/router.js';
import { getEnforcerStatus } from '../moderation/enforcer.js';
import { createRateLimiter } from '../rate-limit.js';
import { renderMetrics } from './metrics.js';

const interactionsLimiter = createRateLimiter({
  max: config.http.rateLimitMax,
  windowMs: config.http.rateLimitWindowMs,
  name: 'interactions',
  level: 'debug',
});

/**
 * Who to charge a request to.
 *
 * Everything arrives from the cloudflared container, so `req.ip` is the same
 * value for every caller and would make a per-client limit meaningless.
 * Cloudflare sets `CF-Connecting-IP` to the real client. That header is
 * spoofable in general: here it is not reachable to spoof, because the port is
 * published only on the internal `edge` network and cloudflared overwrites it,
 * and a forged one only ever splits an attacker's own budget into more buckets,
 * never borrows someone else's.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
let warnedAboutSharedBucket = false;

const clientKey = (req) => {
  const forwarded = req.get('cf-connecting-ip');
  if (forwarded) return forwarded;

  // Without the header every caller lands in the same bucket, which turns a
  // per-client limit into a global one: survivable, but the operator should
  // know their limit is now shared across all traffic. Said once, not per
  // request: this is a deployment fact, not an event.
  if (!warnedAboutSharedBucket) {
    warnedAboutSharedBucket = true;
    logger.warn(
      { limit: config.http.rateLimitMax },
      'No CF-Connecting-IP on interactions: the rate limit is shared by all callers',
    );
  }
  return req.ip || 'unknown';
};

/**
 * Caps the request body before the signature check reads it. Discord sends a
 * `Content-Length`; anything without one is refused rather than streamed.
 */
function limitBody(req, res, next) {
  const declared = Number.parseInt(req.get('content-length') ?? '', 10);
  if (!Number.isInteger(declared) || declared > config.http.maxBodyBytes) {
    logger.debug({ declared, limit: config.http.maxBodyBytes }, 'Refused an oversized interaction body');
    res.status(413).end();
    return;
  }
  next();
}

/** Cheap gate in front of the Ed25519 verification. */
function limitRate(req, res, next) {
  if (!interactionsLimiter.consume(clientKey(req))) {
    res.status(429).end();
    return;
  }
  next();
}

export function createServer() {
  const app = express();
  app.disable('x-powered-by');
  // cloudflared is the only thing that can reach this, so exactly one hop.
  app.set('trust proxy', 1);

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

  // Operator-only, and off unless a token is configured: this endpoint reports
  // process-wide numbers across every guild, and the server is public through
  // the tunnel. Compared with a timing-safe equality so the token cannot be
  // guessed byte by byte.
  app.get('/metrics', (req, res) => {
    const expected = config.http.metricsToken;
    if (!expected) {
      res.status(404).end();
      return;
    }

    // The scheme is required, not stripped-if-present: accepting a bare token
    // would also accept it from any other auth scheme's payload.
    const offered = /^Bearer +(.+)$/i.exec(req.get('authorization') ?? '')?.[1] ?? '';
    const a = Buffer.from(offered);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      res.status(401).end();
      return;
    }

    try {
      res.type('text/plain; version=0.0.4').send(renderMetrics(getEnforcerStatus()));
    } catch (error) {
      logger.error({ err: error }, 'Rendering metrics failed');
      res.status(500).end();
    }
  });

  // verifyKeyMiddleware validates the Ed25519 request signature and rejects
  // unsigned requests. It must consume the raw body, so no express.json()
  // may run before it on this route.
  app.post(
    '/interactions',
    // Both run before verifyKeyMiddleware: the signature check is the expensive
    // part, so a flood has to be turned away in front of it, not by it.
    limitRate,
    limitBody,
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
