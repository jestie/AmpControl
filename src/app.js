const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const createApiRouter = require('./routes/api');
const { verifyUser } = require('./auth/users');
const { tokenFor, csrfProtection } = require('./auth/csrf');
const { LoginLimiter } = require('./auth/limit');

const VIEWS = path.join(__dirname, '../views');
const PUBLIC = path.join(__dirname, '../public');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret !== 'change-me' && secret !== 'change-me-to-a-long-random-string' && secret.length >= 32) {
    return secret;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET must be set to a random string of at least 32 characters');
  }
  // Development without .env: random per process, so sessions end on restart.
  return crypto.randomBytes(32).toString('hex');
}

function createApp({ manager = require('./manager'), logger = require('./utils/logger'), limiter, scheduler = null } = {}) {
  const app = express();
  const pageTemplate = fs.readFileSync(path.join(VIEWS, 'index.html'), 'utf8');
  const loginTemplate = fs.readFileSync(path.join(VIEWS, 'login.html'), 'utf8');
  const loginLimiter = limiter || new LoginLimiter({
    maxFailures: parseInt(process.env.LOGIN_MAX_FAILURES, 10) || 5
  });

  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'script-src-attr': ["'none'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:', 'https:'],
        'connect-src': ["'self'"],
        'form-action': ["'self'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'self'"],
        'object-src': ["'none'"],
        // Plain HTTP on the LAN today; upgrading subresources to HTTPS would break the app.
        'upgrade-insecure-requests': null
      }
    },
    // HSTS is meaningless over plain HTTP; enable it once HTTPS is in front of the app.
    hsts: false,
    crossOriginEmbedderPolicy: false
  }));

  app.use(express.json({ limit: '16kb' }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));
  app.use(express.static(PUBLIC, {
    index: false,
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
  }));

  app.use(session({
    name: 'soundcontrol.sid',
    secret: sessionSecret(),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
      maxAge: (parseInt(process.env.SESSION_HOURS, 10) || 12) * 60 * 60 * 1000
    }
  }));

  function requireAuth(req, res, next) {
    if (req.session && req.session.userId) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'not signed in' });
    return res.redirect('/login');
  }

  function renderLogin(res, { error = '', status = 200, username = '' } = {}) {
    const errorBlock = error
      ? `<div class="error" role="alert">${escapeHtml(error)}</div>`
      : '';
    res.status(status).type('html').send(
      loginTemplate
        .replace('{{ERROR}}', errorBlock)
        .replace('{{USERNAME}}', escapeHtml(username))
    );
  }

  app.get('/login', (req, res) => {
    if (req.session && req.session.userId) return res.redirect('/');
    return renderLogin(res);
  });

  app.post('/login', async (req, res) => {
    const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const ip = req.ip;

    const limited = loginLimiter.check(ip, username);
    if (limited.blocked) {
      logger.warn({ action: 'login_locked', user: username, ip, retryAfter: limited.retryAfter });
      return renderLogin(res, {
        status: 429,
        error: `Too many failed attempts. Try again in ${Math.ceil(limited.retryAfter / 60)} minute(s).`,
        username
      });
    }

    const user = await verifyUser(username, password).catch(() => null);
    if (!user) {
      const failure = loginLimiter.fail(ip, username);
      logger.warn({ action: 'login_failed', user: username, ip, remaining: failure.remaining, locked: failure.blocked });
      const message = failure.blocked
        ? 'Too many failed attempts. This account is locked for 15 minutes.'
        : 'Invalid username or password.';
      return renderLogin(res, { status: failure.blocked ? 429 : 401, error: message, username });
    }

    loginLimiter.reset(ip, username);
    await new Promise((resolve, reject) => {
      req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });
    req.session.userId = user.id;
    req.session.username = user.username;
    tokenFor(req.session);
    await new Promise((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });

    logger.info({ action: 'login', user: user.username, ip });
    return res.redirect('/');
  });

  app.post('/logout', requireAuth, csrfProtection, (req, res) => {
    const username = req.session.username;
    req.session.destroy(() => {
      logger.info({ action: 'logout', user: username });
      res.clearCookie('soundcontrol.sid');
      res.redirect('/login');
    });
  });

  app.get('/', requireAuth, (req, res) => {
    const html = pageTemplate
      .replace(/\{\{CSRF_TOKEN\}\}/g, tokenFor(req.session))
      .replace(/\{\{USERNAME\}\}/g, escapeHtml(req.session.username));
    res.set('Cache-Control', 'no-store').type('html').send(html);
  });

  app.get('/healthz', (req, res) => {
    res.json({ ok: true });
  });

  app.use('/api', createApiRouter({ manager, logger, scheduler }));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
    return res.status(404).type('text').send('Not found');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error({
      action: 'request_error',
      method: req.method,
      path: req.originalUrl,
      error: err.message
    });
    if (res.headersSent) return;
    if (req.path.startsWith('/api/')) return res.status(500).json({ error: err.message || 'internal error' });
    return res.status(500).type('text').send('Internal error');
  });

  return app;
}

module.exports = createApp;
module.exports.escapeHtml = escapeHtml;
