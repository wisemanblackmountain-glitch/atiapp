/**
 * Participant assessment flow. Mounted at '/assessment'.
 *
 * Locals supplied here must match VIEW_CONTRACT.md §3.
 *
 * ── Two rules govern this file ──────────────────────────────────────────────
 * 1. The answer key never leaves the server. `choices` carries position and
 *    text only, built from questions.getOptionsPublic() — the accessor that
 *    cannot see correctness. getOptionsWithKey() appears exactly once here, in
 *    finalizeAttempt, and its output never reaches a template.
 * 2. The server owns expiry. Every mutating route calls enforceDeadline()
 *    before writing, because public/js/timer.js is display only.
 */

'use strict';

const express = require('express');

const questionsRepo = require('../data/questions');
const attemptsRepo = require('../data/attempts');
const timer = require('../utils/timer');
const scoring = require('../engines/scoring');
const randomization = require('../engines/randomization');
const asyncHandler = require('../utils/asyncHandler');
const { verifyCsrf, validateAnswerPayload } = require('../middleware/validation');
const { requireParticipant, loadAttempt } = require('../middleware/auth');

const router = express.Router();

router.use(requireParticipant);

const TOTAL_QUESTIONS = questionsRepo.TOTAL_QUESTIONS;
// Absorbs the round trip of an answer clicked just before the deadline.
const SAVE_GRACE_SECONDS = 5;

/** Answered/total plus the per-question state the navigator renders. */
async function buildProgress(participantNumber) {
    const [questions, responses] = await Promise.all([
        questionsRepo.listAll(),
        attemptsRepo.getResponses(participantNumber),
    ]);

    const items = questions.map((q) => ({
        number: q.question_number,
        answered: Boolean(
            responses[q.question_number] && responses[q.question_number].selected_display_position
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
 * Writes a response for every question, including unanswered ones, so the
 * administrator audit shows all twenty. Idempotent: an already-finished
 * attempt is returned untouched, so a double-submitted form cannot rescore.
 */
async function finalizeAttempt(attempt, status) {
    if (attempt.status === 'COMPLETED' || attempt.status === 'TIMED_OUT') return attempt;

    const number = attempt.participant_number;
    const [questions, mappings, existing, options] = await Promise.all([
        questionsRepo.listAll(),
        attemptsRepo.getMappings(number),
        attemptsRepo.getResponses(number),
        // The only call to the key-bearing accessor in this file.
        questionsRepo.getOptionsWithKey(),
    ]);

    const responses = questions.map((q) => ({
        question_id: q.question_number,
        selected_display_position: existing[q.question_number]
            ? existing[q.question_number].selected_display_position
            : null,
    }));

    const result = scoring.scoreAttempt(responses, mappings, options);
    return attemptsRepo.finalize(number, status, result, timer.nowIso());
}

/**
 * Close an attempt whose deadline has passed.
 *
 * Returns true when the attempt was closed, meaning the caller should redirect
 * rather than continue serving the assessment.
 */
async function enforceDeadline(req, grace = 0) {
    if (!req.attempt) return false;
    if (req.attempt.status !== 'IN_PROGRESS') return false;
    if (!timer.hasExpired(req.attempt.deadline_at, grace)) return false;

    req.attempt = await finalizeAttempt(req.attempt, 'TIMED_OUT');
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

router.get('/confirm', loadAttempt(), asyncHandler(async (req, res) => {
    if (req.attempt && (req.attempt.status === 'COMPLETED' || req.attempt.status === 'TIMED_OUT')) {
        return res.redirect('/assessment/results');
    }
    return res.render('assessment/confirm', {
        title: 'Confirm your details',
        participant: req.participant,
    });
}));

// ── Briefing ─────────────────────────────────────────────────────────────

router.get('/instructions', loadAttempt(), asyncHandler(async (req, res) => {
    if (req.attempt && (req.attempt.status === 'COMPLETED' || req.attempt.status === 'TIMED_OUT')) {
        return res.redirect('/assessment/results');
    }
    return res.render('assessment/instructions', {
        title: 'Before you begin',
        participant: req.participant,
        resuming: Boolean(req.attempt),
    });
}));

/**
 * Start the attempt: stamp the deadline and assign the 20 permutations.
 *
 * Resuming must not reset deadline_at. Without that guard, revisiting the
 * briefing screen would hand out a fresh ten minutes each time.
 */
router.post('/start', verifyCsrf, loadAttempt(), asyncHandler(async (req, res) => {
    if (req.attempt) {
        if (req.attempt.status !== 'IN_PROGRESS') return res.redirect('/assessment/results');
        if (await enforceDeadline(req)) return res.redirect('/assessment/results');
        return res.redirect('/assessment/questions/1');
    }

    const questions = await questionsRepo.listAll();
    if (questions.length !== TOTAL_QUESTIONS) {
        throw new Error(
            `Question bank holds ${questions.length} questions, expected ${TOTAL_QUESTIONS}. Run: npm run seed`
        );
    }

    const startedAt = timer.nowIso();
    const mappings = questions.map((q) => {
        const key = randomization.randomPermutationKey();
        const mapping = randomization.buildMapping(q.options, key);
        return {
            questionNumber: q.question_number,
            permutationKey: key,
            a: mapping.a, b: mapping.b, c: mapping.c, d: mapping.d,
        };
    });

    await attemptsRepo.create(req.participant.participant_number, {
        startedAt,
        deadlineAt: timer.deadlineFrom(startedAt),
        totalMarks: scoring.TOTAL_MARKS,
        mappings,
    });

    return res.redirect('/assessment/questions/1');
}));

// ── Question canvas ──────────────────────────────────────────────────────

router.get('/questions/:number', loadAttempt({ requireInProgress: true }), asyncHandler(async (req, res) => {
    if (await enforceDeadline(req)) return res.redirect('/assessment/results');

    const number = Number(req.params.number);
    if (!Number.isInteger(number) || number < 1 || number > TOTAL_QUESTIONS) {
        return res.redirect('/assessment/questions/1');
    }

    const participantNumber = req.participant.participant_number;
    const [question, mapping, responses, optionsPublic, progress] = await Promise.all([
        questionsRepo.getByNumber(number),
        attemptsRepo.getMapping(participantNumber, number),
        attemptsRepo.getResponses(participantNumber),
        questionsRepo.getOptionsPublic(),
        buildProgress(participantNumber),
    ]);

    if (!question) return res.redirect('/assessment/questions/1');
    if (!mapping) throw new Error(`No option mapping for participant ${participantNumber}, question ${number}.`);

    const response = responses[number];

    return res.render('assessment/questions', timedNav(req.attempt, {
        title: `Question ${number}`,
        navTitle: 'Diagnostic Assessment',
        navCounter: `Q ${String(number).padStart(2, '0')} / ${TOTAL_QUESTIONS}`,
        scripts: ['/js/timer.js', '/js/assessment.js'],
        question,
        choices: randomization.buildChoices(mapping, optionsPublic),
        selectedPosition: response ? response.selected_display_position : null,
        progress,
        prevNumber: number > 1 ? number - 1 : null,
        nextNumber: number < TOTAL_QUESTIONS ? number + 1 : null,
    }));
}));

// ── Answer persistence ───────────────────────────────────────────────────

router.post('/save-answer', verifyCsrf, loadAttempt(), asyncHandler(async (req, res) => {
    if (!req.attempt) {
        return res.status(409).json({ error: 'No assessment in progress.' });
    }
    if (req.attempt.status !== 'IN_PROGRESS') {
        return res.status(409).json({ error: 'This assessment has already been submitted.' });
    }
    if (await enforceDeadline(req, SAVE_GRACE_SECONDS)) {
        return res.status(409).json({ error: 'Time has run out. Your assessment was submitted.' });
    }

    const payload = validateAnswerPayload(req.body);
    if (!payload) return res.status(400).json({ error: 'Invalid answer payload.' });

    const participantNumber = req.participant.participant_number;
    const mapping = await attemptsRepo.getMapping(participantNumber, payload.questionId);
    if (!mapping) return res.status(400).json({ error: 'Unknown question for this attempt.' });

    const selectedOptionId = randomization.resolveDisplayPosition(mapping, payload.selectedPosition);
    if (!selectedOptionId) return res.status(400).json({ error: 'Invalid option position.' });

    await attemptsRepo.saveResponse(
        participantNumber, payload.questionId, selectedOptionId,
        payload.selectedPosition, timer.nowIso()
    );

    const progress = await buildProgress(participantNumber);
    // Progress only. No correctness, ever.
    return res.json({
        saved: true,
        answered: progress.answered,
        total: progress.total,
        secondsRemaining: timer.secondsRemaining(req.attempt.deadline_at),
    });
}));

// ── Review ───────────────────────────────────────────────────────────────

router.get('/review', loadAttempt({ requireInProgress: true }), asyncHandler(async (req, res) => {
    if (await enforceDeadline(req)) return res.redirect('/assessment/results');

    const participantNumber = req.participant.participant_number;
    const [questions, responses] = await Promise.all([
        questionsRepo.listAll(),
        attemptsRepo.getResponses(participantNumber),
    ]);

    const items = questions.map((q) => ({
        number: q.question_number,
        section_label: q.section_label,
        answered: Boolean(
            responses[q.question_number] && responses[q.question_number].selected_display_position
        ),
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
}));

// ── Submission ───────────────────────────────────────────────────────────

router.post('/submit', verifyCsrf, loadAttempt(), asyncHandler(async (req, res) => {
    if (!req.attempt) return res.redirect('/assessment/confirm');
    if (req.attempt.status !== 'IN_PROGRESS') return res.redirect('/assessment/results');

    // An expired attempt is recorded as TIMED_OUT even if the submit button was
    // what finally arrived — the status should reflect what happened.
    const status = timer.hasExpired(req.attempt.deadline_at, SAVE_GRACE_SECONDS)
        ? 'TIMED_OUT'
        : 'COMPLETED';

    await finalizeAttempt(req.attempt, status);
    return res.redirect('/assessment/results');
}));

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
