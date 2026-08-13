/**
 * Postgres-backed express-session store.
 *
 * MemoryStore loses every session when the process restarts. On Render's free
 * tier the instance sleeps after 15 minutes idle, so an officer who paused
 * mid-assessment would return signed out — and, because attempts are
 * one-per-officer and the deadline keeps running, unable to recover.
 *
 * Written here rather than pulling in connect-pg-simple: it is ~100 lines, it
 * shares the application's pool, and the touch throttling below is specific to
 * this workload.
 */

'use strict';

const session = require('express-session');
const db = require('./pool');

const Store = session.Store;

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;   // matches the cookie maxAge
const TOUCH_THRESHOLD_MS = 5 * 60 * 1000;    // rewrite expiry at most every 5 min
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

class PostgresSessionStore extends Store {
    constructor(options = {}) {
        super(options);
        this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;

        if (options.sweep !== false) {
            this.sweeper = setInterval(() => {
                this.sweep().catch((err) => {
                    // A failed sweep is not worth crashing over; expired rows
                    // are ignored on read regardless.
                    console.error('Session sweep failed:', err.message);
                });
            }, SWEEP_INTERVAL_MS);
            if (this.sweeper.unref) this.sweeper.unref();
        }
    }

    expiryFor(sess) {
        const cookieExpiry = sess && sess.cookie && sess.cookie.expires;
        if (cookieExpiry) return new Date(cookieExpiry);
        return new Date(Date.now() + this.ttlMs);
    }

    get(sid, callback) {
        // Expired rows are treated as absent, so a stale session cannot be
        // resurrected in the window before the sweeper removes it.
        db.queryOne(
            'SELECT payload FROM sessions WHERE sid = $1 AND expires_at > now()',
            [sid]
        )
            .then((row) => callback(null, row ? row.payload : null))
            .catch((err) => callback(err));
    }

    set(sid, sess, callback) {
        db.query(
            `INSERT INTO sessions (sid, payload, expires_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (sid) DO UPDATE SET
               payload = EXCLUDED.payload,
               expires_at = EXCLUDED.expires_at`,
            [sid, JSON.stringify(sess), this.expiryFor(sess)]
        )
            .then(() => callback(null))
            .catch((err) => callback(err));
    }

    destroy(sid, callback) {
        db.query('DELETE FROM sessions WHERE sid = $1', [sid])
            .then(() => callback(null))
            .catch((err) => callback(err));
    }

    /**
     * Extend expiry without rewriting the payload.
     *
     * Only writes when the new expiry is meaningfully later than what is
     * stored. Without the threshold this fires on every request — for 32
     * officers working through 20 questions that is thousands of pointless
     * writes, and on a free database tier that is worth avoiding.
     */
    touch(sid, sess, callback) {
        const expiresAt = this.expiryFor(sess);
        db.query(
            `UPDATE sessions SET expires_at = $2
              WHERE sid = $1
                AND expires_at < $3`,
            [sid, expiresAt, new Date(expiresAt.getTime() - TOUCH_THRESHOLD_MS)]
        )
            .then(() => callback(null))
            .catch(() => callback(null));   // a failed touch must not break the request
    }

    /** Remove expired rows. Called on an interval. */
    async sweep() {
        const rows = await db.query(
            'WITH removed AS (DELETE FROM sessions WHERE expires_at <= now() RETURNING 1) ' +
            'SELECT count(*)::int AS n FROM removed'
        );
        return rows.length ? rows[0].n : 0;
    }

    /** Drop every session. Used when rotating SESSION_SECRET. */
    async clearAll() {
        await db.query('DELETE FROM sessions');
    }

    /** Sessions currently live. Surfaced on /healthz for the facilitator. */
    async activeCount() {
        const row = await db.queryOne(
            'SELECT count(*)::int AS n FROM sessions WHERE expires_at > now()'
        );
        return row ? row.n : 0;
    }

    stop() {
        if (this.sweeper) clearInterval(this.sweeper);
    }
}

module.exports = PostgresSessionStore;
