/**
 * Assessment attempts, option mappings and responses.
 *
 * One attempt per officer is enforced by the primary key on
 * assessment_attempts.participant_number, not by application logic.
 *
 * Timestamps are returned as ISO strings so src/utils/timer.js and the views
 * work unchanged — everything above this layer treats time as text.
 *
 * Mapping rows are returned in the engines' snake_case shape, so
 * src/engines/randomization.js and scoring.js need no changes.
 */

'use strict';

const db = require('./pool');

/** pg returns TIMESTAMPTZ as a Date; the rest of the app expects ISO text. */
function iso(value) {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : String(value);
}

function toAttempt(row) {
    if (!row) return null;
    return {
        id: row.participant_number,
        participant_id: row.participant_number,
        participant_number: row.participant_number,
        status: row.status,
        started_at: iso(row.started_at),
        submitted_at: iso(row.submitted_at),
        deadline_at: iso(row.deadline_at),
        score: row.score === null ? null : Number(row.score),
        total_marks: row.total_marks === null ? 20 : Number(row.total_marks),
        percentage: row.percentage === null ? null : Number(row.percentage),
        knowledge_level: row.knowledge_level,
        knowledge_interpretation: row.knowledge_interpretation,
    };
}

function toMapping(row) {
    if (!row) return null;
    return {
        question_id: row.question_number,
        permutation_key: row.permutation_key,
        display_position_a_option_id: row.display_a_option_id,
        display_position_b_option_id: row.display_b_option_id,
        display_position_c_option_id: row.display_c_option_id,
        display_position_d_option_id: row.display_d_option_id,
    };
}

function toResponse(row) {
    if (!row) return null;
    return {
        question_id: row.question_number,
        selected_option_id: row.selected_option_id,
        selected_display_position: row.selected_display_position,
        is_correct: row.is_correct === null ? null : Boolean(row.is_correct),
        saved_at: iso(row.saved_at),
    };
}

async function getByParticipant(participantNumber) {
    return toAttempt(await db.queryOne(
        'SELECT * FROM assessment_attempts WHERE participant_number = $1',
        [participantNumber]
    ));
}

/**
 * Create an attempt and its 20 option mappings atomically.
 *
 * An attempt without a complete mapping set would render a question with no
 * options and could not be scored, so both must land together or neither.
 */
async function create(participantNumber, { startedAt, deadlineAt, totalMarks, mappings }) {
    await db.transaction(async (client) => {
        await client.query(
            `INSERT INTO assessment_attempts
               (participant_number, status, started_at, deadline_at, total_marks)
             VALUES ($1, 'IN_PROGRESS', $2, $3, $4)`,
            [participantNumber, startedAt, deadlineAt, totalMarks]
        );

        for (const m of mappings) {
            await client.query(
                `INSERT INTO randomized_mappings
                   (participant_number, question_number, permutation_key,
                    display_a_option_id, display_b_option_id,
                    display_c_option_id, display_d_option_id)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [participantNumber, m.questionNumber, m.permutationKey, m.a, m.b, m.c, m.d]
            );
        }
    });
    return getByParticipant(participantNumber);
}

async function getMapping(participantNumber, questionNumber) {
    return toMapping(await db.queryOne(
        `SELECT * FROM randomized_mappings
          WHERE participant_number = $1 AND question_number = $2`,
        [participantNumber, questionNumber]
    ));
}

/** question number → mapping row. */
async function getMappings(participantNumber) {
    const rows = await db.query(
        'SELECT * FROM randomized_mappings WHERE participant_number = $1',
        [participantNumber]
    );
    const out = {};
    for (const row of rows) out[row.question_number] = toMapping(row);
    return out;
}

/** question number → response row. */
async function getResponses(participantNumber) {
    const rows = await db.query(
        'SELECT * FROM responses WHERE participant_number = $1',
        [participantNumber]
    );
    const out = {};
    for (const row of rows) out[row.question_number] = toResponse(row);
    return out;
}

/**
 * Record one answer.
 *
 * is_correct is left NULL — it is only written at submission, so a graded
 * result is never one query away from a participant-facing route.
 */
async function saveResponse(participantNumber, questionNumber, selectedOptionId, displayPosition, savedAt) {
    await db.query(
        `INSERT INTO responses
           (participant_number, question_number, selected_option_id,
            selected_display_position, is_correct, saved_at)
         VALUES ($1, $2, $3, $4, NULL, $5)
         ON CONFLICT (participant_number, question_number) DO UPDATE SET
           selected_option_id = EXCLUDED.selected_option_id,
           selected_display_position = EXCLUDED.selected_display_position,
           saved_at = EXCLUDED.saved_at`,
        [participantNumber, questionNumber, selectedOptionId, displayPosition, savedAt]
    );
}

/**
 * Write the graded result and close the attempt, atomically.
 *
 * @param {Array} result.graded [{ question_id, selected_option_id, selected_display_position, is_correct }]
 */
async function finalize(participantNumber, status, result, submittedAt) {
    await db.transaction(async (client) => {
        for (const row of result.graded) {
            await client.query(
                `INSERT INTO responses
                   (participant_number, question_number, selected_option_id,
                    selected_display_position, is_correct, saved_at)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (participant_number, question_number) DO UPDATE SET
                   selected_option_id = EXCLUDED.selected_option_id,
                   selected_display_position = EXCLUDED.selected_display_position,
                   is_correct = EXCLUDED.is_correct,
                   saved_at = EXCLUDED.saved_at`,
                [
                    participantNumber,
                    row.question_id,
                    row.selected_option_id,
                    row.selected_display_position,
                    row.is_correct === null ? null : Boolean(row.is_correct),
                    submittedAt,
                ]
            );
        }

        await client.query(
            `UPDATE assessment_attempts
                SET status = $1, submitted_at = $2, score = $3, total_marks = $4,
                    percentage = $5, knowledge_level = $6, knowledge_interpretation = $7
              WHERE participant_number = $8`,
            [
                status, submittedAt, result.score, result.totalMarks,
                result.percentage, result.knowledgeLevel, result.knowledgeInterpretation,
                participantNumber,
            ]
        );
    });
    return getByParticipant(participantNumber);
}

/** All attempts, keyed by participant number. */
async function listAll() {
    const rows = await db.query('SELECT * FROM assessment_attempts');
    const out = {};
    for (const row of rows) out[row.participant_number] = toAttempt(row);
    return out;
}

/**
 * Roster joined to attempt state, in one query.
 *
 * This is the join that a document store made us do in application code.
 */
async function rosterWithAttempts() {
    return db.query(
        `SELECT p.participant_number, p.full_name, p.title, p.agency,
                COALESCE(a.status, 'NOT_STARTED') AS status,
                a.score, a.total_marks, a.percentage, a.knowledge_level
           FROM participants p
      LEFT JOIN assessment_attempts a USING (participant_number)
          WHERE p.is_active
       ORDER BY p.participant_number`
    );
}

/** Score frequency across finished attempts, for the histogram. */
async function getScoreDistribution() {
    return db.query(
        `SELECT score, count(*)::int AS count
           FROM assessment_attempts
          WHERE status IN ('COMPLETED','TIMED_OUT') AND score IS NOT NULL
       GROUP BY score ORDER BY score`
    );
}

/**
 * Per-question correct and attempted counts.
 *
 * One aggregate rather than a read of every response of every attempt.
 */
async function getItemDifficulty() {
    return db.query(
        `SELECT q.question_number,
                q.section_label,
                q.question_text,
                COALESCE(SUM(CASE WHEN r.is_correct THEN 1 ELSE 0 END), 0)::int AS correct_count,
                COALESCE(SUM(CASE WHEN r.is_correct IS NOT NULL THEN 1 ELSE 0 END), 0)::int AS attempted_count
           FROM questions q
      LEFT JOIN responses r ON r.question_number = q.question_number
      LEFT JOIN assessment_attempts a
             ON a.participant_number = r.participant_number
            AND a.status IN ('COMPLETED','TIMED_OUT')
       GROUP BY q.question_number, q.section_label, q.question_text
       ORDER BY q.question_number`
    );
}

/** Item-level audit for one officer. Administrator realm only. */
async function getAuditRows(participantNumber) {
    return db.query(
        `SELECT q.question_number, q.section_label, q.question_text,
                r.selected_display_position,
                sel.option_text AS selected_option_text,
                cor.option_text AS correct_option_text,
                r.is_correct
           FROM questions q
      LEFT JOIN responses r ON r.question_number = q.question_number
                           AND r.participant_number = $1
      LEFT JOIN options sel ON sel.option_id = r.selected_option_id
      LEFT JOIN options cor ON cor.question_number = q.question_number AND cor.is_correct
       ORDER BY q.question_number`,
        [participantNumber]
    );
}

/** Delete every attempt. Cascades to mappings and responses. */
async function deleteAll() {
    const rows = await db.query(
        'WITH removed AS (DELETE FROM assessment_attempts RETURNING 1) SELECT count(*)::int AS n FROM removed'
    );
    return rows.length ? rows[0].n : 0;
}

module.exports = {
    getByParticipant,
    create,
    getMapping,
    getMappings,
    getResponses,
    saveResponse,
    finalize,
    listAll,
    rosterWithAttempts,
    getScoreDistribution,
    getItemDifficulty,
    getAuditRows,
    deleteAll,
};
