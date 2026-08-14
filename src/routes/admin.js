/**
 * Administrator routes. Mounted at '/admin'.
 *
 * ⚠ This is the only router permitted to read the answer key. Every route sits
 *   behind requireAdmin. Nothing here may be reused by a participant-facing
 *   route — see the warning at the head of views/admin/result-detail.ejs.
 *
 * GET/POST /admin/login is served by src/routes/auth.js, mounted earlier and
 * therefore outside the guard below.
 *
 * Locals must match VIEW_CONTRACT.md §4.
 */

'use strict';

const express = require('express');
const crypto = require('crypto');

const db = require('../data/pool');
const participantsRepo = require('../data/participants');
const attemptsRepo = require('../data/attempts');
const auditRepo = require('../data/audit');
const proctoring = require('../data/proctoring');
const scoring = require('../engines/scoring');
const asyncHandler = require('../utils/asyncHandler');
const { requireAdmin } = require('../middleware/auth');
const { verifyCsrf } = require('../middleware/validation');

const router = express.Router();

router.use(requireAdmin);

const STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'TIMED_OUT'];

/** Six digits from a CSPRNG, matching the seeder. */
function generatePin() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/** Participant number from the URL, or null if it is not a plausible one. */
function participantNumberParam(req) {
    const n = Number(req.params.participantNumber);
    return Number.isInteger(n) && n >= 1 && n <= 999 ? n : null;
}

function isFinished(status) {
    return status === 'COMPLETED' || status === 'TIMED_OUT';
}

// ── Dashboard ────────────────────────────────────────────────────────────

router.get('/dashboard', asyncHandler(async (req, res) => {
    const roster = await attemptsRepo.rosterWithAttempts();
    const finished = roster.filter((r) => isFinished(r.status));

    const meanScore = finished.length
        ? Math.round((finished.reduce((sum, r) => sum + (r.score || 0), 0) / finished.length) * 10) / 10
        : null;

    const metrics = {
        roster: roster.length,
        completed: finished.length,
        in_progress: roster.filter((r) => r.status === 'IN_PROGRESS').length,
        not_started: roster.filter((r) => r.status === 'NOT_STARTED').length,
        mean_score: meanScore,
        mean_percentage: meanScore === null ? null : scoring.percentageFor(Math.round(meanScore)),
    };

    // All four bands always present, including zeros, so the chart shape stays
    // stable as results arrive.
    const distribution = scoring.KNOWLEDGE_LEVELS.map((band) => {
        const count = finished.filter((r) => r.knowledge_level === band.level).length;
        return {
            level: band.level,
            count,
            percent: finished.length ? Math.round((count / finished.length) * 100) : 0,
        };
    });

    return res.render('admin/dashboard', {
        title: 'Dashboard',
        nav: 'admin',
        navTitle: 'Administration',
        metrics,
        distribution,
    });
}));

// ── Roster ───────────────────────────────────────────────────────────────

router.get('/participants', asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const status = STATUSES.includes(req.query.status) ? req.query.status : '';

    const [all, proctorSummary] = await Promise.all([
        attemptsRepo.rosterWithAttempts(),
        proctoring.summary(),
    ]);
    const needle = q.toLowerCase();

    // Attach proctoring state so the roster shows at a glance who has left the
    // window — this is the "facilitator is notified" half of the rule.
    all.forEach((row) => {
        const p = proctorSummary[row.participant_number];
        row.proctor = p || { hidden: 0, warned: 0, ejected: 0 };
    });

    // Filtered in memory rather than SQL: the roster is 32 rows, and a LIKE
    // across four columns would be more machinery than the problem needs.
    const participants = all.filter((row) => {
        if (status && row.status !== status) return false;
        if (!needle) return true;
        return [row.full_name, row.agency, row.title, String(row.participant_number)]
            .filter(Boolean)
            .some((field) => String(field).toLowerCase().includes(needle));
    });

    return res.render('admin/participants', {
        title: 'Participant roster',
        nav: 'admin',
        navTitle: 'Administration',
        participants,
        filters: { q, status },
        total: all.length,
        // Set after a retake is granted, so the roster confirms what happened.
        // Carried in the querystring rather than a session flash — it is not
        // sensitive, and it keeps the redirect stateless.
        success: req.query.retake
            ? `Officer ${String(req.query.retake).padStart(2, '0')} may now sit the assessment again.`
            : null,
    });
}));

// ── Destructive actions ──────────────────────────────────────────────────
// Both write their audit row inside the same transaction as the change, so a
// rolled-back action cannot leave a record claiming it happened.

/**
 * Clear an officer's attempt so they can sit again.
 *
 * For the genuine cases: a browser crashed mid-assessment, the wrong person
 * signed in, a session was lost. Cascades to mappings and responses, so the
 * retake gets a fresh option randomisation rather than the layout already seen.
 */
router.post('/participants/:participantNumber/retake', verifyCsrf, asyncHandler(async (req, res) => {
    const number = participantNumberParam(req);
    if (number === null) return res.redirect('/admin/participants');

    const participant = await participantsRepo.getByNumber(number);
    if (!participant) {
        return res.status(404).render('error', {
            title: 'Not Found',
            message: 'No officer with that participant number is on the roster.',
            nav: 'admin',
        });
    }

    const discarded = await db.transaction(async (client) => {
        const attempt = await attemptsRepo.deleteForParticipant(number, client);
        if (!attempt) return null;

        await auditRepo.record({
            adminUsername: req.admin.username,
            action: auditRepo.ACTIONS.RETAKE_ALLOWED,
            participantNumber: number,
            // Captured before the row is gone — afterwards there is nothing
            // left to describe.
            detail: {
                discarded_status: attempt.status,
                discarded_score: attempt.score,
                discarded_percentage: attempt.percentage,
                discarded_knowledge_level: attempt.knowledge_level,
                started_at: attempt.started_at,
                submitted_at: attempt.submitted_at,
            },
            ipAddress: req.ip,
        }, client);

        return attempt;
    });

    // No attempt to clear is not an error — the officer can already sit it.
    if (!discarded) return res.redirect('/admin/participants');
    return res.redirect(`/admin/participants?retake=${number}`);
}));

/**
 * Issue a new PIN for one officer.
 *
 * The seeder reissues all 32, which is right at setup and wrong on the day —
 * an officer who mislays their slip would otherwise invalidate the 31 already
 * distributed.
 *
 * The new PIN is rendered once, directly. It is deliberately not redirected to,
 * flashed through the session, or logged: the session store is the database, so
 * a flashed PIN would be written to disk in plaintext, which is the one thing
 * this system avoids everywhere else.
 */
router.post('/participants/:participantNumber/reissue-pin', verifyCsrf, asyncHandler(async (req, res) => {
    const number = participantNumberParam(req);
    if (number === null) return res.redirect('/admin/participants');

    const participant = await participantsRepo.getByNumber(number);
    if (!participant) {
        return res.status(404).render('error', {
            title: 'Not Found',
            message: 'No officer with that participant number is on the roster.',
            nav: 'admin',
        });
    }

    /*
     * A PIN may be regenerated freely while it is still untried — that is when
     * distribution mistakes surface, and reissuing costs nothing because nobody
     * has used it.
     *
     * Once the officer has signed in, the PIN has done its job and changing it
     * disrupts them, so reissue is refused. Refused rather than forbidden: an
     * officer who signs in on one day and loses their slip before the next would
     * otherwise be stranded with no route back in. The override requires a
     * separate deliberate action and is audited distinctly, so "why does officer
     * 12 have three PINs?" stays answerable.
     */
    const usage = await participantsRepo.pinUsage(number);
    const override = req.body.override === '1';

    if (usage && usage.used && !override) {
        return res.status(409).render('admin/pin-blocked', {
            title: 'PIN already used',
            nav: 'admin',
            navTitle: 'Administration',
            participant,
            usage,
        });
    }

    const pin = generatePin();

    await db.transaction(async (client) => {
        const updated = await participantsRepo.setPin(number, pin, client);
        if (!updated) throw new Error(`Failed to set PIN for participant ${number}.`);

        await auditRepo.record({
            adminUsername: req.admin.username,
            action: auditRepo.ACTIONS.PIN_REISSUED,
            participantNumber: number,
            // The PIN itself is never recorded, here or anywhere.
            detail: usage && usage.used
                ? { reason: 'facilitator reissue', overrode_used_pin: true }
                : { reason: 'facilitator reissue', pin_was_untried: true },
            ipAddress: req.ip,
        }, client);
    });

    return res.render('admin/pin-reissued', {
        title: 'New PIN issued',
        nav: 'admin',
        navTitle: 'Administration',
        participant,
        pin,
    });
}));

/**
 * Reissue PINs for many officers at once.
 *
 * The seeder can already do this, but only by discarding every attempt — safe
 * before a cohort starts, destructive once anyone has sat it. Mistakes with
 * printed slips do not respect that boundary, so this route reissues in bulk
 * and leaves attempts, responses and scores untouched.
 *
 * scope:
 *   all          every active officer
 *   not_started  only those yet to begin — the safe default when an
 *                assessment is already under way, since it cannot disturb
 *                anyone mid-attempt
 */
router.post('/participants/reissue-pins', verifyCsrf, asyncHandler(async (req, res) => {
    const scope = req.body.scope === 'all' ? 'all' : 'not_started';

    const roster = await attemptsRepo.rosterWithAttempts();
    const targets = scope === 'all'
        ? roster
        : roster.filter((r) => r.status === 'NOT_STARTED');

    if (targets.length === 0) {
        return res.redirect('/admin/participants');
    }

    // Hash outside the transaction. bcrypt is CPU-bound and pure JS, so 32 of
    // them takes seconds — long enough to hold a database connection open
    // needlessly and risk the statement timeout.
    const issued = [];
    for (const t of targets) {
        issued.push({ participant: t, pin: generatePin() });
    }
    const hashes = await Promise.all(issued.map((i) => participantsRepo.hashPin(i.pin)));

    await db.transaction(async (client) => {
        for (let i = 0; i < issued.length; i++) {
            await client.query(
                'UPDATE participants SET pin_hash = $2 WHERE participant_number = $1',
                [issued[i].participant.participant_number, hashes[i]]
            );
            await auditRepo.record({
                adminUsername: req.admin.username,
                action: auditRepo.ACTIONS.PIN_REISSUED,
                participantNumber: issued[i].participant.participant_number,
                detail: { reason: 'bulk reissue', scope },
                ipAddress: req.ip,
            }, client);
        }
    });

    return res.render('admin/pins-reissued', {
        title: 'PINs reissued',
        nav: 'admin',
        navTitle: 'Administration',
        scope,
        issued,
        skipped: roster.length - targets.length,
    });
}));

// ── Audit log ────────────────────────────────────────────────────────────

router.get('/audit', asyncHandler(async (req, res) => {
    return res.render('admin/audit', {
        title: 'Audit log',
        nav: 'admin',
        navTitle: 'Administration',
        entries: await auditRepo.listRecent(200),
    });
}));

// ── Individual report ────────────────────────────────────────────────────

/** ⚠ Renders correct_option_text and is_correct. Administrator realm only. */
router.get('/results/:participantNumber', asyncHandler(async (req, res) => {
    const number = Number(req.params.participantNumber);
    if (!Number.isInteger(number)) return res.redirect('/admin/participants');

    const participant = await participantsRepo.getByNumber(number);
    if (!participant) {
        return res.status(404).render('error', {
            title: 'Not Found',
            message: 'No officer with that participant number is on the roster.',
            nav: 'admin',
        });
    }

    const attempt = await attemptsRepo.getByParticipant(number);
    if (!attempt || !isFinished(attempt.status)) {
        return res.status(404).render('error', {
            title: 'No report available',
            message: 'This officer has not completed the assessment, so there is no report to show.',
            nav: 'admin',
        });
    }

    const rows = await attemptsRepo.getAuditRows(number);

    return res.render('admin/result-detail', {
        title: `Report — ${participant.full_name}`,
        nav: 'admin',
        navTitle: 'Administration',
        participant,
        attempt,
        responses: rows.map((r) => ({
            question_number: r.question_number,
            section_label: r.section_label,
            question_text: r.question_text,
            selected_display_position: r.selected_display_position || null,
            selected_option_text: r.selected_option_text || null,
            correct_option_text: r.correct_option_text || '',
            // Tri-state preserved so the view can tell unanswered from
            // answered-and-wrong.
            is_correct: r.is_correct === null || r.is_correct === undefined
                ? null
                : Boolean(r.is_correct),
        })),
    });
}));

// ── Analytics ────────────────────────────────────────────────────────────

async function buildAnalytics() {
    const [attempts, distribution, difficulty] = await Promise.all([
        attemptsRepo.listAll(),
        attemptsRepo.getScoreDistribution(),
        attemptsRepo.getItemDifficulty(),
    ]);

    const scores = Object.values(attempts)
        .filter((a) => isFinished(a.status) && a.score !== null)
        .map((a) => a.score)
        .sort((a, b) => a - b);

    const summary = {
        attempts: scores.length,
        mean_score: scores.length
            ? Math.round((scores.reduce((s, v) => s + v, 0) / scores.length) * 10) / 10
            : null,
        median_score: scores.length
            ? (scores.length % 2
                ? scores[(scores.length - 1) / 2]
                : Math.round(((scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2) * 10) / 10)
            : null,
        highest: scores.length ? scores[scores.length - 1] : null,
        lowest: scores.length ? scores[0] : null,
    };

    // All 21 buckets, 0..20, including empties — a gap-free axis.
    const counts = new Map(distribution.map((d) => [Number(d.score), Number(d.count)]));
    const histogram = Array.from({ length: scoring.TOTAL_MARKS + 1 }, (_, score) => ({
        score,
        count: counts.get(score) || 0,
    }));

    const items = difficulty.map((row) => ({
        question_number: row.question_number,
        section_label: row.section_label,
        question_text: row.question_text,
        correct_count: row.correct_count,
        attempted_count: row.attempted_count,
        difficulty_percent: row.attempted_count
            ? Math.round((row.correct_count / row.attempted_count) * 100)
            : 0,
    }));

    return { summary, histogram, items };
}

router.get('/analytics', asyncHandler(async (req, res) => {
    const { summary, histogram, items } = await buildAnalytics();
    return res.render('admin/analytics', {
        title: 'Cohort analytics',
        nav: 'admin',
        navTitle: 'Administration',
        summary,
        histogram,
        items,
    });
}));

/** RFC 4180 field escaping. */
function csvCell(value) {
    const s = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get('/analytics/export.csv', asyncHandler(async (req, res) => {
    const roster = await attemptsRepo.rosterWithAttempts();
    const header = [
        'participant_number', 'full_name', 'title', 'agency',
        'status', 'score', 'total_marks', 'percentage', 'knowledge_level',
    ];
    const lines = [header.join(',')];

    for (const row of roster) {
        lines.push([
            row.participant_number, row.full_name, row.title, row.agency,
            row.status, row.score, row.total_marks, row.percentage, row.knowledge_level,
        ].map(csvCell).join(','));
    }

    // BOM so Excel opens UTF-8 names correctly rather than mangling them.
    const body = '﻿' + lines.join('\r\n') + '\r\n';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="ati-zmatf-results.csv"');
    return res.send(body);
}));

module.exports = router;
