/**
 * Authentication and access control.
 *
 * Two independent realms share one session:
 *   participant — participant number + surname + 6-digit PIN
 *   admin       — username + password (bcrypt)
 *
 * They are separate session keys rather than one user with a role field. An
 * admin must never satisfy a participant guard and vice versa, even if a bug
 * leaves a stale value behind: admin/result-detail.ejs renders the answer key,
 * so a role check that could be confused is a route to leaking it.
 */

'use strict';

const participants = require('../data/participants');
const admins = require('../data/admins');
const attemptsRepo = require('../data/attempts');
const asyncHandler = require('../utils/asyncHandler');

/**
 * Publish the signed-in participant and admin to every template.
 *
 * Reads through to the store rather than trusting the session copy, so an
 * officer deactivated mid-session stops being treated as signed in.
 */
const addUserToLocals = asyncHandler(async (req, res, next) => {
    res.locals.user = null;
    res.locals.admin = null;

    try {
        if (req.session && req.session.participantNumber) {
            const participant = await participants.getByNumber(req.session.participantNumber);
            if (participant && participant.is_active) {
                res.locals.user = participant;
                req.participant = participant;
            } else {
                delete req.session.participantNumber;
            }
        }

        if (req.session && req.session.adminUsername) {
            const admin = await admins.getByUsername(req.session.adminUsername);
            if (admin) {
                res.locals.admin = { id: admin.id, username: admin.username };
                req.admin = res.locals.admin;
            } else {
                delete req.session.adminUsername;
            }
        }
    } catch (err) {
        // Before seeding — or during a brief Firestore blip — nobody is signed
        // in. That must not take down every page in the application.
        res.locals.user = null;
        res.locals.admin = null;
    }

    next();
});

function requireParticipant(req, res, next) {
    if (req.participant) return next();
    return res.redirect('/login');
}

function requireAdmin(req, res, next) {
    if (req.admin) return next();
    return res.redirect('/admin/login');
}

/**
 * Load the participant's attempt and attach it.
 *
 * Redirects rather than erroring when the attempt is in the wrong state, so an
 * officer who reloads a stale URL lands on the screen matching where they
 * actually are.
 */
function loadAttempt(options = {}) {
    const { requireInProgress = false, requireSubmitted = false } = options;

    return asyncHandler(async (req, res, next) => {
        const attempt = await attemptsRepo.getByParticipant(req.participant.participant_number);

        if (!attempt) {
            if (requireInProgress || requireSubmitted) return res.redirect('/assessment/confirm');
            req.attempt = null;
            return next();
        }

        const finished = attempt.status === 'COMPLETED' || attempt.status === 'TIMED_OUT';

        // A finished attempt is never reopened — one attempt per officer.
        if (requireInProgress && finished) return res.redirect('/assessment/results');
        if (requireSubmitted && !finished) return res.redirect('/assessment/questions/1');

        req.attempt = attempt;
        return next();
    });
}

module.exports = {
    addUserToLocals,
    requireParticipant,
    requireAdmin,
    loadAttempt,
};
