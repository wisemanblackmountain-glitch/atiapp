/**
 * Scoring engine.
 *
 * The band boundaries are the officially published ATI thresholds, so they are
 * tested at every edge rather than in the middle: an off-by-one at 16/17 moves
 * an officer between COMPETENT and ADVANCED on a record that goes to a ministry.
 */

'use strict';

const s = require('../src/engines/scoring');

const OPTIONS = {
    opt_q1_a: { id: 'opt_q1_a', option_text: 'Alpha', is_correct: 0 },
    opt_q1_b: { id: 'opt_q1_b', option_text: 'Bravo', is_correct: 1 },
    opt_q1_c: { id: 'opt_q1_c', option_text: 'Charlie', is_correct: 0 },
    opt_q1_d: { id: 'opt_q1_d', option_text: 'Delta', is_correct: 0 },
};

/** Mapping where display A shows the correct option. */
const CORRECT_AT_A = {
    display_position_a_option_id: 'opt_q1_b',
    display_position_b_option_id: 'opt_q1_a',
    display_position_c_option_id: 'opt_q1_c',
    display_position_d_option_id: 'opt_q1_d',
};

/** Mapping where display D shows the correct option. */
const CORRECT_AT_D = {
    display_position_a_option_id: 'opt_q1_a',
    display_position_b_option_id: 'opt_q1_c',
    display_position_c_option_id: 'opt_q1_d',
    display_position_d_option_id: 'opt_q1_b',
};

describe('knowledgeLevelFor — official band boundaries', () => {
    const cases = [
        [20, 'ADVANCED'], [18, 'ADVANCED'], [17, 'ADVANCED'],
        [16, 'COMPETENT'], [14, 'COMPETENT'], [13, 'COMPETENT'],
        [12, 'DEVELOPING'], [10, 'DEVELOPING'], [9, 'DEVELOPING'],
        [8, 'FOUNDATIONAL'], [4, 'FOUNDATIONAL'], [0, 'FOUNDATIONAL'],
    ];

    test.each(cases)('a score of %i is %s', (score, level) => {
        expect(s.knowledgeLevelFor(score).level).toBe(level);
    });

    test('every band carries a non-empty interpretation', () => {
        for (let score = 0; score <= 20; score++) {
            expect(s.knowledgeLevelFor(score).interpretation.length).toBeGreaterThan(20);
        }
    });

    test('bands cover 0..20 with no gap', () => {
        for (let score = 0; score <= 20; score++) {
            expect(s.knowledgeLevelFor(score).level).toBeTruthy();
        }
    });

    test('rejects invalid scores rather than guessing a band', () => {
        expect(() => s.knowledgeLevelFor(-1)).toThrow();
        expect(() => s.knowledgeLevelFor(1.5)).toThrow();
        expect(() => s.knowledgeLevelFor('12')).toThrow();
        expect(() => s.knowledgeLevelFor(null)).toThrow();
    });
});

describe('percentageFor', () => {
    test.each([[20, 100], [16, 80], [13, 65], [10, 50], [0, 0]])(
        '%i of 20 is %i%%', (score, pct) => {
            expect(s.percentageFor(score)).toBe(pct);
        }
    );

    test('rounds to the nearest whole number', () => {
        expect(s.percentageFor(1)).toBe(5);
        expect(s.percentageFor(3)).toBe(15);
        expect(s.percentageFor(7)).toBe(35);
    });

    test('does not divide by zero', () => {
        expect(s.percentageFor(5, 0)).toBe(0);
    });
});

describe('gradeResponse', () => {
    test('marks the display position that shows the correct option', () => {
        expect(s.gradeResponse(CORRECT_AT_A, 'A', OPTIONS).isCorrect).toBe(true);
        expect(s.gradeResponse(CORRECT_AT_D, 'D', OPTIONS).isCorrect).toBe(true);
    });

    test('marks other display positions wrong', () => {
        expect(s.gradeResponse(CORRECT_AT_A, 'B', OPTIONS).isCorrect).toBe(false);
        expect(s.gradeResponse(CORRECT_AT_D, 'A', OPTIONS).isCorrect).toBe(false);
    });

    test('resolves the display position to the underlying option id', () => {
        expect(s.gradeResponse(CORRECT_AT_D, 'D', OPTIONS).selectedOptionId).toBe('opt_q1_b');
    });

    test('unanswered is null, distinct from answered-and-wrong', () => {
        const unanswered = s.gradeResponse(CORRECT_AT_A, null, OPTIONS);
        expect(unanswered.isCorrect).toBeNull();
        expect(unanswered.selectedOptionId).toBeNull();

        // false and null must not be conflated: one scores zero, the other
        // means the officer never reached the question.
        expect(s.gradeResponse(CORRECT_AT_A, 'B', OPTIONS).isCorrect).toBe(false);
    });

    test('returns null for an unresolvable position or unknown option', () => {
        expect(s.gradeResponse(CORRECT_AT_A, 'Z', OPTIONS).isCorrect).toBeNull();
        expect(s.gradeResponse(CORRECT_AT_A, 'A', {}).isCorrect).toBeNull();
    });
});

describe('position independence', () => {
    /** 20 questions, all with the correct option at display `position`. */
    function fixture(position) {
        const mappings = {};
        const options = {};
        for (let q = 1; q <= 20; q++) {
            const ids = ['a', 'b', 'c', 'd'].map((l) => `opt_q${q}_${l}`);
            ids.forEach((id, i) => { options[id] = { id, option_text: `o${i}`, is_correct: 0 }; });
            const correctId = `opt_q${q}_b`;
            options[correctId].is_correct = 1;

            const slots = ['a', 'b', 'c', 'd'];
            const row = {};
            const others = ids.filter((id) => id !== correctId);
            slots.forEach((slot) => {
                row[`display_position_${slot}_option_id`] =
                    slot === position.toLowerCase() ? correctId : others.pop();
            });
            mappings[q] = row;
        }
        return { mappings, options };
    }

    test('answering the correct option every time scores 20 regardless of layout', () => {
        for (const position of ['A', 'B', 'C', 'D']) {
            const { mappings, options } = fixture(position);
            const responses = Array.from({ length: 20 }, (_, i) => ({
                question_id: i + 1,
                selected_display_position: position,
            }));
            expect(s.scoreAttempt(responses, mappings, options).score).toBe(20);
        }
    });

    test('a fixed display letter scores only where that slot happens to be correct', () => {
        const { mappings, options } = fixture('C');
        const responses = Array.from({ length: 20 }, (_, i) => ({
            question_id: i + 1,
            selected_display_position: 'A',
        }));
        // Correct sits at C on every question, so pressing A never scores.
        expect(s.scoreAttempt(responses, mappings, options).score).toBe(0);
    });

    test('the same answers score differently under different layouts', () => {
        const responses = Array.from({ length: 20 }, (_, i) => ({
            question_id: i + 1,
            selected_display_position: 'A',
        }));
        const atA = fixture('A');
        const atD = fixture('D');
        expect(s.scoreAttempt(responses, atA.mappings, atA.options).score).toBe(20);
        expect(s.scoreAttempt(responses, atD.mappings, atD.options).score).toBe(0);
    });
});

describe('scoreAttempt', () => {
    function twentyQuestions(answeredCount) {
        const mappings = {};
        const options = {};
        const responses = [];
        for (let q = 1; q <= 20; q++) {
            const correctId = `opt_q${q}_b`;
            options[correctId] = { id: correctId, option_text: 'right', is_correct: 1 };
            options[`opt_q${q}_a`] = { id: `opt_q${q}_a`, option_text: 'wrong', is_correct: 0 };
            mappings[q] = {
                display_position_a_option_id: correctId,
                display_position_b_option_id: `opt_q${q}_a`,
                display_position_c_option_id: `opt_q${q}_a`,
                display_position_d_option_id: `opt_q${q}_a`,
            };
            responses.push({
                question_id: q,
                selected_display_position: q <= answeredCount ? 'A' : null,
            });
        }
        return { mappings, options, responses };
    }

    test('unanswered questions score zero, never negative', () => {
        const { mappings, options, responses } = twentyQuestions(12);
        const result = s.scoreAttempt(responses, mappings, options);
        expect(result.score).toBe(12);
        expect(result.percentage).toBe(60);
        expect(result.knowledgeLevel).toBe('DEVELOPING');
    });

    test('a wholly unanswered attempt scores zero and is FOUNDATIONAL', () => {
        const { mappings, options, responses } = twentyQuestions(0);
        const result = s.scoreAttempt(responses, mappings, options);
        expect(result.score).toBe(0);
        expect(result.knowledgeLevel).toBe('FOUNDATIONAL');
    });

    test('returns a graded row for every question, answered or not', () => {
        const { mappings, options, responses } = twentyQuestions(5);
        const result = s.scoreAttempt(responses, mappings, options);
        expect(result.graded).toHaveLength(20);
        expect(result.graded.filter((g) => g.is_correct === null)).toHaveLength(15);
        expect(result.graded.filter((g) => g.is_correct === 1)).toHaveLength(5);
    });

    test('graded rows carry the resolved option id, not the display letter', () => {
        const { mappings, options, responses } = twentyQuestions(1);
        const row = s.scoreAttempt(responses, mappings, options).graded[0];
        expect(row.selected_display_position).toBe('A');
        expect(row.selected_option_id).toBe('opt_q1_b');
    });

    test('reports total marks and a matching percentage', () => {
        const { mappings, options, responses } = twentyQuestions(20);
        const result = s.scoreAttempt(responses, mappings, options);
        expect(result.totalMarks).toBe(20);
        expect(result.percentage).toBe(100);
        expect(result.knowledgeLevel).toBe('ADVANCED');
    });
});
