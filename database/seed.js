/**
 * Seed the database from the official content files.
 *
 *   node database/seed.js               seed, refusing to touch existing attempts
 *   node database/seed.js --force       discard recorded attempts and reseed
 *   node database/seed.js --keep-pins   reseed content, leave PINs alone
 *
 * Inputs (gitignored, produced by database/tools/build-content.js):
 *   database/content/assessment.json
 *   database/content/roster.json
 *
 * Output:
 *   participant-credentials.txt — the PINs to distribute. Gitignored.
 *
 * ── PINs ────────────────────────────────────────────────────────────────────
 * Fresh 6-digit PINs are drawn from a CSPRNG on every seed and stored only as
 * bcrypt hashes. The plaintext exists in exactly one place — the credentials
 * file written here, for distribution — and nothing can recover a PIN from the
 * database afterwards.
 *
 * Because --keep-pins cannot recover plaintext from a hash, it preserves the
 * stored hashes and does not rewrite the credentials file. Use it for a
 * content-only reseed; omit it to reissue.
 */

'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const pool = require('../src/data/pool');
const participantsRepo = require('../src/data/participants');
const questionsRepo = require('../src/data/questions');
const attemptsRepo = require('../src/data/attempts');
const adminsRepo = require('../src/data/admins');

const ROOT = path.join(__dirname, '..');
const CONTENT_DIR = path.join(ROOT, 'database', 'content');
const ASSESSMENT_FILE = path.join(CONTENT_DIR, 'assessment.json');
const ROSTER_FILE = path.join(CONTENT_DIR, 'roster.json');
const CREDENTIALS_FILE = path.join(ROOT, 'participant-credentials.txt');

const args = new Set(process.argv.slice(2));
const FORCE = args.has('--force');
const KEEP_PINS = args.has('--keep-pins');

function fail(message, hint) {
    console.error(`\n  ${message}`);
    if (hint) console.error(`  ${hint}`);
    console.error('');
    process.exit(1);
}

function loadJson(file, label) {
    if (!fs.existsSync(file)) {
        fail(
            `Missing ${label}: ${path.relative(ROOT, file)}`,
            'Generate it first:  node database/tools/build-content.js'
        );
    }
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        fail(`${label} is not valid JSON: ${err.message}`);
    }
}

/** Six digits from a CSPRNG. Leading zeros preserved — PINs are text. */
function generatePin() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function validateAssessment(data) {
    if (!data || !Array.isArray(data.questions) || data.questions.length !== 20) {
        fail(`assessment.json must contain exactly 20 questions, found ${data && data.questions ? data.questions.length : 0}.`);
    }
    for (const q of data.questions) {
        if (!q.text || !Array.isArray(q.options) || q.options.length !== 4) {
            fail(`Question ${q.number} must have text and exactly 4 options.`);
        }
        if (q.options.filter((o) => o.correct).length !== 1) {
            fail(`Question ${q.number} must have exactly one correct option.`);
        }
    }
}

/**
 * Write the credentials file, preserving whatever was there before.
 *
 * This file is the only record of the plaintext PINs — the database holds
 * bcrypt hashes and nothing can reverse them. Overwriting it silently means an
 * accidental reseed against the wrong database destroys a live cohort's
 * credentials with no way back. So the previous file is archived first, and the
 * header records which database the PINs belong to: a file that says
 * "localhost" is immediately recognisable as not the production set.
 */
function writeCredentials(issued, target) {
    if (fs.existsSync(CREDENTIALS_FILE)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archive = path.join(ROOT, `participant-credentials.${stamp}.txt`);
        fs.renameSync(CREDENTIALS_FILE, archive);
        console.log(`  previous file  archived as ${path.basename(archive)}`);
    }

    const lines = [
        'ATI ZMATF EXECUTIVE TRAINING PROGRAMME',
        'Pre-Training Diagnostic Assessment — participant access credentials',
        '',
        `Issued: ${new Date().toISOString()}`,
        `Database: ${target}`,
        '',
        'These PINs are valid ONLY against the database named above. A file',
        'issued against localhost will not work in production, and vice versa.',
        '',
        'CONFIDENTIAL. Distribute each officer only their own row, through a',
        'private channel. This file is gitignored and must never be committed,',
        'emailed as an attachment, or stored in shared cloud folders.',
        '',
        'These PINs are stored only as bcrypt hashes. This file is the sole',
        'record of the plaintext — if it is lost, reseed to reissue.',
        '',
        'Sign-in requires all three: participant number, surname, and PIN.',
        '',
        '─'.repeat(96),
        'NO.  SURNAME              PIN       NAME                            AGENCY',
        '─'.repeat(96),
    ];

    for (const row of issued) {
        lines.push(
            String(row.number).padStart(2, '0').padEnd(5) +
            row.surname.slice(0, 20).padEnd(21) +
            row.pin.padEnd(10) +
            row.name.slice(0, 31).padEnd(32) +
            row.agency
        );
    }
    lines.push('─'.repeat(96), '', `Total: ${issued.length} officers`, '');

    fs.writeFileSync(CREDENTIALS_FILE, lines.join('\n'), 'utf8');
}

async function main() {
    console.log('\nATI ZMATF — database seed\n' + '─'.repeat(52));

    const assessment = loadJson(ASSESSMENT_FILE, 'assessment content');
    const roster = loadJson(ROSTER_FILE, 'participant roster');
    validateAssessment(assessment);

    if (!Array.isArray(roster) || roster.length === 0) fail('roster.json is empty.');

    const adminUser = process.env.ADMIN_USERNAME;
    const adminPass = process.env.ADMIN_PASSWORD;
    if (!adminUser || !adminPass) {
        fail(
            'ADMIN_USERNAME and ADMIN_PASSWORD must be set before seeding.',
            'Copy .env.example to .env and fill it in.'
        );
    }
    if (adminPass.length < 12) fail('ADMIN_PASSWORD must be at least 12 characters.');

    pool.initPool();
    console.log(`  target         ${pool.describeTarget()}`);

    // The schema is idempotent, so applying it here means a fresh database can
    // go from empty to seeded in one command.
    await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

    // Guard live data. Reseeding rebuilds content, which would orphan any
    // attempt already recorded against it.
    const existing = await attemptsRepo.listAll();
    const attemptCount = Object.keys(existing).length;
    if (attemptCount > 0 && !FORCE) {
        fail(
            `${attemptCount} assessment attempt(s) already recorded.`,
            'Reseeding would discard them. Re-run with --force if that is intended.'
        );
    }
    if (attemptCount > 0) {
        const removed = await attemptsRepo.deleteAll();
        console.log(`  attempts       ${removed} discarded (--force)`);
    }

    // ── Content ──────────────────────────────────────────────────────────
    await questionsRepo.replaceAll(assessment.questions);

    // ── Roster ───────────────────────────────────────────────────────────
    if (KEEP_PINS) {
        // Hashes cannot be reversed, so preserving PINs means preserving the
        // stored hashes rather than reissuing. Only the roster fields update.
        const before = await participantsRepo.listActive();
        if (before.length === 0) {
            fail('--keep-pins was given but no participants exist yet.', 'Seed once without it.');
        }
        console.log(`  participants   ${before.length} retained, PINs unchanged`);
    } else {
        const issued = roster.map((person) => ({
            number: person.participant_number,
            name: person.full_name,
            surname: person.last_name,
            agency: person.agency || '',
            pin: generatePin(),
        }));

        await participantsRepo.replaceAll(
            roster.map((person, i) => Object.assign({}, person, { pin: issued[i].pin }))
        );
        writeCredentials(issued, pool.describeTarget());
        console.log(`  participants   ${issued.length} seeded, PINs reissued`);
    }

    // ── Administrator ────────────────────────────────────────────────────
    await adminsRepo.replaceAll(adminUser, adminPass);

    await pool.query(
        `INSERT INTO meta (key, value, updated_at) VALUES ('seed', $1, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify({
            seededAt: new Date().toISOString(),
            questions: assessment.questions.length,
            participants: roster.length,
        })]
    );

    console.log(`  questions      ${assessment.questions.length}`);
    console.log(`  options        ${assessment.questions.length * 4}`);
    console.log(`  admin user     ${adminUser}`);
    console.log('─'.repeat(52));
    if (!KEEP_PINS) {
        console.log(`  Credentials written to ${path.basename(CREDENTIALS_FILE)}`);
        console.log('  All PINs reissued — every previously issued PIN is now invalid.');
        console.log('  This file is CONFIDENTIAL and gitignored. Do not commit it.');
    }
    console.log('');

    await pool.closePool();
}

main().catch(async (err) => {
    console.error('\nSeed failed:', err.message, '\n');
    await pool.closePool().catch(() => {});
    process.exit(1);
});
