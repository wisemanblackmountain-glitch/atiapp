/**
 * ATI ZMATF Executive Training Assessment System
 *
 * Express + EJS, Firestore for persistence, deployed to Render.
 *
 * ── Architecture ────────────────────────────────────────────────────────────
 * The browser never talks to the database. This process is its only client, so
 * there is no path from a browser to the answer key — not a permission that
 * could be misconfigured, an absence of any route at all.
 *
 * Render's free tier has no persistent disk, which is why state lives in
 * Postgres rather than a file. It also sleeps after 15 minutes idle; /healthz
 * exists partly so an external pinger can hold it awake through an assessment.
 *
 * © 2026 Africa Transformational Initiative
 */

'use strict';

require('dotenv').config();

const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
const helmet = require('helmet');
const path = require('path');

const db = require('./src/data/pool');
const PostgresSessionStore = require('./src/data/sessionStore');
const { addUserToLocals } = require('./src/middleware/auth');
const { addCsrfToLocals } = require('./src/middleware/validation');

// ============================================================
// ENVIRONMENT VALIDATION
// ============================================================

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;
const NODE_ENV = process.env.NODE_ENV || 'development';

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
    console.error('FATAL: SESSION_SECRET must be set and at least 32 characters.');
    console.error('Generate with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
    process.exit(1);
}

// ============================================================
// EXPRESS APP
// ============================================================

const app = express();

// Render always terminates TLS at a proxy, so secure cookies and req.ip (which
// the login rate limiter keys on) need the forwarded headers trusted.
if (NODE_ENV === 'production' || process.env.RENDER) {
    app.set('trust proxy', 1);
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layouts/main');

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            // Fonts are self-hosted; these origins remain permitted only for the
            // documented Google Fonts fallback in views/layouts/main.ejs. Drop
            // both once public/fonts/ is populated.
            styleSrc: ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"],
            fontSrc: ["'self'", 'https://fonts.gstatic.com'],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:'],
            connectSrc: ["'self'"],
            frameAncestors: ["'none'"],
            formAction: ["'self'"],
        },
    },
    // The app is served over HTTPS by Render; a year of HSTS is appropriate.
    hsts: NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true } : false,
}));

app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));

app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: NODE_ENV === 'production' ? '7d' : 0,
}));

let sessionStore = null;

// ============================================================
// HEALTH
// ============================================================

/**
 * Liveness and readiness.
 *
 * Render polls this, and it doubles as the target for the keep-alive that
 * prevents the free instance sleeping mid-assessment. Deliberately mounted
 * before the session middleware so a health check never creates a session
 * document — that would burn Spark write quota on every ping.
 */
app.get('/healthz', async (req, res) => {
    try {
        await db.ping();
        res.json({ status: 'ok', store: 'postgres', uptime: Math.round(process.uptime()) });
    } catch (err) {
        res.status(503).json({ status: 'degraded', error: 'datastore unreachable' });
    }
});

// ============================================================
// BOOT
// ============================================================

let server;

async function start() {
    db.initPool();

    // Fail fast on a bad DATABASE_URL rather than surfacing it as a 500 on the
    // first participant's sign-in attempt.
    await db.ping();

    sessionStore = new PostgresSessionStore();

    app.use(session({
        store: sessionStore,
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        name: 'connect.sid',
        cookie: {
            secure: NODE_ENV === 'production',
            httpOnly: true,
            maxAge: 2 * 60 * 60 * 1000,
            sameSite: 'lax',
        },
    }));

    app.use(addUserToLocals);
    app.use(addCsrfToLocals);

    // ── Routes ───────────────────────────────────────────────────────────
    app.get('/', (req, res) => {
        res.render('landing', { title: 'ATI ZMATF Assessment', layout: 'layouts/main' });
    });

    app.use('/', require('./src/routes/auth'));
    app.use('/assessment', require('./src/routes/assessment'));
    app.use('/admin', require('./src/routes/admin'));

    // ── Errors ───────────────────────────────────────────────────────────
    app.use((req, res) => {
        res.status(404).render('error', {
            title: 'Not Found',
            message: 'The page you are looking for does not exist.',
            layout: 'layouts/main',
        });
    });

    app.use((err, req, res, next) => {
        console.error('Unhandled error:', err.stack || err.message);

        // The answer-saving client expects JSON; an HTML error page would be
        // parsed as a failed save and silently roll the answer back.
        if (req.path === '/assessment/save-answer' || req.is('application/json')) {
            return res.status(500).json({ error: 'An unexpected error occurred.' });
        }
        return res.status(500).render('error', {
            title: 'Server Error',
            message: 'An unexpected error occurred. Please try again.',
            layout: 'layouts/main',
        });
    });

    server = app.listen(PORT, () => {
        console.log('');
        console.log('═══════════════════════════════════════════════════════════');
        console.log('  ATI ZMATF Executive Training Assessment System');
        console.log('  Africa Transformational Initiative');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`  Server:      http://localhost:${PORT}`);
        console.log(`  Admin:       http://localhost:${PORT}/admin/login`);
        console.log(`  Health:      http://localhost:${PORT}/healthz`);
        console.log(`  Environment: ${NODE_ENV}`);
        console.log(`  Datastore:   Postgres @ ${db.describeTarget()}`);
        console.log('═══════════════════════════════════════════════════════════');
        console.log('');
    });
}

// ============================================================
// SHUTDOWN
// ============================================================

let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received, shutting down.`);

    if (sessionStore) sessionStore.stop();
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.closePool().catch(() => {});
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
    start().catch((err) => {
        console.error('\nFATAL: startup failed:', err.message);
        console.error('Check DATABASE_URL, and that migrations have run: npm run migrate\n');
        process.exit(1);
    });
}

module.exports = { app, start };
