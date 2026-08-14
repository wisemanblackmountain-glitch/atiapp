/**
 * Authentication routes — both realms.
 *
 * Mounted at '/', so the admin login path is written out in full here. It is
 * registered before the admin router precisely so it stays outside requireAdmin.
 *
 * Locked contract, DEVELOPER_HANDOFF §14.1:
 *   POST /login       { participantNumber, lastName, accessPin }
 *   POST /admin/login { username, password }
 */

'use strict';

const express = require('express');

const participants = require('../data/participants');
const admins = require('../data/admins');
const rateLimit = require('../middleware/rateLimit');
const asyncHandler = require('../utils/asyncHandler');
const {
    verifyCsrf,
    validateParticipantLogin,
    validateAdminLogin,
    cleanDigits,
    cleanText,
} = require('../middleware/validation');

const router = express.Router();

/**
 * Account identifiers for rate limiting.
 *
 * The guard and the failure handler must derive these identically, or they
 * would count against different buckets and the limit would never trigger.
 * Both are normalised: "07" and "7" are the same officer, and usernames are
 * compared lower-case, so padding or capitalisation cannot buy extra attempts.
 */
function participantIdentifier(req) {
    const n = Number(cleanDigits(req.body && req.body.participantNumber, 2));
    return Number.isInteger(n) && n > 0 ? String(n) : null;
}

function adminIdentifier(req) {
    return cleanText(req.body && req.body.username, 60).toLowerCase() || null;
}

/**
 * Regenerate the session on privilege change.
 *
 * Prevents session fixation: an attacker who plants a known session id cannot
 * ride it into an authenticated session. The CSRF token is not carried over —
 * the new session gets a fresh one.
 */
function regenerate(req) {
    return new Promise((resolve, reject) => {
        req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });
}

// ── Participant ──────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
    if (req.participant) return res.redirect('/assessment/confirm');
    // No participant number on a GET, so this reflects the address ceiling only.
    const state = rateLimit.getState(req, 'participant');
    res.render('auth/login', {
        title: 'Participant sign-in',
        nav: 'none',
        lockedUntil: state.locked ? rateLimit.formatRetryAt(state.retryAt) : null,
    });
});

router.post(
    '/login',
    verifyCsrf,
    rateLimit.guard('participant', 'auth/login', participantIdentifier),
    asyncHandler(async (req, res) => {
        const check = validateParticipantLogin(req.body);
        if (!check.ok) {
            return res.status(400).render('auth/login', {
                title: 'Participant sign-in',
                nav: 'none',
                error: check.message,
                values: check.values,
            });
        }

        const { participantNumber, lastName, accessPin } = check.data;
        const participant = await participants.verifyCredentials(
            participantNumber, lastName, accessPin
        );

        if (!participant) {
            const state = rateLimit.recordFailure(req, 'participant', participantIdentifier(req));
            return res.status(401).render('auth/login', {
                title: 'Participant sign-in',
                nav: 'none',
                // Deliberately does not name the failing field — that would let
                // a caller enumerate valid participant numbers.
                error: state.remaining > 0
                    ? `Those details do not match an authorised officer. ${state.remaining} attempt${state.remaining === 1 ? '' : 's'} remaining.`
                    : 'Those details do not match an authorised officer.',
                values: check.values,
                lockedUntil: state.locked ? rateLimit.formatRetryAt(state.retryAt) : null,
            });
        }

        rateLimit.clear(req, 'participant', participantIdentifier(req));
        await regenerate(req);
        req.session.participantNumber = participant.participant_number;

        return res.redirect('/assessment/confirm');
    })
);

// ── Administrator ────────────────────────────────────────────────────────

router.get('/admin/login', (req, res) => {
    if (req.admin) return res.redirect('/admin/dashboard');
    const state = rateLimit.getState(req, 'admin');
    res.render('auth/admin-login', {
        title: 'Facilitator sign-in',
        nav: 'none',
        lockedUntil: state.locked ? rateLimit.formatRetryAt(state.retryAt) : null,
    });
});

router.post(
    '/admin/login',
    verifyCsrf,
    rateLimit.guard('admin', 'auth/admin-login', adminIdentifier),
    asyncHandler(async (req, res) => {
        const check = validateAdminLogin(req.body);
        if (!check.ok) {
            return res.status(400).render('auth/admin-login', {
                title: 'Facilitator sign-in',
                nav: 'none',
                error: check.message,
            });
        }

        const admin = await admins.verifyCredentials(check.data.username, check.data.password);

        if (!admin) {
            const state = rateLimit.recordFailure(req, 'admin', adminIdentifier(req));
            return res.status(401).render('auth/admin-login', {
                title: 'Facilitator sign-in',
                nav: 'none',
                error: 'Those credentials were not recognised.',
                lockedUntil: state.locked ? rateLimit.formatRetryAt(state.retryAt) : null,
            });
        }

        rateLimit.clear(req, 'admin', adminIdentifier(req));
        await regenerate(req);
        req.session.adminUsername = admin.username;

        return res.redirect('/admin/dashboard');
    })
);

// ── Sign out ─────────────────────────────────────────────────────────────

router.post('/logout', verifyCsrf, (req, res) => {
    const wasAdmin = Boolean(req.admin);
    req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.redirect(wasAdmin ? '/admin/login' : '/');
    });
});

module.exports = router;
