/**
 * Authentication and access control.
 *
 * Two independent realms share one session:
 *   participant — participant number + surname + 6-digit PIN
 *   admin       — username + password (bcrypt)
 *
 * They are deliberately separate keys on the session rather than one `user`
 * with a role field. An admin must never satisfy a participant guard, and a
 * participant must never satisfy an admin guard, even if a future bug leaves a
 * stale value behind: admin/result-detail.ejs renders the answer key, so a
 * role check that could be confused is a route to leaking it.
 */

'use strict';

const db = require('../utils/db');

/**
 * Publish the signed-in participant to every template.
 *
 * Registered globally in server.js. Reads from the database rather than
 * trusting the session copy, so a participant deactivated mid-session stops
 * being treated as signed in.
 */
function addUserToLocals(req, res, next) {
    res.locals.user = null;
    res.locals.admin = null;

    try {
        if (req.session && req.session.participantId) {
            const participant = db.get(
                `SELECT id, participant_number, full_name, title, agency, is_active
                   FROM participants WHERE id = ?`,
                [req.session.participantId]
            );
            if (participant && participant.is_active) {
                res.locals.user = participant;
                req.participant = participant;
            } else {
                delete req.session.participantId;
            }
        }

        if (req.session && req.session.adminId) {
            const admin = db.get('SELECT id, username FROM admin_users WHERE id = ?', [
                req.session.adminId,
            ]);
            if (admin) {
                res.locals.admin = admin;
                req.admin = admin;
            } else {
                delete req.session.adminId;
            }
        }
    } catch (err) {
        // Before seeding, these tables may not exist. A missing table must not
        // take down every page — it should just mean nobody is signed in.
        res.locals.user = null;
        res.locals.admin = null;
    }

    next();
}

/** Require a signed-in participant. */
function requireParticipant(req, res, next) {
    if (req.participant) return next();
    return res.redirect('/login');
}

/** Require a signed-in administrator. */
function requireAdmin(req, res, next) {
    if (req.admin) return next();
    return res.redirect('/admin/login');
}

/**
 * Load the participant's attempt and attach it.
 *
 * Redirects rather than erroring when the attempt is in the wrong state, so a
 * participant who reloads an old URL lands on the screen that matches where
 * they actually are.
 */
function loadAttempt(options = {}) {
    const { requireInProgress = false, requireSubmitted = false } = options;

    return function attemptLoader(req, res, next) {
        const attempt = db.get(
            'SELECT * FROM assessment_attempts WHERE participant_id = ?',
            [req.participant.id]
        );

        if (!attempt) {
            if (requireInProgress || requireSubmitted) return res.redirect('/assessment/confirm');
            req.attempt = null;
            return next();
        }

        const finished = attempt.status === 'COMPLETED' || attempt.status === 'TIMED_OUT';

        // A finished attempt can never be reopened — one attempt per officer.
        if (requireInProgress && finished) return res.redirect('/assessment/results');
        if (requireSubmitted && !finished) return res.redirect('/assessment/questions/1');

        req.attempt = attempt;
        return next();
    };
}

module.exports = {
    addUserToLocals,
    requireParticipant,
    requireAdmin,
    loadAttempt,
};
