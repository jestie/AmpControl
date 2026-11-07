require('dotenv').config();

const fs = require('fs');
const http = require('http');
const https = require('https');
const createApp = require('./app');
const manager = require('./manager');
const logger = require('./utils/logger');
const { Scheduler } = require('./schedule');

const PORT = parseInt(process.env.PORT, 10) || 8095;
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  await manager.init();
  for (const error of manager.errors) {
    logger.error({ action: 'device_init', device: error.device, driver: error.driver, error: error.error });
  }

  const scheduler = new Scheduler({ manager, logger });
  scheduler.start();
  // HTTPS when a certificate is configured (npm run cert): the app moves to
  // HTTPS_PORT and the plain HTTP port only redirects there (SC-01).
  let tlsOptions = null;
  if (process.env.TLS_CERT && process.env.TLS_KEY) {
    try {
      tlsOptions = { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY), minVersion: 'TLSv1.2' };
    } catch (e) {
      logger.error({ action: 'tls_unavailable', error: e.message });
      console.error(`HTTPS not started (${e.message}); serving plain HTTP.`);
    }
  }
  const HTTPS_PORT = parseInt(process.env.HTTPS_PORT, 10) || 8443;
  const app = createApp({ manager, logger, scheduler, tls: Boolean(tlsOptions) });
  const servers = [];
  if (tlsOptions) {
    servers.push(https.createServer(tlsOptions, app).listen(HTTPS_PORT, HOST, () => {
      console.log(`SoundControl listening on https://${HOST}:${HTTPS_PORT} (http://${HOST}:${PORT} redirects)`);
    }));
    servers.push(http.createServer((req, res) => {
      if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return; }
      const host = String(req.headers.host || 'localhost').replace(/:\d+$/, '').replace(/[^A-Za-z0-9.\-\[\]:]/g, '');
      res.writeHead(308, { Location: `https://${host}:${HTTPS_PORT}${req.url.startsWith('/') ? req.url : '/'}` });
      res.end();
    }).listen(PORT, HOST));
  }
  const server = tlsOptions ? servers[0] : app.listen(PORT, HOST, () => {
    console.log(`SoundControl listening on http://${HOST}:${PORT}`);
  });
  if (!tlsOptions) servers.push(server);
  server.on('listening', () => {
    logger.info({ action: 'start', host: HOST, port: tlsOptions ? HTTPS_PORT : PORT, https: Boolean(tlsOptions), devices: manager.getDevices().map((d) => d.id) });
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ action: 'shutdown', signal });
    scheduler.stop();
    let open = servers.length;
    for (const srv of servers) {
      srv.close(async () => {
        open -= 1;
        if (open > 0) return;
        await manager.close();
        process.exit(0);
      });
    }
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
