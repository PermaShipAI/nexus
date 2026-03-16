import pino from 'pino';
import { config } from './config.js';

const isProduction = config.NODE_ENV === 'production';

export const logger = pino({
  level: config.LOG_LEVEL,
  ...(isProduction
    ? {
        redact: ['*.token', '*.apiKey', '*.secret', '*.password'],
      }
    : {
        transport: {
          target: 'pino-pretty',
          options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
});
