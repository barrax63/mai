/**
 * Entry point: opens the database, starts the HTTP interactions server and the
 * gateway client, and shuts everything down cleanly on SIGTERM/SIGINT
 * (docker stop).
 *
 * A database that cannot be opened or migrated is fatal: running with a broken
 * queue would silently drop moderation.
 */
import { closeDatabase, openDatabase } from './db/index.js';
import { logger } from './logger.js';
import { startServer } from './http/server.js';
import { startGateway, stopEnforcer } from './gateway/client.js';

async function main() {
  // Registered before anything can reject: opening the database and connecting
  // the gateway are the two slowest steps of startup and the likeliest to fail,
  // and a rejection during them used to go unhandled because the handler was
  // installed after the awaits.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });

  openDatabase();

  const server = await startServer();
  const gateway = await startGateway();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');

    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out, exiting');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    stopEnforcer();

    await Promise.allSettled([
      new Promise((resolve) => server.close(resolve)),
      gateway.destroy(),
    ]);

    closeDatabase();

    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  logger.fatal({ err: error }, 'Startup failed');
  process.exit(1);
});
