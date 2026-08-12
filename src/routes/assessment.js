/**
 * Participant assessment flow.
 *
 * Mounted at '/assessment'. Locals supplied here must match VIEW_CONTRACT.md §3.
 *
 * ── Two rules govern this file ──────────────────────────────────────────────
 * 1. The answer key never leaves the server. `choices` carries position and
 *    text only. is_correct is written at submission for the administrator
 *    audit view and is never read into a participant response.
 * 2. The server owns expiry. Every route that could mutate an attempt calls
 *    enforceDeadline() first, because public/js/timer.js is display only.
 */

'use strict';

const express = require('express');

const db = require('../utils/db');
const timer = require('../utils/timer');
const scoring = require('../engines/scoring');
const randomization = require('../engines/randomization');
const { verifyCsrf, validateAnswerPayload } = require('../middleware/validation');
const { requireParticipant, loadAttempt } = require('../middleware/auth');

const router = express.Router();

router.use(requireParticipant);

const TOTAL_QUESTIONS = 20;
// Absorbs the round trip of an answer clicked just before the deadline.
const SAVE_GRACE_SECONDS = 5;

// ── Data helpers ─────────────────────────────────────────────────────────

function optionsById() {
    const rows = db.all('SELECT id, question_id, original_position, option_text, is_correct FROM options');
    return rows.reduce((acc, row) => { acc[row.id] = row; return acc; }, {});
}

function mappingsByQuestion(attemptId) {
    const rows = db.all('SELECT * FROM randomized_mappings WHERE attempt_id = ?', [attemptId]);
    return rows.reduce((acc, row) => { acc[row.question_id] = row; return acc; }, {});
}

function responsesByQuestion(attemptId) {
    const rows = db.all('SELECT * FROM responses WHERE attempt_id = ?', [attemptId]);
    return rows.reduce((acc, row) => { acc[row.question_id] = row; return acc; }, {});
}

/** Answered/total plus the per-question state the navigator renders. */
function buildProgress(attemptId) {
    const questions = db.all(
        'SELECT id, question_number FROM questions ORDER BY question_number'
    );
    const responses = responsesByQuestion(attemptId);

    const items = questions.map((q) => ({
        number: q.question_number,
        answered: Boolean(
            responses[q.id] && responses[q.id].selected_display_position
        ),
    }));

    return {
        answered: items.filter((i) => i.answered).length,
        total: items.length,
        items,
    };
}

/**
 * Score and close an attempt.
 *
 * Writes a response row for every question, including unanswered ones, so the
 * administrator audit shows all twenty rather than only those attempted.
 * Idempotent: a already-finished attempt is returned untouched, so a
 * double-submitted form cannot rescore.
 */
function finalizeAttempt(attempt, status) {
    if (attempt.status === 'COMPLETED' || attempt.status === 'TIMED_OUT') return attempt;

    const questions = db.all('SELECT id FROM questions ORDER BY question_number');
    const mappings = mappingsByQuestion(attempt.id);
    const existing = responsesByQuestion(attempt.id);
    const options = optionsById();

    const responses = questions.map((q) => ({
        question_id: q.id,
        selected_display_position: existing[q.id]
            ? existing[q.id].selected_display_position
            : null,
    }));

    const result = scoring.scoreAttempt(responses, mappings, options);
    const submittedAt = timer.nowIso();

    db.transaction(() => {
        for (const row of result.graded) {
            db.run(
                `INSERT INTO responses
                   (attempt_id, question_id, selected_option_id, selected_display_position, is_correct, saved_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(attempt_id, question_id) DO UPDATE SET
                   selected_option_id = excluded.selected_option_id,
                   selected_display_position = excluded.selected_display_position,
                   is_correct = excluded.is_correct`,
                [
                    attempt.id,
                    row.question_id,
                    row.selected_option_id,
                    row.selected_display_position,
                    row.is_correct,
                    submittedAt,
                ]
            );
        }

        db.run(
            `UPDATE assessment_attempts
                SET status = ?, submitted_at = ?, score = ?, total_marks = ?,
                    percentage = ?, knowledge_level = ?, knowledge_interpretation = ?
              WHERE id = ?`,
            [
                status,
                submittedAt,
                result.score,
                result.totalMarks,
                result.percentage,
                result.knowledgeLevel,
                result.knowledgeInterpretation,
                attempt.id,
            ]
        );
    });

    return db.get('SELECT * FROM assessment_attempts WHERE id = ?', [attempt.id]);
}

/**
 * Close an attempt whose deadline has passed.
 *
 * Returns true when the attempt was closed, meaning the caller should stop and
 * redirect rather than continue serving the assessment.
 */
function enforceDeadline(req, grace = 0) {
    if (!req.attempt) return false;
    if (req.attempt.status !== 'IN_PROGRESS') return false;
    if (!timer.hasExpired(req.attempt.deadline_at, grace)) return false;

    req.attempt = finalizeAttempt(req.attempt, 'TIMED_OUT');
    return true;
}

/** Nav locals shared by the timed screens. */
function timedNav(attempt, extra = {}) {
    return Object.assign({
        nav: 'assessment',
        navDeadline: attempt.deadline_at,
        navNow: timer.nowIso(),          // lets the client correct for clock skew
    }, extra);
}

// ── Identity confirmation ────────────────────────────────────────────────

router.get('/confirm', loadAttempt(), (req, res) => {
    if (req.attempt && (req.attempt.status === 'COMPLETED' || req.attempt.status === 'TIMED_OUT')) {
        return res.redirect('/assessment/results');
    }
    return res.render('assessment/confirm', {
        title: 'Confirm your details',
        participant: req.participant,
    });
});

// ── Briefing ─────────────────────────────────────────────────────────────

router.get('/instructions', loadAttempt(), (req, res) => {
    if (req.attempt && (req.attempt.status === 'COMPLETED' || req.attempt.status === 'TIMED_OUT')) {
        return res.redirect('/assessment/results');
    }
    return res.render('assessment/instructions', {
        title: 'Before you begin',
        participant: req.participant,
        resuming: Boolean(req.attempt),
    });
});

/**
 * Start the attempt: stamp the deadline and assign the 20 permutations.
 *
 * Resuming must not reset deadline_at. Without that guard, revisiting the
 * briefing screen would hand out a fresh ten minutes each time.
 */
router.post('/start', verifyCsrf, loadAttempt(), (req, res, next) => {
    try {
        if (req.attempt) {
            if (req.attempt.status !== 'IN_PROGRESS') return res.redirect('/assessment/results');
            if (enforceDeadline(req)) return res.redirect('/assessment/results');
            return res.redirect('/assessment/questions/1');
        }

        const startedAt = timer.nowIso();
        const deadlineAt = timer.deadlineFrom(startedAt);
        const questions = db.all('SELECT id FROM questions ORDER BY question_number');

        if (questions.length !== TOTAL_QUESTIONS) {
            throw new Error(
                `Question bank holds ${questions.length} questions, expected ${TOTAL_QUESTIONS}. Run: npm run seed`
            );
        }

        db.transaction(() => {
            db.run(
                `INSERT INTO assessment_attempts
                   (participant_id, status, started_at, deadline_at, total_marks)
                 VALUES (?, 'IN_PROGRESS', ?, ?, ?)`,
                [req.participant.id, startedAt, deadlineAt, scoring.TOTAL_MARKS]
            );
            const attemptId = db.lastInsertId();

            for (const question of questions) {
                const options = db.all(
                    'SELECT id, original_position FROM options WHERE question_id = ?',
                    [question.id]
                );
                const key = randomization.randomPermutationKey();
                const mapping = randomization.buildMapping(options, key);

                db.run(
                    `INSERT INTO randomized_mappings
                       (attempt_id, question_id, permutation_key,
                        display_position_a_option_id, display_position_b_option_id,
                        display_position_c_option_id, display_position_d_option_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [attemptId, question.id, key, mapping.a, mapping.b, mapping.c, mapping.d]
                );
            }
        });

        return res.redirect('/assessment/questions/1');
    } catch (err) {
        return next(err);
    }
});

// ── Question canvas ──────────────────────────────────────────────────────

router.get('/questions/:number', loadAttempt({ requireInProgress: true }), (req, res, next) => {
    try {
        if (enforceDeadline(req)) return res.redirect('/assessment/results');

        const number = Number(req.params.number);
        if (!Number.isInteger(number) || number < 1 || number > TOTAL_QUESTIONS) {
            return res.redirect('/assessment/questions/1');
        }

        const question = db.get(
            'SELECT id, question_number, section_label, question_text FROM questions WHERE question_number = ?',
            [number]
        );
        if (!question) return res.redirect('/assessment/questions/1');

        const mapping = db.get(
            'SELECT * FROM randomized_mappings WHERE attempt_id = ? AND question_id = ?',
            [req.attempt.id, question.id]
        );
        if (!mapping) throw new Error(`No option mapping for attempt ${req.attempt.id}, question ${question.id}.`);

        const response = db.get(
            'SELECT selected_display_position FROM responses WHERE attempt_id = ? AND question_id = ?',
            [req.attempt.id, question.id]
        );

        return res.render('assessment/questions', timedNav(req.attempt, {
            title: `Question ${number}`,
            navTitle: 'Diagnostic Assessment',
            navCounter: `Q ${String(number).padStart(2, '0')} / ${TOTAL_QUESTIONS}`,
            scripts: ['/js/timer.js', '/js/assessment.js'],
            question,
            choices: randomization.buildChoices(mapping, optionsById()),
            selectedPosition: response ? response.selected_display_position : null,
            progress: buildProgress(req.attempt.id),
            prevNumber: number > 1 ? number - 1 : null,
            nextNumber: number < TOTAL_QUESTIONS ? number + 1 : null,
        }));
    } catch (err) {
        return next(err);
    }
});

// ── Answer persistence ───────────────────────────────────────────────────

/**
 * Save one answer.
 *
 * Stores the display position and the resolved option id. is_correct stays
 * NULL until submission — writing it here would put the graded result one
 * query away from a participant-facing route.
 */
router.post('/save-answer', verifyCsrf, loadAttempt(), (req, res, next) => {
    try {
        if (!req.attempt) {
            return res.status(409).json({ error: 'No assessment in progress.' });
        }
        if (req.attempt.status !== 'IN_PROGRESS') {
            return res.status(409).json({ error: 'This assessment has already been submitted.' });
        }
        if (enforceDeadline(req, SAVE_GRACE_SECONDS)) {
            return res.status(409).json({ error: 'Time has run out. Your assessment was submitted.' });
        }

        const payload = validateAnswerPayload(req.body);
        if (!payload) return res.status(400).json({ error: 'Invalid answer payload.' });

        const mapping = db.get(
            'SELECT * FROM randomized_mappings WHERE attempt_id = ? AND question_id = ?',
            [req.attempt.id, payload.questionId]
        );
        if (!mapping) return res.status(400).json({ error: 'Unknown question for this attempt.' });

        const selectedOptionId = randomization.resolveDisplayPosition(mapping, payload.selectedPosition);
        if (!selectedOptionId) return res.status(400).json({ error: 'Invalid option position.' });

        db.run(
            `INSERT INTO responses
               (attempt_id, question_id, selected_option_id, selected_display_position, is_correct, saved_at)
             VALUES (?, ?, ?, ?, NULL, ?)
             ON CONFLICT(attempt_id, question_id) DO UPDATE SET
               selected_option_id = excluded.selected_option_id,
               selected_display_position = excluded.selected_display_position,
               saved_at = excluded.saved_at`,
            [req.attempt.id, payload.questionId, selectedOptionId, payload.selectedPosition, timer.nowIso()]
        );

        const progress = buildProgress(req.attempt.id);
        // Response carries progress only. No correctness, ever.
        return res.json({
            saved: true,
            answered: progress.answered,
            total: progress.total,
            secondsRemaining: timer.secondsRemaining(req.attempt.deadline_at),
        });
    } catch (err) {
        return next(err);
    }
});

// ── Review ───────────────────────────────────────────────────────────────

router.get('/review', loadAttempt({ requireInProgress: true }), (req, res, next) => {
    try {
        if (enforceDeadline(req)) return res.redirect('/assessment/results');

        const questions = db.all(
            'SELECT id, question_number, section_label FROM questions ORDER BY question_number'
        );
        const responses = responsesByQuestion(req.attempt.id);

        const items = questions.map((q) => ({
            number: q.question_number,
            section_label: q.section_label,
            answered: Boolean(responses[q.id] && responses[q.id].selected_display_position),
        }));
        const answered = items.filter((i) => i.answered).length;

        return res.render('assessment/review', timedNav(req.attempt, {
            title: 'Review your answers',
            navTitle: 'Review answers',
            scripts: ['/js/timer.js'],
            stats: { total: items.length, answered, unanswered: items.length - answered },
            items,
            deadline: req.attempt.deadline_at,
        }));
    } catch (err) {
        return next(err);
    }
});

// ── Submission ───────────────────────────────────────────────────────────

router.post('/submit', verifyCsrf, loadAttempt(), (req, res, next) => {
    try {
        if (!req.attempt) return res.redirect('/assessment/confirm');
        if (req.attempt.status !== 'IN_PROGRESS') return res.redirect('/assessment/results');

        // An expired attempt is recorded as TIMED_OUT even if the submit button
        // was what finally arrived — the status should reflect what happened.
        const status = timer.hasExpired(req.attempt.deadline_at, SAVE_GRACE_SECONDS)
            ? 'TIMED_OUT'
            : 'COMPLETED';

        finalizeAttempt(req.attempt, status);
        return res.redirect('/assessment/results');
    } catch (err) {
        return next(err);
    }
});

// ── Result ───────────────────────────────────────────────────────────────

router.get('/results', loadAttempt({ requireSubmitted: true }), (req, res) => {
    // Score, percentage and knowledge level only. Item-level correctness lives
    // in the administrator view. UI_HANDOFF §3.4.
    res.render('assessment/results', {
        title: 'Your diagnostic record',
        participant: req.participant,
        attempt: req.attempt,
    });
});

module.exports = router;
