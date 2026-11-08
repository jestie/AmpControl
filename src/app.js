const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const createApiRouter = require('./routes/api');
const { Spotify } = require('./spotify');
const { publicError } = require('./drivers/errors');
const { FileSessionStore } = require('./auth/session-store');
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

function createApp({ manager = require('./manager'), logger = require('./utils/logger'), limiter, scheduler = null, tls = false, spotify = null, favourites = null, sessionStore = new FileSessionStore() } = {}) {
  // HTTPS on: Secure cookies, HSTS, and the Spotify callback on the HTTPS port (SC-01).
  if (!spotify) spotify = new Spotify({ logger, port: tls ? (parseInt(process.env.HTTPS_PORT, 10) || 8443) : (parseInt(process.env.PORT, 10) || 8095), https: tls });
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
        // No inline <style> or style="" anywhere; scripts set styles via CSSOM,
        // which CSP does not restrict (SC-08).
        'style-src': ["'self'"],
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
    hsts: tls ? { maxAge: 180 * 24 * 60 * 60, includeSubDomains: false } : false,
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
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: tls || process.env.COOKIE_SECURE === 'true',
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
    req.session.role = user.role;
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

  // ---- Spotify sign-in (PKCE). Done once, from the server's own browser. ----
  app.get('/spotify/login', requireAuth, (req, res) => {
    if (req.session.role !== 'admin') return res.redirect('/?spotify=' + encodeURIComponent('Only an admin can connect Spotify'));
    try {
      const { url, verifier, state } = spotify.beginLogin();
      req.session.spotifyLogin = { verifier, state, at: Date.now() };
      req.session.save(() => res.redirect(url));
    } catch (e) {
      res.redirect(`/?spotify=${encodeURIComponent(e.message)}`);
    }
  });

  app.get('/spotify/callback', requireAuth, async (req, res) => {
    const pending = req.session.spotifyLogin;
    delete req.session.spotifyLogin;
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!pending || !state || state !== pending.state || Date.now() - pending.at > 10 * 60 * 1000) {
      return res.redirect('/?spotify=' + encodeURIComponent('Spotify sign-in expired or did not match; try Connect again'));
    }
    if (!code) return res.redirect('/?spotify=' + encodeURIComponent(`Spotify sign-in cancelled${req.query.error ? `: ${String(req.query.error).slice(0, 60)}` : ''}`));
    try {
      await spotify.finishLogin(code, pending.verifier);
      logger.info({ action: 'spotify_connected', user: req.session.username });
      return res.redirect('/?spotify=connected');
    } catch (e) {
      return res.redirect(`/?spotify=${encodeURIComponent(e.message)}`);
    }
  });

  app.get('/healthz', (req, res) => {
    res.json({ ok: true });
  });

  app.use('/api', createApiRouter({ manager, logger, scheduler, spotify, favourites }));

  app.use((req, res) => {
    if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'not found' });
    return res.status(404).type('text').send('Not found');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // Client mistakes (bad JSON, body too large...) keep their 4xx status (SC-05).
    const status = Number(err.status || err.statusCode);
    const clientError = status >= 400 && status < 500;
    const messages = { 400: 'the request could not be read', 413: 'the request is too large', 415: 'unsupported content type' };
    (clientError ? logger.warn || logger.info : logger.error).call(logger, {
      action: clientError ? 'request_rejected' : 'request_error',
      method: req.method,
      path: req.originalUrl,
      status: clientError ? status : 500,
      error: err.message,
      cause: err.cause ? String(err.cause.message || err.cause) : undefined
    });
    if (res.headersSent) return;
    if (clientError) {
      const message = messages[status] || 'the request was not accepted';
      return req.path.startsWith('/api/') ? res.status(status).json({ error: message }) : res.status(status).type('text').send(message);
    }
    // Never show device addresses (SC-03): plain message, details in the log.
    if (req.path.startsWith('/api/')) return res.status(500).json({ error: publicError(err).message || 'internal error' });
    return res.status(500).type('text').send('Internal error');
  });

  return app;
}

module.exports = createApp;
module.exports.escapeHtml = escapeHtml;
