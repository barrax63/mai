import { pino } from 'pino';
import { alert } from './alerts.js';
import { config } from './config.js';

const ERROR_LEVEL = 50;
const FATAL_LEVEL = 60;

export const logger = pino({
  level: config.logLevel,
  base: undefined, // omit pid/hostname noise in container logs
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    // Pino writes numeric levels (30, 20) by design. These logs are read by a
    // human in `docker compose logs`, so write the label instead: the records
    // stay valid JSON either way.
    level: (label) => ({ level: label }),
  },
  hooks: {
    // Every error and fatal is mirrored into the alert channel from here, so no
    // call site has to remember to raise one. Alerting is fire-and-forget and
    // swallows its own failures: see alerts.js.
    logMethod(args, method, level) {
      if (level >= ERROR_LEVEL) {
        const [first, second] = args;
        const record = typeof first === 'object' ? first : undefined;
        const message = typeof first === 'string' ? first : second;
        alert(level >= FATAL_LEVEL ? 'fatal' : 'error', record, message);
      }
      return method.apply(this, args);
    },
  },
});
