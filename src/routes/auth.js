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
const audit = require('../data/audit');
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

        /*
         * Access withdrawn by proctoring gets its own message.
         *
         * Normally the login refuses to say which field was wrong, because
         * that would let a caller enumerate participant numbers. This is the
         * one exception, and it is safe: revocation only ever follows a
         * successful sign-in, so the caller already proved they hold the
         * credentials. Telling them "credentials do not match" would send an
         * officer hunting for a typo that does not exist, while the facilitator
         * who can actually help is standing beside them.
         */
        if (!participant && await participants.isRevoked(participantNumber)) {
            rateLimit.recordFailure(req, 'participant', participantIdentifier(req));
            return res.status(401).render('auth/login', {
                title: 'Participant sign-in',
                nav: 'none',
                error: 'Your access was withdrawn because the assessment window was closed. '
                    + 'Speak to the facilitator, who will issue you a new PIN.',
                values: check.values,
            });
        }

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

        // Marks the PIN as used, which closes off casual reissue from the
        // roster. Awaited so the state is settled before the officer can act.
        await participants.recordSignIn(participant.participant_number);

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
        await admins.recordSignIn(admin.username);
        await regenerate(req);
        req.session.adminUsername = admin.username;

        return res.redirect('/admin/dashboard');
    })
);

// ── Redeem an invitation ─────────────────────────────────────────────────
// The one administrator route reachable without signing in — necessarily, since
// the person using it has no account yet. Gated entirely by possession of a
// valid, unexpired, unredeemed code.

router.get('/admin/join', (req, res) => {
    if (req.admin) return res.redirect('/admin/dashboard');
    res.render('auth/admin-join', {
        title: 'Set up your account',
        nav: 'none',
        minLength: admins.MIN_PASSWORD_LENGTH,
        values: { code: cleanText(req.query.code || '', 40) },
    });
});

router.post(
    '/admin/join',
    verifyCsrf,
    rateLimit.guard('admin-join', 'auth/admin-join', (req) => cleanText(req.body.code, 40).toUpperCase(), {
        minLength: admins.MIN_PASSWORD_LENGTH,
    }),
    asyncHandler(async (req, res) => {
        const code = cleanText(req.body.code, 40);
        const username = cleanText(req.body.username, 40);
        const password = String(req.body.password || '');
        const confirm = String(req.body.confirmPassword || '');

        const render = (error) => res.status(400).render('auth/admin-join', {
            title: 'Set up your account',
            nav: 'none',
            minLength: admins.MIN_PASSWORD_LENGTH,
            values: { code, username },
            error,
        });

        if (password !== confirm) return render('The two passwords do not match.');

        const result = await admins.acceptInvitation({ code, username, password });

        if (!result.ok) {
            // An invalid code is rate limited: without it, the code space could
            // be walked from outside with no account required.
            if (result.reason === 'invalid-code') {
                rateLimit.recordFailure(req, 'admin-join', code.toUpperCase());
                return render('That invitation code is not valid, has expired, or has already been used.');
            }
            if (result.reason === 'username-taken') return render('That username is already taken.');
            if (result.reason === 'invalid-username') {
                return render('Usernames are 3–40 characters: letters, numbers, dot, underscore or hyphen.');
            }
            return render(`Choose a password of at least ${admins.MIN_PASSWORD_LENGTH} characters.`);
        }

        await audit.record({
            adminUsername: result.username,
            action: 'ADMIN_JOINED',
            detail: { full_name: result.fullName, role: result.role },
            ipAddress: req.ip,
        });

        rateLimit.clear(req, 'admin-join', code.toUpperCase());
        await regenerate(req);
        req.session.adminUsername = result.username;
        await admins.recordSignIn(result.username);

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
