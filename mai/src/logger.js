import { pino } from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  base: undefined, // omit pid/hostname noise in container logs
  timestamp: pino.stdTimeFunctions.isoTime,
});
