require('dotenv').config();

const createApp = require('./app');
const manager = require('./manager');
const logger = require('./utils/logger');

const PORT = parseInt(process.env.PORT, 10) || 8095;
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  await manager.init();
  for (const error of manager.errors) {
    logger.error({ action: 'device_init', device: error.device, driver: error.driver, error: error.error });
  }

  const app = createApp({ manager, logger });
  const server = app.listen(PORT, HOST, () => {
    logger.info({ action: 'start', host: HOST, port: PORT, devices: manager.getDevices().map((d) => d.id) });
    console.log(`SoundControl listening on http://${HOST}:${PORT}`);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ action: 'shutdown', signal });
    server.close(async () => {
      await manager.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ action: 'start_failed', error: err.message });
  console.error('Failed to start:', err.message);
  process.exit(1);
});
