/**
 * ATI ZMATF Executive Training Assessment System
 *
 * Express.js server with:
 * - EJS server-side rendering (answer key never reaches browser)
 * - SQLite database with WAL mode
 * - Session-based authentication
 * - Role-based access control
 * - CSRF protection
 * - Security headers via Helmet
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
const { initDb, getDb, initializeSchema, isSeeded, closeDb } = require('./src/utils/db');
const { addUserToLocals } = require('./src/middleware/auth');
const { addCsrfToLocals } = require('./src/middleware/validation');

// ============================================================
// ENVIRONMENT VALIDATION
// ============================================================

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Validate critical environment variables
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
    console.error('FATAL: SESSION_SECRET must be set and at least 32 characters.');
    console.error('Generate with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
    process.exit(1);
}

if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
    console.error('FATAL: ADMIN_USERNAME and ADMIN_PASSWORD must be set in .env');
    process.exit(1);
}

if (process.env.ADMIN_PASSWORD.length < 12) {
    console.error('FATAL: ADMIN_PASSWORD must be at least 12 characters.');
    process.exit(1);
}

// ============================================================
// EXPRESS APP
// ============================================================

const app = express();

// Trust proxy (for secure cookies behind reverse proxy)
if (NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

// View engine & layout configuration
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layouts/main');

// ============================================================
// MIDDLEWARE
// ============================================================

// Security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:"],
            connectSrc: ["'self'"],
        }
    }
}));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Sessions
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 2 * 60 * 60 * 1000, // 2 hours
        sameSite: 'lax'
    }
}));

// Add user info and CSRF token to all templates
app.use(addUserToLocals);
app.use(addCsrfToLocals);

// ============================================================
// ROUTES
// ============================================================

// Landing page
app.get('/', (req, res) => {
    res.render('landing', {
        title: 'ATI ZMATF Assessment',
        layout: 'layouts/main'
    });
});

// Auth routes
const authRoutes = require('./src/routes/auth');
app.use('/', authRoutes);

// Assessment routes
const assessmentRoutes = require('./src/routes/assessment');
app.use('/assessment', assessmentRoutes);

// Admin routes
const adminRoutes = require('./src/routes/admin');
app.use('/admin', adminRoutes);

// ============================================================
// ERROR HANDLING
// ============================================================

// 404
app.use((req, res) => {
    res.status(404).render('error', {
        title: 'Not Found',
        message: 'The page you are looking for does not exist.',
        layout: 'layouts/main'
    });
});

// 500
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).render('error', {
        title: 'Server Error',
        message: 'An unexpected error occurred. Please try again.',
        layout: 'layouts/main'
    });
});

// ============================================================
// SERVER START
// ============================================================

let server;

(async () => {
    try {
        await initDb();
        initializeSchema();
        console.log('Database schema initialized.');

        if (!isSeeded()) {
            console.log('');
            console.log('⚠️  Database is not seeded. Run: npm run seed');
            console.log('');
        }

        server = app.listen(PORT, () => {
            console.log('');
            console.log('═══════════════════════════════════════════════════════════');
            console.log('  ATI ZMATF Executive Training Assessment System');
            console.log('  Africa Transformational Initiative');
            console.log('═══════════════════════════════════════════════════════════');
            console.log(`  Server:     http://localhost:${PORT}`);
            console.log(`  Admin:      http://localhost:${PORT}/admin/login`);
            console.log(`  Environment: ${NODE_ENV}`);
            console.log('═══════════════════════════════════════════════════════════');
            console.log('');
        });
    } catch (err) {
        console.error('FATAL: Database initialization failed:', err.message);
        process.exit(1);
    }
})();

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('Shutting down gracefully...');
    server.close(() => {
        closeDb();
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('Shutting down...');
    server.close(() => {
        closeDb();
        process.exit(0);
    });
});

module.exports = app;
