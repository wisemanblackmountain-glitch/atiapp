/**
 * Participant repository.
 *
 * ── PINs are hashed ─────────────────────────────────────────────────────────
 * The original build stored access_pin as issued. PINs are now bcrypt-hashed:
 * the database is hosted infrastructure with backups and console access, and a
 * six-digit secret sitting in plaintext there is a needless exposure. The
 * plaintext exists in exactly one place — the gitignored credentials file
 * written at seed time, for distribution.
 */

'use strict';

const bcrypt = require('bcryptjs');
const db = require('./pool');

const BCRYPT_ROUNDS = 10;

// Compared against when the participant is unknown, so a missing record and a
// wrong PIN cost comparable time.
const DUMMY_HASH = '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu';

/** Row → the shape routes and views expect. */
function toParticipant(row) {
    if (!row) return null;
    return {
        id: row.participant_number,
        participant_number: row.participant_number,
        full_name: row.full_name,
        title: row.title || '',
        agency: row.agency || '',
        last_name: row.last_name,
        is_active: row.is_active ? 1 : 0,
    };
}

async function getByNumber(participantNumber) {
    return toParticipant(await db.queryOne(
        `SELECT participant_number, full_name, title, agency, last_name, is_active
           FROM participants WHERE participant_number = $1`,
        [participantNumber]
    ));
}

async function listActive() {
    const rows = await db.query(
        `SELECT participant_number, full_name, title, agency, last_name, is_active
           FROM participants WHERE is_active ORDER BY participant_number`
    );
    return rows.map(toParticipant);
}

async function count() {
    const row = await db.queryOne('SELECT count(*)::int AS n FROM participants');
    return row ? row.n : 0;
}

/**
 * Verify sign-in credentials.
 *
 * Returns the participant on success and null on every failure, without
 * distinguishing which field was wrong — naming the failing field would turn
 * the login form into an oracle for enumerating valid participant numbers.
 *
 * The bcrypt comparison runs even when no such participant exists.
 */
async function verifyCredentials(participantNumber, lastName, accessPin) {
    const row = await db.queryOne(
        `SELECT participant_number, full_name, title, agency, last_name, pin_hash, is_active
           FROM participants WHERE participant_number = $1`,
        [participantNumber]
    );

    const pinOk = await bcrypt.compare(String(accessPin), row ? row.pin_hash : DUMMY_HASH);

    if (!row || !row.is_active) return null;

    // Surnames are typed inconsistently; the PIN carries the security.
    const surnameOk = String(row.last_name || '').trim().toLowerCase()
        === String(lastName || '').trim().toLowerCase();

    return (pinOk && surnameOk) ? toParticipant(row) : null;
}

function hashPin(pin) {
    return bcrypt.hash(String(pin), BCRYPT_ROUNDS);
}

/**
 * Replace one officer's PIN, leaving everyone else alone.
 *
 * The seeder reissues all 32 at once, which is right at setup and wrong on the
 * day: an officer who loses their slip would otherwise invalidate the 31 slips
 * already handed out.
 *
 * Accepts a transaction client so the change and its audit row commit together.
 * Returns false if no such officer exists, rather than silently succeeding.
 */
async function setPin(participantNumber, pin, client = null) {
    const hash = await hashPin(pin);
    const sql = `UPDATE participants SET pin_hash = $2 WHERE participant_number = $1`;
    const params = [participantNumber, hash];

    if (client) {
        const res = await client.query(sql, params);
        return res.rowCount > 0;
    }
    const res = await db.execute(sql, params);
    return res.rowCount > 0;
}

/**
 * Replace the whole roster. Seeding only.
 *
 * Runs in one transaction: a half-written roster would let some officers sign
 * in and not others, with no clear signal which.
 *
 * @param {Array} people [{ participant_number, full_name, title, agency, last_name, pin }]
 */
async function replaceAll(people) {
    const hashed = await Promise.all(
        people.map(async (p) => ({ ...p, pin_hash: await hashPin(p.pin) }))
    );

    return db.transaction(async (client) => {
        // Attempts reference participants; clearing them first keeps the
        // cascade explicit rather than implicit.
        await client.query('DELETE FROM participants');

        for (const p of hashed) {
            await client.query(
                `INSERT INTO participants
                   (participant_number, full_name, title, agency, last_name, pin_hash, is_active)
                 VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
                [p.participant_number, p.full_name, p.title || '', p.agency || '', p.last_name, p.pin_hash]
            );
        }
        return hashed.length;
    });
}

module.exports = {
    getByNumber,
    listActive,
    count,
    verifyCredentials,
    hashPin,
    setPin,
    replaceAll,
};
