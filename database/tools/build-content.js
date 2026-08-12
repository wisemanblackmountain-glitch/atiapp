/**
 * Convert the official ATI source documents into the JSON that seed.js loads.
 *
 *   pre-training-test.txt  →  database/content/assessment.json
 *   participants.txt       →  database/content/roster.json
 *
 * Run:  node database/tools/build-content.js
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The questions, the 80 options, the answer key and the officer roster are all
 * confidential. None of them may be committed. This tool is tracked; its two
 * inputs and both of its outputs are gitignored.
 *
 * The source text is preserved verbatim. Nothing here rewrites, paraphrases or
 * normalises question or option wording — DEVELOPER_HANDOFF §6 forbids it.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'database', 'content');

const TEST_SRC = path.join(ROOT, 'pre-training-test.txt');
const ROSTER_SRC = path.join(ROOT, 'participants.txt');

const LETTERS = ['A', 'B', 'C', 'D'];

/**
 * The sources are Word exports: cells are separated by CR, BEL () and
 * vertical tab () rather than newlines.
 *
 * `clean` turns those into ordinary spaces and collapses runs. It changes
 * whitespace only — never a word, never punctuation — so question and option
 * wording stays verbatim as DEVELOPER_HANDOFF §6 requires.
 */
function clean(text) {
    return String(text)
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function readSource(file, label) {
    if (!fs.existsSync(file)) {
        console.error(`\nMissing source: ${path.relative(ROOT, file)}`);
        console.error(`  ${label} cannot be built without it.\n`);
        process.exit(1);
    }
    return fs.readFileSync(file, 'utf8');
}

// ── Assessment ───────────────────────────────────────────────────────────

function buildAssessment() {
    const raw = readSource(TEST_SRC, 'The question bank');

    // Section B begins at question 11; the source marks it with a heading.
    const sectionBAt = raw.indexOf('SECTION B');

    // Each item: "<n>. <stem>☐ A. <a>☐ B. <b>☐ C. <c>☐ D. <d>"
    const itemRe = /(\d{1,2})\.\s*([^☐]+?)☐\s*A\.\s*([^☐]+?)☐\s*B\.\s*([^☐]+?)☐\s*C\.\s*([^☐]+?)☐\s*D\.\s*([^☐]+?)(?=\d{1,2}\.\s|SECTION|FACILITATOR|$)/g;

    const questions = [];
    let m;
    while ((m = itemRe.exec(raw)) !== null) {
        const number = Number(m[1]);
        if (number < 1 || number > 20) continue;
        questions.push({
            number,
            section: sectionBAt !== -1 && m.index > sectionBAt ? 'B' : 'A',
            text: clean(m[2]),
            index: m.index,
            options: [m[3], m[4], m[5], m[6]].map((text, i) => ({
                position: LETTERS[i],
                text: clean(text),
            })),
        });
    }

    if (questions.length !== 20) {
        console.error(`\nParsed ${questions.length} questions, expected 20. Source format may have changed.\n`);
        process.exit(1);
    }

    // Answer key: a Word table, so strip every separator to leave the bare
    // sequence "1B12C13B1…" of question / answer / marks triples.
    const keyBlock = raw
        .slice(raw.indexOf('Answer Key'))
        .replace(/[\s]+/g, '');
    const keyRe = /(\d{1,2})([A-D])1/g;
    const key = new Map();
    let k;
    while ((k = keyRe.exec(keyBlock)) !== null) {
        const n = Number(k[1]);
        if (n >= 1 && n <= 20 && !key.has(n)) key.set(n, k[2]);
    }

    if (key.size !== 20) {
        console.error(`\nParsed ${key.size} answer-key entries, expected 20.\n`);
        process.exit(1);
    }

    for (const q of questions) {
        const correct = key.get(q.number);
        if (!correct) {
            console.error(`\nNo answer key for question ${q.number}.\n`);
            process.exit(1);
        }
        let marked = 0;
        for (const opt of q.options) {
            opt.correct = opt.position === correct;
            if (opt.correct) marked += 1;
        }
        if (marked !== 1) {
            console.error(`\nQuestion ${q.number} has ${marked} correct options, expected exactly 1.\n`);
            process.exit(1);
        }
        delete q.index;
    }

    questions.sort((a, b) => a.number - b.number);
    return { totalMarks: 20, questions };
}

// ── Roster ───────────────────────────────────────────────────────────────

/**
 * The roster is a four-column Word table (S/N, Name, Title, Agency) whose
 * cells are delimited by CR + BEL. Splitting on that delimiter is exact, so no
 * guessing at where a name ends and a designation begins is required.
 */
function buildRoster() {
    const raw = readSource(ROSTER_SRC, 'The participant roster');

    const headerAt = raw.indexOf('S/N');
    const end = raw.indexOf('Total Participants');
    if (headerAt === -1 || end === -1) {
        console.error('\nCould not locate the participant table in participants.txt.\n');
        process.exit(1);
    }

    const cells = raw
        .slice(headerAt, end)
        .split(/[\r\n]+/)
        .map((c) => clean(c))
        .filter(Boolean);

    // Drop the four header cells.
    const header = cells.splice(0, 4);
    if (header[0] !== 'S/N' || header[1] !== 'Name') {
        console.error(`\nUnexpected roster header: ${header.join(' | ')}\n`);
        process.exit(1);
    }

    const roster = [];
    for (let i = 0; i + 3 < cells.length; i += 4) {
        const [num, fullName, title, agency] = cells.slice(i, i + 4);
        const n = Number(num);

        // The sequence number must be the one expected next; anything else
        // means the column alignment has drifted and the data would be wrong.
        if (!Number.isInteger(n) || n !== roster.length + 1) {
            console.error(
                `\nRoster column alignment lost at entry ${roster.length + 1} ` +
                `(read "${num}"). Source format may have changed.\n`
            );
            process.exit(1);
        }

        const parts = fullName.split(/\s+/).filter(Boolean);
        if (parts.length < 2) {
            console.error(`\nRoster entry ${n} produced an implausible name.\n`);
            process.exit(1);
        }

        roster.push({
            participant_number: n,
            full_name: fullName,
            title,
            agency,
            // Surname used at sign-in: the final component of the name.
            last_name: parts[parts.length - 1],
        });

        if (roster.length === 32) break;   // facilitators follow; excluded per §7
    }

    // Facilitators are explicitly excluded from the diagnostic roster
    // (DEVELOPER_HANDOFF §7). Only the 32 participants are emitted.
    if (roster.length !== 32) {
        console.error(`\nBuilt ${roster.length} roster entries, expected 32.\n`);
        process.exit(1);
    }
    return roster;
}

// ── Emit ─────────────────────────────────────────────────────────────────

function main() {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

    const assessment = buildAssessment();
    const roster = buildRoster();

    fs.writeFileSync(
        path.join(OUT_DIR, 'assessment.json'),
        JSON.stringify(assessment, null, 2) + '\n'
    );
    fs.writeFileSync(
        path.join(OUT_DIR, 'roster.json'),
        JSON.stringify(roster, null, 2) + '\n'
    );

    console.log(`assessment.json  ${assessment.questions.length} questions, ` +
        `${assessment.questions.length * 4} options`);
    console.log(`roster.json      ${roster.length} participants`);
    console.log(`\nBoth written to database/content/ — gitignored. Now run: npm run seed`);
}

main();
