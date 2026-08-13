/**
 * PostgreSQL connection pool.
 *
 * Production is Neon; development is a local container. The only difference is
 * TLS, which Neon requires and a local container does not offer.
 *
 * ── Pool sizing on free tiers ───────────────────────────────────────────────
 * Neon's free plan caps concurrent connections, and Render's free instance is a
 * single small process serving 32 officers at most. A large pool would simply
 * hold idle connections against that cap, so the default is deliberately small
 * and idle clients are released quickly.
 */

'use strict';

const { Pool } = require('pg');

let pool = null;

function connectionString() {
    const url = process.env.DATABASE_URL;
    if (!url) {
        throw new Error(
            'DATABASE_URL is not set. Point it at your Neon connection string, ' +
            'or at the local container for development.'
        );
    }
    return url;
}

/**
 * Whether to negotiate TLS.
 *
 * Neon requires it; a local container has no certificate. Detected from the
 * URL rather than NODE_ENV so a developer pointing at Neon still gets TLS.
 */
function sslConfig(url) {
    if (process.env.PGSSL === 'disable') return false;
    const isLocal = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(url);
    if (isLocal) return false;

    // Neon terminates TLS at a pooler whose chain Node does not ship. The
    // connection is still encrypted; only chain verification is relaxed.
    return { rejectUnauthorized: false };
}

function initPool() {
    if (pool) return pool;

    const url = connectionString();
    pool = new Pool({
        connectionString: url,
        ssl: sslConfig(url),
        max: Number(process.env.PG_POOL_MAX || 5),
        idleTimeoutMillis: 10_000,
        connectionTimeoutMillis: 15_000,
        // Neon's free tier suspends an idle database; the first query after
        // that pays a wake-up cost. Generous enough to absorb it.
        statement_timeout: 20_000,
    });

    // An idle client erroring must not take the process down. The pool
    // discards it and the next query gets a fresh one.
    pool.on('error', (err) => {
        console.error('Postgres idle client error:', err.message);
    });

    return pool;
}

function getPool() {
    if (!pool) throw new Error('Pool not initialised. Call initPool() first.');
    return pool;
}

/** Run a query. Returns rows. */
async function query(text, params = []) {
    const result = await getPool().query(text, params);
    return result.rows;
}

/** Run a query expecting at most one row. */
async function queryOne(text, params = []) {
    const rows = await query(text, params);
    return rows.length ? rows[0] : null;
}

/**
 * Run `fn` inside a transaction on a dedicated client.
 *
 * Starting an attempt writes the attempt plus 20 mapping rows; a partial write
 * would leave an attempt whose questions have no options and which cannot be
 * scored. The client is always released, including on failure.
 */
async function transaction(fn) {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (rollbackErr) { /* connection already gone */ }
        throw err;
    } finally {
        client.release();
    }
}

/** Cheap liveness probe for /healthz. */
async function ping() {
    await query('SELECT 1');
    return true;
}

function describeTarget() {
    const url = process.env.DATABASE_URL || '';
    const match = url.match(/@([^/:]+)/);
    const host = match ? match[1] : 'unknown';
    return `${host}${sslConfig(url) ? ' (TLS)' : ''}`;
}

async function closePool() {
    if (!pool) return;
    await pool.end();
    pool = null;
}

module.exports = {
    initPool,
    getPool,
    query,
    queryOne,
    transaction,
    ping,
    describeTarget,
    closePool,
};
