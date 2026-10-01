import pino from 'pino';

export type Logger = pino.Logger;

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      // nu lăsăm niciodată datele de acces să ajungă în loguri
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.password',
        '*.secret',
        '*.apiKey',
        '*.loginKey',
        '*.token',
      ],
      censor: '[ascuns]',
    },
  });
}
