/**
 * Entry point: starts the HTTP interactions server and the gateway client,
 * and shuts both down cleanly on SIGTERM/SIGINT (docker stop).
 */
import { logger } from './logger.js';
import { startServer } from './http/server.js';
import { startGateway } from './gateway/client.js';

async function main() {
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

    await Promise.allSettled([
      new Promise((resolve) => server.close(resolve)),
      gateway.destroy(),
    ]);

    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });
}

main().catch((error) => {
  logger.fatal({ err: error }, 'Startup failed');
  process.exit(1);
});
