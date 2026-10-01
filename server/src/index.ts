import { loadConfig } from './config';
import { createLogger } from './logger';
import { openDatabase } from './db';
import { buildServices } from './container';
import { buildApp } from './http/app';
import { startScheduler } from './scheduler';
import { demoRoutes } from './demo/routes';

async function main() {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const db = openDatabase(config.dataDir);
  const services = buildServices(config, log, db);

  const app = await buildApp(services);
  if (config.demoMode) demoRoutes(app, services);
  await app.listen({ port: config.port, host: config.host });

  let stopScheduler = () => {};
  if (!config.disableScheduler) {
    services.monitoring.start();
    services.tickets.resumeQueue();
    stopScheduler = startScheduler(services);
  }

  log.info({ url: config.appUrl, port: config.port, demo: config.demoMode }, `Datix AI ${config.version} a pornit`);
  const setupToken = services.auth.ensureSetupToken();
  if (setupToken) {
    const line = '='.repeat(72);
    // afișat vizibil o singură dată, pentru prima configurare
    console.log(`\n${line}\n  PRIMA CONFIGURARE\n  Deschide: ${config.appUrl}/setup?token=${encodeURIComponent(setupToken)}\n  Cod de instalare: ${setupToken}\n${line}\n`);
  }

  const shutdown = async (signal: string) => {
    log.info(`Oprire (${signal})…`);
    stopScheduler();
    services.monitoring.stop();
    await app.close().catch(() => undefined);
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => log.error({ err }, 'Promisiune respinsă netratată'));
}

main().catch((err) => {
  console.error('Pornirea a eșuat:', err instanceof Error ? err.message : err);
  process.exit(1);
});
