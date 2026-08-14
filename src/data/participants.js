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
    // pin_issued_at moves forward, which resets the "untried" state — the new
    // PIN has not been used, whatever the old one's history.
    // Clearing pin_revoked_at is what makes reissue the remedy for an
    // ejection: the officer gets a working PIN and a clean slate.
    const sql = `UPDATE participants
                    SET pin_hash = $2, pin_issued_at = now(), pin_revoked_at = NULL
                  WHERE participant_number = $1`;
    const params = [participantNumber, hash];

    if (client) {
        const res = await client.query(sql, params);
        return res.rowCount > 0;
    }
    const res = await db.execute(sql, params);
    return res.rowCount > 0;
}

/**
 * Withdraw an officer's access.
 *
 * Used when proctoring ejects someone. The PIN is replaced with a value nobody
 * holds — including us — rather than blanked, so no code path can treat an
 * empty hash as a match. pin_revoked_at records why, which lets sign-in say
 * "see the facilitator" instead of a bare credential failure. That matters
 * because the facilitator is standing in the same room, and a confusing error
 * would send the officer hunting for a typo that isn't there.
 *
 * A reissue clears the revocation: setPin overwrites the hash, and the routes
 * below clear the timestamp alongside it.
 */
async function revokePin(participantNumber, client = null) {
    const unguessable = await bcrypt.hash(
        require('crypto').randomBytes(24).toString('hex'), BCRYPT_ROUNDS
    );
    const sql = `UPDATE participants
                    SET pin_hash = $2, pin_revoked_at = now()
                  WHERE participant_number = $1`;
    const params = [participantNumber, unguessable];
    if (client) return (await client.query(sql, params)).rowCount > 0;
    return (await db.execute(sql, params)).rowCount > 0;
}

/** True when access was withdrawn and not since reissued. */
async function isRevoked(participantNumber) {
    const row = await db.queryOne(
        'SELECT pin_revoked_at FROM participants WHERE participant_number = $1',
        [participantNumber]
    );
    return Boolean(row && row.pin_revoked_at);
}

/**
 * Stamp a successful sign-in.
 *
 * This is what makes a PIN "tried". Recorded on sign-in rather than on
 * starting an attempt, because an officer who signs in and reads the briefing
 * has used their PIN even if they never press begin — and a reissue at that
 * point would strand them.
 *
 * Failures are swallowed: a bookkeeping write must never turn a valid sign-in
 * into an error.
 */
async function recordSignIn(participantNumber) {
    try {
        await db.execute(
            'UPDATE participants SET last_signed_in_at = now() WHERE participant_number = $1',
            [participantNumber]
        );
    } catch (err) {
        console.error('Could not record sign-in time:', err.message);
    }
}

/**
 * Has the current PIN been used since it was issued?
 *
 * Returns { used, lastSignedInAt, pinIssuedAt } or null if no such officer.
 */
async function pinUsage(participantNumber) {
    const row = await db.queryOne(
        `SELECT pin_issued_at, last_signed_in_at,
                (last_signed_in_at IS NOT NULL AND last_signed_in_at >= pin_issued_at) AS used
           FROM participants WHERE participant_number = $1`,
        [participantNumber]
    );
    if (!row) return null;
    return {
        used: Boolean(row.used),
        pinIssuedAt: row.pin_issued_at,
        lastSignedInAt: row.last_signed_in_at,
    };
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
    revokePin,
    isRevoked,
    recordSignIn,
    pinUsage,
    replaceAll,
};
