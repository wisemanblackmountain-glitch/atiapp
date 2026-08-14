/**
 * Failed-login rate limiting.
 *
 * ── Why this is keyed on the account, not the address ───────────────────────
 * The obvious implementation counts failures per IP. That is wrong for how this
 * system is actually used: 32 officers sit the assessment together, in one
 * training room, behind one router — so they all share a single public IP. A
 * per-IP counter of 5 would mean five different people each mistyping once locks
 * out the entire cohort for fifteen minutes, most likely during the opening
 * rush when everyone signs in at once from freshly handed-out slips.
 *
 * So the limit that protects a PIN is keyed on the participant number: an
 * officer who fumbles their own credentials affects only themselves. A far
 * looser per-IP ceiling sits behind it to catch automated guessing sprayed
 * across many accounts, at a threshold a real room will not reach.
 *
 * The account limit is what makes a 6-digit PIN safe — five guesses against one
 * million combinations. The IP ceiling is defence in depth, not the control.
 *
 * Counters live in process memory, matching the single-instance deployment.
 * Running more than one instance would give each its own counters and multiply
 * the effective allowance; that is noted in DEPLOYMENT.md as the thing to fix
 * before scaling out.
 */

'use strict';

const MAX_PER_ACCOUNT = 5;
// A full room fumbling twice each is ~64 failures; 100 leaves headroom while
// still catching a script working through the roster.
const MAX_PER_IP = 100;
const WINDOW_MS = 15 * 60 * 1000;
const SWEEP_MS = 5 * 60 * 1000;

const buckets = new Map();

function addressOf(req) {
    return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}

/**
 * Bucket keys.
 *
 * The scope prefix keeps the two realms independent — a locked-out officer must
 * not also lock the facilitator out of the admin console from the same address.
 */
const accountKey = (scope, identifier) => `${scope}:acct:${identifier}`;
const addressKey = (scope, req) => `${scope}:addr:${addressOf(req)}`;

function prune(entry, now) {
    entry.hits = entry.hits.filter((t) => now - t < WINDOW_MS);
    return entry;
}

function stateFor(key, max) {
    const entry = buckets.get(key);
    if (!entry) return { locked: false, remaining: max, retryAt: null };

    prune(entry, Date.now());
    if (entry.hits.length < max) {
        return { locked: false, remaining: max - entry.hits.length, retryAt: null };
    }
    return {
        locked: true,
        remaining: 0,
        retryAt: new Date(Math.min(...entry.hits) + WINDOW_MS),
    };
}

function hit(key) {
    const entry = buckets.get(key) || { hits: [] };
    prune(entry, Date.now());
    entry.hits.push(Date.now());
    buckets.set(key, entry);
}

/**
 * Current lockout state.
 *
 * @param {string} scope 'participant' | 'admin'
 * @param {string|null} identifier participant number or admin username;
 *        null when the request carried nothing usable, in which case only the
 *        address ceiling applies.
 *
 * `remaining` always reports the account allowance, since that is the number
 * meaningful to someone mistyping their own PIN.
 */
function getState(req, scope, identifier = null) {
    const address = stateFor(addressKey(scope, req), MAX_PER_IP);
    if (identifier === null || identifier === undefined || identifier === '') {
        return {
            locked: address.locked,
            remaining: address.locked ? 0 : MAX_PER_ACCOUNT,
            retryAt: address.retryAt,
            reason: address.locked ? 'address' : null,
        };
    }

    const account = stateFor(accountKey(scope, identifier), MAX_PER_ACCOUNT);
    if (account.locked || address.locked) {
        return {
            locked: true,
            remaining: 0,
            // Report whichever lock lifts later, so the message is not optimistic.
            retryAt: [account.retryAt, address.retryAt].filter(Boolean)
                .sort((a, b) => b - a)[0] || null,
            reason: account.locked ? 'account' : 'address',
        };
    }
    return { locked: false, remaining: account.remaining, retryAt: null, reason: null };
}

/** Record a failed attempt against both the account and the address. */
function recordFailure(req, scope, identifier = null) {
    if (identifier !== null && identifier !== undefined && identifier !== '') {
        hit(accountKey(scope, identifier));
    }
    hit(addressKey(scope, req));
    return getState(req, scope, identifier);
}

/**
 * Clear on success.
 *
 * Only the account bucket is cleared. The address counter is left to decay on
 * its own — a successful sign-in from one officer says nothing about whether
 * the address is being used to guess at others.
 */
function clear(req, scope, identifier = null) {
    if (identifier !== null && identifier !== undefined && identifier !== '') {
        buckets.delete(accountKey(scope, identifier));
    }
}

/** Local clock time for the lockout message, e.g. "14:32". */
function formatRetryAt(date) {
    if (!date) return null;
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Guard a login route.
 *
 * `identifierFrom` pulls the account identifier out of the request body.
 * express.urlencoded has already run at application level, so req.body is
 * populated by the time this executes.
 */
function guard(scope, view, identifierFrom, extraLocals = {}) {
    return function rateLimitGuard(req, res, next) {
        const identifier = typeof identifierFrom === 'function' ? identifierFrom(req) : null;
        const state = getState(req, scope, identifier);
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
// per address that ever mistyped a PIN.
const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets) {
        prune(entry, now);
        if (entry.hits.length === 0) buckets.delete(key);
    }
}, SWEEP_MS);
if (sweeper.unref) sweeper.unref();

module.exports = {
    MAX_PER_ACCOUNT,
    MAX_PER_IP,
    WINDOW_MS,
    guard,
    getState,
    recordFailure,
    clear,
    formatRetryAt,
    _buckets: buckets,   // exposed for tests
};
