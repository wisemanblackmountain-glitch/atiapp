/**
 * Failed-login rate limiting.
 *
 * 5 attempts per 15 minutes per IP, per DEVELOPER_HANDOFF §7.
 *
 * Counters live in process memory, which matches the MemoryStore session
 * strategy already in server.js. Both reset on restart, and neither survives
 * horizontal scaling — acceptable for a single-instance assessment running for
 * one cohort, and noted in VIEW_CONTRACT.md as the thing to revisit if this is
 * ever deployed behind more than one process.
 *
 * Only failures count. A successful sign-in clears the counter, so an officer
 * who mistypes twice and then succeeds is not left near a lockout.
 */

'use strict';

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const SWEEP_MS = 5 * 60 * 1000;

const buckets = new Map();

/**
 * Identify the caller.
 *
 * server.js sets `trust proxy` in production, so req.ip already reflects
 * X-Forwarded-For there. The scope prefix keeps participant and admin
 * lockouts independent — a locked-out participant should not also lock the
 * facilitator out of the admin console from the same office IP.
 */
function keyFor(req, scope) {
    return `${scope}:${req.ip || req.connection.remoteAddress || 'unknown'}`;
}

function prune(entry, now) {
    entry.hits = entry.hits.filter((t) => now - t < WINDOW_MS);
    return entry;
}

function getState(req, scope) {
    const key = keyFor(req, scope);
    const now = Date.now();
    const entry = buckets.get(key);
    if (!entry) return { locked: false, remaining: MAX_ATTEMPTS, retryAt: null };

    prune(entry, now);
    if (entry.hits.length < MAX_ATTEMPTS) {
        return { locked: false, remaining: MAX_ATTEMPTS - entry.hits.length, retryAt: null };
    }
    const oldest = Math.min(...entry.hits);
    return { locked: true, remaining: 0, retryAt: new Date(oldest + WINDOW_MS) };
}

function recordFailure(req, scope) {
    const key = keyFor(req, scope);
    const now = Date.now();
    const entry = buckets.get(key) || { hits: [] };
    prune(entry, now);
    entry.hits.push(now);
    buckets.set(key, entry);
    return getState(req, scope);
}

function clear(req, scope) {
    buckets.delete(keyFor(req, scope));
}

/** Local clock time for the lockout message, e.g. "14:32". */
function formatRetryAt(date) {
    if (!date) return null;
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Guard a login route.
 *
 * Renders the login view again with `lockedUntil` set, so the participant sees
 * the lockout in place rather than a bare error.
 */
function guard(scope, view, extraLocals = {}) {
    return function rateLimitGuard(req, res, next) {
        const state = getState(req, scope);
        if (!state.locked) return next();

        return res.status(429).render(view, Object.assign({
            title: 'Too many attempts',
            nav: 'none',
            lockedUntil: formatRetryAt(state.retryAt),
            layout: 'layouts/main',
        }, extraLocals));
    };
}

// Drop empty buckets so a long-running process does not accumulate one entry
// per IP that ever mistyped a PIN.
const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets) {
        prune(entry, now);
        if (entry.hits.length === 0) buckets.delete(key);
    }
}, SWEEP_MS);
if (sweeper.unref) sweeper.unref();

module.exports = {
    MAX_ATTEMPTS,
    WINDOW_MS,
    guard,
    getState,
    recordFailure,
    clear,
    formatRetryAt,
    _buckets: buckets,   // exposed for tests
};
