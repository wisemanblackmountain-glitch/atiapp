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

const participantsRepo = require('../data/participants');
const attemptsRepo = require('../data/attempts');
const scoring = require('../engines/scoring');
const asyncHandler = require('../utils/asyncHandler');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.use(requireAdmin);

const STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'TIMED_OUT'];

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

    const all = await attemptsRepo.rosterWithAttempts();
    const needle = q.toLowerCase();

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
