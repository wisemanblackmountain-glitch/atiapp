/**
 * Authentication routes — both realms.
 *
 * Mounted at '/' in server.js, so the admin login path is written out in full
 * here. It is registered before the admin router precisely so it stays outside
 * the requireAdmin guard.
 *
 * Locked contract, DEVELOPER_HANDOFF §14.1:
 *   POST /login       { participantNumber, lastName, accessPin }
 *   POST /admin/login { username, password }
 */

'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const db = require('../utils/db');
const rateLimit = require('../middleware/rateLimit');
const {
    verifyCsrf,
    validateParticipantLogin,
    validateAdminLogin,
} = require('../middleware/validation');

const router = express.Router();

/**
 * Constant-time string comparison for the PIN.
 *
 * A plain === on a secret leaks its prefix through timing. The difference is
 * small over a network, but it costs nothing to avoid.
 */
function secretsMatch(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Regenerate the session on privilege change.
 *
 * Prevents session fixation: an attacker who plants a known session id cannot
 * ride it into an authenticated session. The CSRF token is deliberately not
 * carried over — the new session gets a fresh one.
 */
function regenerate(req) {
    return new Promise((resolve, reject) => {
        req.session.regenerate((err) => (err ? reject(err) : resolve()));
    });
}

// ── Participant ──────────────────────────────────────────────────────────

router.get('/login', (req, res) => {
    if (req.participant) return res.redirect('/assessment/confirm');
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
    rateLimit.guard('participant', 'auth/login'),
    async (req, res, next) => {
        try {
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
            const participant = db.get(
                'SELECT * FROM participants WHERE participant_number = ? AND is_active = 1',
                [participantNumber]
            );

            // Surname compared case-insensitively; officers type it inconsistently
            // and the PIN is what actually carries the security.
            const surnameOk = participant
                && String(participant.last_name).trim().toLowerCase() === lastName.toLowerCase();
            const pinOk = participant && secretsMatch(participant.access_pin, accessPin);

            if (!participant || !surnameOk || !pinOk) {
                const state = rateLimit.recordFailure(req, 'participant');
                return res.status(401).render('auth/login', {
                    title: 'Participant sign-in',
                    nav: 'none',
                    // Deliberately does not say which field was wrong — that would
                    // let a caller enumerate valid participant numbers.
                    error: state.remaining > 0
                        ? `Those details do not match an authorised officer. ${state.remaining} attempt${state.remaining === 1 ? '' : 's'} remaining.`
                        : 'Those details do not match an authorised officer.',
                    values: check.values,
                    lockedUntil: state.locked ? rateLimit.formatRetryAt(state.retryAt) : null,
                });
            }

            rateLimit.clear(req, 'participant');
            await regenerate(req);
            req.session.participantId = participant.id;

            return res.redirect('/assessment/confirm');
        } catch (err) {
            return next(err);
        }
    }
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
    rateLimit.guard('admin', 'auth/admin-login'),
    async (req, res, next) => {
        try {
            const check = validateAdminLogin(req.body);
            if (!check.ok) {
                return res.status(400).render('auth/admin-login', {
                    title: 'Facilitator sign-in',
                    nav: 'none',
                    error: check.message,
                });
            }

            const admin = db.get('SELECT * FROM admin_users WHERE username = ?', [
                check.data.username,
            ]);

            // Hash a throwaway when the user is unknown, so a missing username
            // and a wrong password take the same time.
            const hash = admin
                ? admin.password_hash
                : '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu';
            const ok = await bcrypt.compare(check.data.password, hash);

            if (!admin || !ok) {
                const state = rateLimit.recordFailure(req, 'admin');
                return res.status(401).render('auth/admin-login', {
                    title: 'Facilitator sign-in',
                    nav: 'none',
                    error: 'Those credentials were not recognised.',
                    lockedUntil: state.locked ? rateLimit.formatRetryAt(state.retryAt) : null,
                });
            }

            rateLimit.clear(req, 'admin');
            await regenerate(req);
            req.session.adminId = admin.id;

            return res.redirect('/admin/dashboard');
        } catch (err) {
            return next(err);
        }
    }
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
