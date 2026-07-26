import { pino } from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  base: undefined, // omit pid/hostname noise in container logs
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    // Pino writes numeric levels (30, 20) by design. These logs are read by a
    // human in `docker compose logs`, so write the label instead — the records
    // stay valid JSON either way.
    level: (label) => ({ level: label }),
  },
});
