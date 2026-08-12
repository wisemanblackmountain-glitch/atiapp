/**
 * Option randomisation engine.
 *
 * Every attempt receives an independent shuffle of the four options on each of
 * the 20 questions, so two officers sitting side by side see different letters
 * against the same answer.
 *
 * ── The invariant ───────────────────────────────────────────────────────────
 * The letter shown on screen is a DISPLAY POSITION. It is not the option's
 * source letter. Display "B" for participant 4 may be source option C.
 *
 * The mapping is written to randomized_mappings when the attempt starts and is
 * never recomputed. Scoring resolves display position back to an option id
 * through that stored row. Re-deriving the shuffle at scoring time — from a
 * seed, a hash, anything — would silently misgrade every attempt whose stored
 * mapping disagreed with the recomputation.
 *
 * DEVELOPER_HANDOFF §5. Do not alter this resolution logic.
 */

'use strict';

const crypto = require('crypto');

const POSITIONS = ['A', 'B', 'C', 'D'];

/**
 * All 24 permutations of four items, in lexicographic order.
 *
 * The index into this array is the stored permutation_key. The order is fixed
 * and must stay fixed: existing rows in randomized_mappings are interpreted
 * against it, so reordering would re-point historical attempts at different
 * options.
 */
const PERMUTATIONS = (function buildPermutations() {
    const out = [];
    const permute = (prefix, rest) => {
        if (rest.length === 0) {
            out.push(prefix);
            return;
        }
        for (let i = 0; i < rest.length; i++) {
            permute(prefix.concat(rest[i]), rest.slice(0, i).concat(rest.slice(i + 1)));
        }
    };
    permute([], [0, 1, 2, 3]);
    return out;
})();

if (PERMUTATIONS.length !== 24) {
    throw new Error(`Permutation table is ${PERMUTATIONS.length}, expected 24.`);
}

/** A permutation key in [0, 23], from a CSPRNG rather than Math.random. */
function randomPermutationKey() {
    return crypto.randomInt(0, PERMUTATIONS.length);
}

/**
 * Build the display mapping for one question.
 *
 * @param {Array<{id:string, original_position:string}>} options the four
 *        options for a question, in any order
 * @param {number} permutationKey 0..23
 * @returns {{permutationKey:number, a:string, b:string, c:string, d:string}}
 *          option id shown at each display position
 */
function buildMapping(options, permutationKey) {
    if (!Array.isArray(options) || options.length !== 4) {
        throw new Error(`Expected exactly 4 options, received ${options ? options.length : 0}.`);
    }
    if (!Number.isInteger(permutationKey) || permutationKey < 0 || permutationKey > 23) {
        throw new Error(`permutationKey must be an integer 0–23, received ${permutationKey}.`);
    }

    // Sort into canonical source order A,B,C,D so the permutation is applied to
    // a stable base regardless of the order rows came back from the database.
    const bySource = POSITIONS.map((letter) => {
        const found = options.find((o) => o.original_position === letter);
        if (!found) throw new Error(`Missing source option "${letter}".`);
        return found;
    });

    const order = PERMUTATIONS[permutationKey];
    return {
        permutationKey,
        a: bySource[order[0]].id,
        b: bySource[order[1]].id,
        c: bySource[order[2]].id,
        d: bySource[order[3]].id,
    };
}

/**
 * Resolve a display position to the option id actually chosen.
 *
 * This is the only sanctioned way to interpret a participant's answer.
 *
 * @param {object} mappingRow row from randomized_mappings
 * @param {string} displayPosition 'A' | 'B' | 'C' | 'D'
 * @returns {string|null} option id, or null if the position is invalid
 */
function resolveDisplayPosition(mappingRow, displayPosition) {
    if (!mappingRow || typeof displayPosition !== 'string') return null;
    switch (displayPosition.toUpperCase()) {
        case 'A': return mappingRow.display_position_a_option_id;
        case 'B': return mappingRow.display_position_b_option_id;
        case 'C': return mappingRow.display_position_c_option_id;
        case 'D': return mappingRow.display_position_d_option_id;
        default: return null;
    }
}

/** Inverse lookup: which display position is showing this option id. */
function findDisplayPosition(mappingRow, optionId) {
    if (!mappingRow || !optionId) return null;
    if (mappingRow.display_position_a_option_id === optionId) return 'A';
    if (mappingRow.display_position_b_option_id === optionId) return 'B';
    if (mappingRow.display_position_c_option_id === optionId) return 'C';
    if (mappingRow.display_position_d_option_id === optionId) return 'D';
    return null;
}

/**
 * Shape the four options for rendering, in display order.
 *
 * Returns position and text only. No option id, no source letter, no
 * correctness flag — anything more would hand the answer key to the browser.
 * See VIEW_CONTRACT.md §2.
 */
function buildChoices(mappingRow, optionsById) {
    return POSITIONS.map((position) => {
        const optionId = resolveDisplayPosition(mappingRow, position);
        const option = optionsById[optionId];
        return { position, text: option ? option.option_text : '' };
    });
}

module.exports = {
    POSITIONS,
    PERMUTATIONS,
    randomPermutationKey,
    buildMapping,
    resolveDisplayPosition,
    findDisplayPosition,
    buildChoices,
};
