/**
 * Seed the database from the official content files.
 *
 *   node database/seed.js            seed, refusing to touch existing attempts
 *   node database/seed.js --force    wipe attempts and reseed from scratch
 *   node database/seed.js --keep-pins  reseed but preserve issued PINs
 *
 * Inputs (gitignored, produced by database/tools/build-content.js):
 *   database/content/assessment.json
 *   database/content/roster.json
 *
 * Output:
 *   participant-credentials.txt — the PINs to distribute. Gitignored.
 *
 * ── Why PINs are generated here ─────────────────────────────────────────────
 * Credentials are never committed and never read from a tracked file. Each
 * seed issues fresh 6-digit PINs from a CSPRNG and writes them to one
 * gitignored file for distribution. Re-seeding therefore invalidates every
 * previously issued PIN, which is exactly what you want after a credential
 * exposure — and is the mechanism for the reissue this project needs.
 */

'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const db = require('../src/utils/db');

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

/** Six digits from a CSPRNG. Leading zeros are preserved — PINs are text. */
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

async function main() {
    console.log('\nATI ZMATF — database seed\n' + '─'.repeat(52));

    const assessment = loadJson(ASSESSMENT_FILE, 'assessment content');
    const roster = loadJson(ROSTER_FILE, 'participant roster');
    validateAssessment(assessment);

    if (!Array.isArray(roster) || roster.length === 0) {
        fail('roster.json is empty.');
    }

    await db.initDb();
    db.initializeSchema();

    // Guard live data. Reseeding rebuilds content and roster ids, which would
    // orphan any attempt already recorded against them.
    const existing = db.get('SELECT COUNT(*) AS n FROM assessment_attempts');
    if (existing && existing.n > 0 && !FORCE) {
        fail(
            `${existing.n} assessment attempt(s) already recorded.`,
            'Reseeding would discard them. Re-run with --force if that is intended.'
        );
    }

    // Preserve issued PINs across a content-only reseed when asked.
    const previousPins = new Map();
    if (KEEP_PINS) {
        for (const row of db.all('SELECT participant_number, access_pin FROM participants')) {
            previousPins.set(row.participant_number, row.access_pin);
        }
    }

    const issued = [];

    db.transaction(() => {
        db.run('DELETE FROM responses');
        db.run('DELETE FROM randomized_mappings');
        db.run('DELETE FROM assessment_attempts');
        db.run('DELETE FROM options');
        db.run('DELETE FROM questions');
        db.run('DELETE FROM participants');

        // ── Questions and options ────────────────────────────────────────
        // Option ids are contract-locked as opt_q<N>_<a|b|c|d>, keyed on the
        // SOURCE letter. Display order is decided per attempt at runtime and
        // has nothing to do with these ids (DEVELOPER_HANDOFF §14.2).
        for (const q of assessment.questions) {
            db.run(
                `INSERT INTO questions (question_number, section_label, question_text, marks)
                 VALUES (?, ?, ?, ?)`,
                [q.number, q.section, q.text, 1]
            );
            const questionId = db.lastInsertId();

            for (const option of q.options) {
                db.run(
                    `INSERT INTO options (id, question_id, original_position, option_text, is_correct)
                     VALUES (?, ?, ?, ?, ?)`,
                    [
                        `opt_q${q.number}_${option.position.toLowerCase()}`,
                        questionId,
                        option.position,
                        option.text,
                        option.correct ? 1 : 0,
                    ]
                );
            }
        }

        // ── Participants ─────────────────────────────────────────────────
        for (const person of roster) {
            const pin = (KEEP_PINS && previousPins.get(person.participant_number))
                || generatePin();

            db.run(
                `INSERT INTO participants
                   (participant_number, full_name, title, agency, last_name, access_pin, is_active)
                 VALUES (?, ?, ?, ?, ?, ?, 1)`,
                [
                    person.participant_number,
                    person.full_name,
                    person.title || '',
                    person.agency || '',
                    person.last_name,
                    pin,
                ]
            );

            issued.push({
                number: person.participant_number,
                name: person.full_name,
                surname: person.last_name,
                agency: person.agency || '',
                pin,
            });
        }
    });

    // ── Administrator ────────────────────────────────────────────────────
    const adminUser = process.env.ADMIN_USERNAME;
    const adminPass = process.env.ADMIN_PASSWORD;
    if (!adminUser || !adminPass) {
        fail(
            'ADMIN_USERNAME and ADMIN_PASSWORD must be set in .env before seeding.',
            'Copy .env.example to .env and fill it in.'
        );
    }

    const hash = await bcrypt.hash(adminPass, 12);
    db.transaction(() => {
        db.run('DELETE FROM admin_users');
        db.run('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)', [
            adminUser,
            hash,
        ]);
    });

    // ── Credentials file ─────────────────────────────────────────────────
    const stamp = new Date().toISOString();
    const lines = [
        'ATI ZMATF EXECUTIVE TRAINING PROGRAMME',
        'Pre-Training Diagnostic Assessment — participant access credentials',
        '',
        `Issued: ${stamp}`,
        '',
        'CONFIDENTIAL. Distribute each officer only their own row, through a',
        'private channel. This file is gitignored and must never be committed,',
        'emailed as an attachment, or stored in shared cloud folders.',
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

    db.flush();
    db.closeDb();

    console.log(`  questions      ${assessment.questions.length}`);
    console.log(`  options        ${assessment.questions.length * 4}`);
    console.log(`  participants   ${issued.length}`);
    console.log(`  admin user     ${adminUser}`);
    console.log(`  database       ${path.relative(ROOT, db.DB_FILE)}`);
    console.log('─'.repeat(52));
    console.log(`  Credentials written to ${path.basename(CREDENTIALS_FILE)}`);
    if (!KEEP_PINS) {
        console.log('  All PINs regenerated — any previously issued PIN is now invalid.');
    }
    console.log('  This file is CONFIDENTIAL and gitignored. Do not commit it.\n');
}

main().catch((err) => {
    console.error('\nSeed failed:', err.message, '\n');
    process.exit(1);
});
