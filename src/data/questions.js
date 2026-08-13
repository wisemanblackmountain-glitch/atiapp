/**
 * Question bank and answer key.
 *
 * ── Two accessors, deliberately ─────────────────────────────────────────────
 *   getOptionsPublic()  → id → { option_text }              rendering
 *   getOptionsWithKey() → id → { option_text, is_correct }  scoring only
 *
 * Correctness lives in one column, but the split accessors mean a
 * participant-facing route has to reach for the key-bearing function by name to
 * leak it — it cannot happen by passing along whatever the repository returned.
 * getOptionsWithKey is called in exactly two places: scoring, and the
 * administrator audit view.
 *
 * Shapes use the engines' snake_case field names so src/engines/* need no
 * changes.
 */

'use strict';

const db = require('./pool');

const TOTAL_QUESTIONS = 20;

function toQuestion(row, options) {
    return {
        id: row.question_number,
        question_number: row.question_number,
        section_label: row.section_label,
        question_text: row.question_text,
        marks: row.marks,
        options: options || [],
    };
}

async function listAll() {
    const [questions, options] = await Promise.all([
        db.query(
            `SELECT question_number, section_label, question_text, marks
               FROM questions ORDER BY question_number`
        ),
        db.query(
            `SELECT option_id, question_number, original_position, option_text
               FROM options ORDER BY question_number, original_position`
        ),
    ]);

    const byQuestion = new Map();
    for (const o of options) {
        if (!byQuestion.has(o.question_number)) byQuestion.set(o.question_number, []);
        byQuestion.get(o.question_number).push({
            id: o.option_id,
            original_position: o.original_position,
            option_text: o.option_text,
        });
    }

    return questions.map((q) => toQuestion(q, byQuestion.get(q.question_number) || []));
}

async function getByNumber(questionNumber) {
    const row = await db.queryOne(
        `SELECT question_number, section_label, question_text, marks
           FROM questions WHERE question_number = $1`,
        [questionNumber]
    );
    if (!row) return null;

    const options = await db.query(
        `SELECT option_id, original_position, option_text
           FROM options WHERE question_number = $1 ORDER BY original_position`,
        [questionNumber]
    );

    return toQuestion(row, options.map((o) => ({
        id: o.option_id,
        original_position: o.original_position,
        option_text: o.option_text,
    })));
}

async function count() {
    const row = await db.queryOne('SELECT count(*)::int AS n FROM questions');
    return row ? row.n : 0;
}

/** Option text only. Safe for anything rendered to a participant. */
async function getOptionsPublic() {
    const rows = await db.query(
        `SELECT option_id, question_number, original_position, option_text FROM options`
    );
    const byId = {};
    for (const o of rows) {
        byId[o.option_id] = {
            id: o.option_id,
            question_id: o.question_number,
            original_position: o.original_position,
            option_text: o.option_text,
        };
    }
    return byId;
}

/**
 * Option text plus correctness.
 *
 * Scoring and the administrator audit only. Never pass this into a template
 * rendered for a participant.
 */
async function getOptionsWithKey() {
    const rows = await db.query(
        `SELECT option_id, question_number, original_position, option_text, is_correct FROM options`
    );
    const byId = {};
    for (const o of rows) {
        byId[o.option_id] = {
            id: o.option_id,
            question_id: o.question_number,
            original_position: o.original_position,
            option_text: o.option_text,
            is_correct: o.is_correct ? 1 : 0,
        };
    }
    return byId;
}

/** question number → correct option id. Server-side callers only. */
async function getAnswerKey() {
    const rows = await db.query(
        'SELECT question_number, option_id FROM options WHERE is_correct'
    );
    const key = {};
    for (const row of rows) key[row.question_number] = row.option_id;
    return key;
}

/**
 * Replace the question bank. Seeding only.
 *
 * The partial unique index on options enforces exactly one correct answer per
 * question, so a malformed content file fails here rather than producing an
 * unscoreable assessment.
 *
 * @param {Array} questions [{ number, section, text, options:[{position,text,correct}] }]
 */
async function replaceAll(questions) {
    return db.transaction(async (client) => {
        await client.query('DELETE FROM options');
        await client.query('DELETE FROM questions');

        for (const q of questions) {
            await client.query(
                `INSERT INTO questions (question_number, section_label, question_text, marks)
                 VALUES ($1, $2, $3, 1)`,
                [q.number, q.section, q.text]
            );

            for (const o of q.options) {
                const position = String(o.position).toUpperCase();
                await client.query(
                    `INSERT INTO options
                       (option_id, question_number, original_position, option_text, is_correct)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [
                        // Contract-locked id shape, keyed on the SOURCE letter.
                        // Display order is decided per attempt at runtime.
                        `opt_q${q.number}_${position.toLowerCase()}`,
                        q.number,
                        position,
                        o.text,
                        Boolean(o.correct),
                    ]
                );
            }
        }
        return questions.length;
    });
}

module.exports = {
    TOTAL_QUESTIONS,
    listAll,
    getByNumber,
    count,
    getOptionsPublic,
    getOptionsWithKey,
    getAnswerKey,
    replaceAll,
};
