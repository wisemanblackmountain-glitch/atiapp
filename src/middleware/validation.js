/**
 * Input validation and CSRF protection.
 *
 * ── On csurf ────────────────────────────────────────────────────────────────
 * package.json lists csurf ^1.11.0. That package was deprecated and archived
 * by the Express team, and its default cookie mode carries a known bypass. The
 * synchroniser-token pattern below is what csurf did in session mode, in about
 * thirty lines, with no unmaintained dependency in the request path.
 *
 * The token lives in req.session, so it inherits the session cookie's
 * httpOnly, sameSite=lax and (in production) secure flags.
 *
 * Contract, per DEVELOPER_HANDOFF §8.2:
 *   forms → hidden input named _csrf
 *   AJAX  → X-CSRF-Token header
 */

'use strict';

const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Publish a per-session CSRF token to every template. */
function addCsrfToLocals(req, res, next) {
    if (req.session && !req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    res.locals.csrfToken = req.session ? req.session.csrfToken : '';
    next();
}

/**
 * Constant-time comparison.
 *
 * timingSafeEqual throws on length mismatch, which would itself leak length,
 * so lengths are checked first and unequal lengths simply fail.
 */
function tokensMatch(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Reject state-changing requests without a valid token.
 *
 * AJAX callers get JSON so public/js/assessment.js can react; form posts get
 * the rendered error page.
 */
function verifyCsrf(req, res, next) {
    if (SAFE_METHODS.has(req.method)) return next();

    const expected = req.session && req.session.csrfToken;
    const supplied = (req.body && req.body._csrf) || req.get('X-CSRF-Token') || '';

    if (expected && tokensMatch(expected, supplied)) return next();

    const wantsJson = req.xhr
        || req.is('application/json')
        || (req.get('Accept') || '').includes('application/json');

    if (wantsJson) {
        return res.status(403).json({ error: 'Invalid security token. Reload the page.' });
    }
    return res.status(403).render('error', {
        title: 'Security check failed',
        message: 'Your session security token was missing or out of date. Return to the start and sign in again.',
        layout: 'layouts/main',
        nav: 'none',
    });
}

// ── Field sanitisers ─────────────────────────────────────────────────────
// Views escape on output, so these normalise shape rather than strip markup.

/** Collapse whitespace and cap length. */
function cleanText(value, maxLength = 120) {
    if (typeof value !== 'string') return '';
    return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

/** Keep digits only, cap length. */
function cleanDigits(value, maxLength = 6) {
    if (typeof value !== 'string' && typeof value !== 'number') return '';
    return String(value).replace(/\D/g, '').slice(0, maxLength);
}

/**
 * Validate participant login input.
 *
 * Returns a single generic message rather than naming the failing field.
 * Telling an unauthenticated caller which of three values was wrong turns the
 * login form into an oracle for enumerating valid participant numbers.
 */
function validateParticipantLogin(body) {
    const participantNumber = cleanDigits(body.participantNumber, 2);
    const lastName = cleanText(body.lastName, 60);
    const accessPin = cleanDigits(body.accessPin, 6);

    const n = Number(participantNumber);
    const ok = participantNumber !== ''
        && Number.isInteger(n) && n >= 1 && n <= 32
        && lastName.length >= 2
        && accessPin.length === 6;

    return {
        ok,
        values: { participantNumber, lastName },   // accessPin is never echoed back
        data: { participantNumber: n, lastName, accessPin },
        message: ok ? null : 'Enter your participant number, surname and 6-digit PIN exactly as issued.',
    };
}

function validateAdminLogin(body) {
    const username = cleanText(body.username, 60);
    const password = typeof body.password === 'string' ? body.password : '';
    const ok = username.length >= 3 && password.length >= 1;
    return {
        ok,
        data: { username, password },
        message: ok ? null : 'Enter your username and password.',
    };
}

/** Validate a save-answer payload. Returns null when unusable. */
function validateAnswerPayload(body) {
    const questionId = Number(body && body.questionId);
    const raw = body && body.selectedPosition;
    const selectedPosition = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
    if (!Number.isInteger(questionId) || questionId < 1) return null;
    if (!['A', 'B', 'C', 'D'].includes(selectedPosition)) return null;
    return { questionId, selectedPosition };
}

module.exports = {
    addCsrfToLocals,
    verifyCsrf,
    cleanText,
    cleanDigits,
    validateParticipantLogin,
    validateAdminLogin,
    validateAnswerPayload,
};
