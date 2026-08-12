/**
 * Scoring engine.
 *
 * Position-independent: a response is stored as a display position, resolved
 * to an option id through the attempt's own randomized_mappings row, and only
 * then compared against options.is_correct.
 *
 * Correctness is never sent to the participant. is_correct is written at
 * submission for the administrator audit view and nothing else.
 *
 * DEVELOPER_HANDOFF §5 and §14.3.
 */

'use strict';

const { resolveDisplayPosition } = require('./randomization');

const TOTAL_MARKS = 20;

/**
 * Official ATI knowledge bands.
 *
 * Ordered high to low and evaluated by lower bound, so the first match wins.
 * Bands are contiguous across 0–20 with no gap: 17+, 13–16, 9–12, 0–8.
 */
const KNOWLEDGE_LEVELS = [
    {
        level: 'ADVANCED',
        min: 17,
        interpretation:
            'Demonstrates strong executive understanding of maritime security frameworks and inter-agency operational protocols.',
    },
    {
        level: 'COMPETENT',
        min: 13,
        interpretation:
            'Possesses solid baseline knowledge with minor gaps in operational implementation procedures.',
    },
    {
        level: 'DEVELOPING',
        min: 9,
        interpretation:
            'Possesses basic domain familiarity requiring structured reinforcement during training modules.',
    },
    {
        level: 'FOUNDATIONAL',
        min: 0,
        interpretation:
            'Requires comprehensive introductory instruction across fundamental task force concepts.',
    },
];

/** Map a raw score to its knowledge band. */
function knowledgeLevelFor(score) {
    if (!Number.isInteger(score) || score < 0) {
        throw new Error(`Score must be a non-negative integer, received ${score}.`);
    }
    const band = KNOWLEDGE_LEVELS.find((b) => score >= b.min);
    return { level: band.level, interpretation: band.interpretation };
}

/** Percentage of total marks, rounded to the nearest whole number. */
function percentageFor(score, totalMarks = TOTAL_MARKS) {
    if (!totalMarks) return 0;
    return Math.round((score / totalMarks) * 100);
}

/**
 * Grade one response.
 *
 * @param {object} mappingRow the attempt's randomized_mappings row for this question
 * @param {string|null} displayPosition what the participant selected
 * @param {object} optionsById id → option row, including is_correct
 * @returns {{selectedOptionId:string|null, isCorrect:boolean|null}}
 *          isCorrect is null when unanswered — distinct from false, which
 *          means answered and wrong.
 */
function gradeResponse(mappingRow, displayPosition, optionsById) {
    if (!displayPosition) return { selectedOptionId: null, isCorrect: null };

    const selectedOptionId = resolveDisplayPosition(mappingRow, displayPosition);
    if (!selectedOptionId) return { selectedOptionId: null, isCorrect: null };

    const option = optionsById[selectedOptionId];
    if (!option) return { selectedOptionId, isCorrect: null };

    return { selectedOptionId, isCorrect: Boolean(option.is_correct) };
}

/**
 * Score a whole attempt.
 *
 * Unanswered questions score zero and never negative — there is no penalty for
 * a wrong answer, which is why the instructions tell participants to answer
 * everything.
 *
 * @param {Array} responses rows of { question_id, selected_display_position }
 * @param {object} mappingsByQuestionId question_id → randomized_mappings row
 * @param {object} optionsById option id → option row
 */
function scoreAttempt(responses, mappingsByQuestionId, optionsById, totalMarks = TOTAL_MARKS) {
    const graded = [];
    let score = 0;

    for (const response of responses) {
        const mapping = mappingsByQuestionId[response.question_id];
        const { selectedOptionId, isCorrect } = gradeResponse(
            mapping,
            response.selected_display_position,
            optionsById
        );
        if (isCorrect === true) score += 1;
        graded.push({
            question_id: response.question_id,
            selected_option_id: selectedOptionId,
            selected_display_position: response.selected_display_position || null,
            is_correct: isCorrect === null ? null : (isCorrect ? 1 : 0),
        });
    }

    const { level, interpretation } = knowledgeLevelFor(score);
    return {
        score,
        totalMarks,
        percentage: percentageFor(score, totalMarks),
        knowledgeLevel: level,
        knowledgeInterpretation: interpretation,
        graded,
    };
}

module.exports = {
    TOTAL_MARKS,
    KNOWLEDGE_LEVELS,
    knowledgeLevelFor,
    percentageFor,
    gradeResponse,
    scoreAttempt,
};
