/**
 * Option randomisation engine.
 *
 * The permutation table is a stored contract, not an implementation detail:
 * randomized_mappings rows are interpreted against it, so reordering it would
 * silently re-point historical attempts at different options. Several tests
 * here exist to make that breakage loud.
 */

'use strict';

const r = require('../src/engines/randomization');

const OPTIONS = [
    { id: 'opt_q1_a', original_position: 'A', option_text: 'Alpha' },
    { id: 'opt_q1_b', original_position: 'B', option_text: 'Bravo' },
    { id: 'opt_q1_c', original_position: 'C', option_text: 'Charlie' },
    { id: 'opt_q1_d', original_position: 'D', option_text: 'Delta' },
];

const OPTIONS_BY_ID = OPTIONS.reduce((acc, o) => { acc[o.id] = o; return acc; }, {});

describe('permutation table', () => {
    test('holds exactly 24 permutations', () => {
        expect(r.PERMUTATIONS).toHaveLength(24);
    });

    test('every permutation is a distinct ordering of 0..3', () => {
        const seen = new Set();
        for (const p of r.PERMUTATIONS) {
            expect([...p].sort()).toEqual([0, 1, 2, 3]);
            seen.add(p.join(''));
        }
        expect(seen.size).toBe(24);
    });

    test('is in lexicographic order and stable across releases', () => {
        // Pinned deliberately. If this fails, stored permutation_key values in
        // randomized_mappings now mean something different and every historical
        // attempt would be re-scored against the wrong options.
        expect(r.PERMUTATIONS[0]).toEqual([0, 1, 2, 3]);
        expect(r.PERMUTATIONS[1]).toEqual([0, 1, 3, 2]);
        expect(r.PERMUTATIONS[23]).toEqual([3, 2, 1, 0]);
    });
});

describe('randomPermutationKey', () => {
    test('always returns an integer in 0..23', () => {
        for (let i = 0; i < 500; i++) {
            const k = r.randomPermutationKey();
            expect(Number.isInteger(k)).toBe(true);
            expect(k).toBeGreaterThanOrEqual(0);
            expect(k).toBeLessThanOrEqual(23);
        }
    });

    test('produces more than one value over many draws', () => {
        const seen = new Set();
        for (let i = 0; i < 300; i++) seen.add(r.randomPermutationKey());
        expect(seen.size).toBeGreaterThan(5);
    });
});

describe('buildMapping', () => {
    test('places all four options, each exactly once, for every key', () => {
        for (let key = 0; key < 24; key++) {
            const m = r.buildMapping(OPTIONS, key);
            const ids = [m.a, m.b, m.c, m.d];
            expect(new Set(ids).size).toBe(4);
            expect([...ids].sort()).toEqual(OPTIONS.map((o) => o.id).sort());
        }
    });

    test('key 0 is the identity ordering', () => {
        const m = r.buildMapping(OPTIONS, 0);
        expect([m.a, m.b, m.c, m.d]).toEqual(['opt_q1_a', 'opt_q1_b', 'opt_q1_c', 'opt_q1_d']);
    });

    test('key 23 fully reverses the source order', () => {
        const m = r.buildMapping(OPTIONS, 23);
        expect([m.a, m.b, m.c, m.d]).toEqual(['opt_q1_d', 'opt_q1_c', 'opt_q1_b', 'opt_q1_a']);
    });

    test('is insensitive to the order options arrive in', () => {
        const shuffled = [OPTIONS[2], OPTIONS[0], OPTIONS[3], OPTIONS[1]];
        expect(r.buildMapping(shuffled, 7)).toEqual(r.buildMapping(OPTIONS, 7));
    });

    test('produces different orderings for different keys', () => {
        const orderings = new Set();
        for (let key = 0; key < 24; key++) {
            const m = r.buildMapping(OPTIONS, key);
            orderings.add([m.a, m.b, m.c, m.d].join('|'));
        }
        expect(orderings.size).toBe(24);
    });

    test('rejects anything other than four options', () => {
        expect(() => r.buildMapping(OPTIONS.slice(0, 3), 0)).toThrow(/exactly 4/);
        expect(() => r.buildMapping([], 0)).toThrow(/exactly 4/);
        expect(() => r.buildMapping(null, 0)).toThrow(/exactly 4/);
    });

    test('rejects out-of-range or non-integer keys', () => {
        expect(() => r.buildMapping(OPTIONS, -1)).toThrow(/0–23/);
        expect(() => r.buildMapping(OPTIONS, 24)).toThrow(/0–23/);
        expect(() => r.buildMapping(OPTIONS, 1.5)).toThrow(/0–23/);
    });

    test('rejects a set missing a source letter', () => {
        const broken = [OPTIONS[0], OPTIONS[1], OPTIONS[2], { id: 'x', original_position: 'E' }];
        expect(() => r.buildMapping(broken, 0)).toThrow(/Missing source option "D"/);
    });
});

describe('resolveDisplayPosition', () => {
    const mapping = {
        display_position_a_option_id: 'opt_q1_c',
        display_position_b_option_id: 'opt_q1_a',
        display_position_c_option_id: 'opt_q1_d',
        display_position_d_option_id: 'opt_q1_b',
    };

    test('resolves each display slot to its stored option', () => {
        expect(r.resolveDisplayPosition(mapping, 'A')).toBe('opt_q1_c');
        expect(r.resolveDisplayPosition(mapping, 'B')).toBe('opt_q1_a');
        expect(r.resolveDisplayPosition(mapping, 'C')).toBe('opt_q1_d');
        expect(r.resolveDisplayPosition(mapping, 'D')).toBe('opt_q1_b');
    });

    test('display letter is not the source letter', () => {
        // The whole point of the engine: pressing "B" did not choose option B.
        expect(r.resolveDisplayPosition(mapping, 'B')).not.toBe('opt_q1_b');
    });

    test('accepts lower case', () => {
        expect(r.resolveDisplayPosition(mapping, 'b')).toBe('opt_q1_a');
    });

    test('returns null for junk input', () => {
        expect(r.resolveDisplayPosition(mapping, 'E')).toBeNull();
        expect(r.resolveDisplayPosition(mapping, '')).toBeNull();
        expect(r.resolveDisplayPosition(mapping, null)).toBeNull();
        expect(r.resolveDisplayPosition(null, 'A')).toBeNull();
    });

    test('round-trips against findDisplayPosition for every key', () => {
        for (let key = 0; key < 24; key++) {
            const m = r.buildMapping(OPTIONS, key);
            const row = {
                display_position_a_option_id: m.a,
                display_position_b_option_id: m.b,
                display_position_c_option_id: m.c,
                display_position_d_option_id: m.d,
            };
            for (const option of OPTIONS) {
                const pos = r.findDisplayPosition(row, option.id);
                expect(r.resolveDisplayPosition(row, pos)).toBe(option.id);
            }
        }
    });

    test('findDisplayPosition returns null for an unknown option', () => {
        expect(r.findDisplayPosition(mapping, 'opt_q9_z')).toBeNull();
        expect(r.findDisplayPosition(null, 'opt_q1_a')).toBeNull();
    });
});

describe('buildChoices — answer-key containment', () => {
    const mapping = {
        display_position_a_option_id: 'opt_q1_c',
        display_position_b_option_id: 'opt_q1_a',
        display_position_c_option_id: 'opt_q1_d',
        display_position_d_option_id: 'opt_q1_b',
    };

    test('returns four choices in display order', () => {
        const choices = r.buildChoices(mapping, OPTIONS_BY_ID);
        expect(choices.map((c) => c.position)).toEqual(['A', 'B', 'C', 'D']);
    });

    test('carries the text of the option actually shown', () => {
        const choices = r.buildChoices(mapping, OPTIONS_BY_ID);
        expect(choices[0].text).toBe('Charlie');
        expect(choices[1].text).toBe('Alpha');
    });

    test('exposes ONLY position and text', () => {
        // This is the containment guarantee. Anything more here reaches the
        // browser and hands a participant the shape of the answer key.
        for (const choice of r.buildChoices(mapping, OPTIONS_BY_ID)) {
            expect(Object.keys(choice).sort()).toEqual(['position', 'text']);
        }
    });

    test('leaks no option id, source letter or correctness even when given them', () => {
        const withKey = {};
        for (const [id, o] of Object.entries(OPTIONS_BY_ID)) {
            withKey[id] = { ...o, is_correct: id === 'opt_q1_b' ? 1 : 0 };
        }
        const serialised = JSON.stringify(r.buildChoices(mapping, withKey));
        expect(serialised).not.toMatch(/is_correct/);
        expect(serialised).not.toMatch(/opt_q\d+_[a-d]/);
        expect(serialised).not.toMatch(/original_position/);
    });

    test('degrades to empty text rather than throwing on a missing option', () => {
        const choices = r.buildChoices(mapping, {});
        expect(choices).toHaveLength(4);
        expect(choices.every((c) => c.text === '')).toBe(true);
    });
});
