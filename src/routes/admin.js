/**
 * Administrator routes. Mounted at '/admin'.
 *
 * ⚠ This is the only router permitted to read options.is_correct or
 *   correct-answer text. Every route here sits behind requireAdmin. Nothing in
 *   this file may be reused by a participant-facing route — see the warning
 *   block at the head of views/admin/result-detail.ejs.
 *
 * Note: GET/POST /admin/login is served by src/routes/auth.js, which is mounted
 * earlier in server.js and therefore sits outside the guard below.
 *
 * Locals supplied here must match VIEW_CONTRACT.md §4.
 */

'use strict';

const express = require('express');

const db = require('../utils/db');
const scoring = require('../engines/scoring');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.use(requireAdmin);

const STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'TIMED_OUT'];

/** Roster joined to attempt state. status is derived, not stored. */
function rosterWithAttempts() {
    return db.all(
        `SELECT p.participant_number, p.full_name, p.title, p.agency,
                COALESCE(a.status, 'NOT_STARTED') AS status,
                a.score, a.total_marks, a.percentage, a.knowledge_level
           FROM participants p
      LEFT JOIN assessment_attempts a ON a.participant_id = p.id
          WHERE p.is_active = 1
       ORDER BY p.participant_number`
    );
}

function isFinished(status) {
    return status === 'COMPLETED' || status === 'TIMED_OUT';
}

// ── Dashboard ────────────────────────────────────────────────────────────

router.get('/dashboard', (req, res, next) => {
    try {
        const roster = rosterWithAttempts();
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
            mean_percentage: meanScore === null
                ? null
                : scoring.percentageFor(Math.round(meanScore)),
        };

        // All four bands are always present, including zeros, so the chart shape
        // stays stable as results arrive.
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
    } catch (err) {
        return next(err);
    }
});

// ── Roster ───────────────────────────────────────────────────────────────

router.get('/participants', (req, res, next) => {
    try {
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        const status = STATUSES.includes(req.query.status) ? req.query.status : '';

        const all = rosterWithAttempts();
        const needle = q.toLowerCase();

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
        });
    } catch (err) {
        return next(err);
    }
});

// ── Individual report ────────────────────────────────────────────────────

/**
 * Item-level audit for one officer.
 *
 * ⚠ Renders correct_option_text and is_correct. Administrator realm only.
 */
router.get('/results/:participantNumber', (req, res, next) => {
    try {
        const number = Number(req.params.participantNumber);
        if (!Number.isInteger(number)) return res.redirect('/admin/participants');

        const participant = db.get(
            'SELECT * FROM participants WHERE participant_number = ?',
            [number]
        );
        if (!participant) {
            return res.status(404).render('error', {
                title: 'Not Found',
                message: 'No officer with that participant number is on the roster.',
                nav: 'admin',
            });
        }

        const attempt = db.get(
            'SELECT * FROM assessment_attempts WHERE participant_id = ?',
            [participant.id]
        );
        if (!attempt || !isFinished(attempt.status)) {
            return res.status(404).render('error', {
                title: 'No report available',
                message: 'This officer has not completed the assessment, so there is no report to show.',
                nav: 'admin',
            });
        }

        const responses = db.all(
            `SELECT q.question_number, q.section_label, q.question_text,
                    r.selected_display_position,
                    sel.option_text AS selected_option_text,
                    cor.option_text AS correct_option_text,
                    r.is_correct
               FROM questions q
          LEFT JOIN responses r ON r.question_id = q.id AND r.attempt_id = ?
          LEFT JOIN options sel ON sel.id = r.selected_option_id
          LEFT JOIN options cor ON cor.question_id = q.id AND cor.is_correct = 1
           ORDER BY q.question_number`,
            [attempt.id]
        );

        return res.render('admin/result-detail', {
            title: `Report — ${participant.full_name}`,
            nav: 'admin',
            navTitle: 'Administration',
            participant,
            attempt,
            responses: responses.map((r) => ({
                question_number: r.question_number,
                section_label: r.section_label,
                question_text: r.question_text,
                selected_display_position: r.selected_display_position || null,
                selected_option_text: r.selected_option_text || null,
                correct_option_text: r.correct_option_text || '',
                // sql.js returns NULL as null; keep the tri-state intact so the
                // view can distinguish unanswered from answered-and-wrong.
                is_correct: r.is_correct === null || r.is_correct === undefined
                    ? null
                    : Boolean(r.is_correct),
            })),
        });
    } catch (err) {
        return next(err);
    }
});

// ── Analytics ────────────────────────────────────────────────────────────

function buildAnalytics() {
    const attempts = db.all(
        `SELECT id, score FROM assessment_attempts
          WHERE status IN ('COMPLETED', 'TIMED_OUT') AND score IS NOT NULL`
    );

    const scores = attempts.map((a) => a.score).sort((a, b) => a - b);
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
    const counts = new Map();
    for (const s of scores) counts.set(s, (counts.get(s) || 0) + 1);
    const histogram = Array.from({ length: scoring.TOTAL_MARKS + 1 }, (_, score) => ({
        score,
        count: counts.get(score) || 0,
    }));

    const items = db.all(
        `SELECT q.question_number, q.section_label, q.question_text,
                SUM(CASE WHEN r.is_correct = 1 THEN 1 ELSE 0 END) AS correct_count,
                SUM(CASE WHEN r.is_correct IS NOT NULL THEN 1 ELSE 0 END) AS attempted_count
           FROM questions q
      LEFT JOIN responses r ON r.question_id = q.id
      LEFT JOIN assessment_attempts a ON a.id = r.attempt_id
                                     AND a.status IN ('COMPLETED', 'TIMED_OUT')
       GROUP BY q.id
       ORDER BY q.question_number`
    ).map((row) => {
        const attempted = Number(row.attempted_count) || 0;
        const correct = Number(row.correct_count) || 0;
        return {
            question_number: row.question_number,
            section_label: row.section_label,
            question_text: row.question_text,
            correct_count: correct,
            attempted_count: attempted,
            difficulty_percent: attempted ? Math.round((correct / attempted) * 100) : 0,
        };
    });

    return { summary, histogram, items };
}

router.get('/analytics', (req, res, next) => {
    try {
        const { summary, histogram, items } = buildAnalytics();
        return res.render('admin/analytics', {
            title: 'Cohort analytics',
            nav: 'admin',
            navTitle: 'Administration',
            summary,
            histogram,
            items,
        });
    } catch (err) {
        return next(err);
    }
});

/** RFC 4180 field escaping. */
function csvCell(value) {
    const s = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get('/analytics/export.csv', (req, res, next) => {
    try {
        const roster = rosterWithAttempts();
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
    } catch (err) {
        return next(err);
    }
});

module.exports = router;
