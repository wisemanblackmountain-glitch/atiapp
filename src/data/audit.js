/**
 * Administrator audit trail.
 *
 * Append-only. There is deliberately no update or delete here — an audit that
 * can be edited is not an audit. If a row ever needs correcting, the correction
 * is another row.
 *
 * Two actions are recorded, both destructive and both invisible afterwards
 * unless written down:
 *   RETAKE_ALLOWED — an attempt was cleared so an officer could sit again
 *   PIN_REISSUED   — one officer's PIN was replaced
 *
 * The detail column captures what was discarded. "Officer 12 was allowed to
 * retake" is far less useful six months on than "officer 12 was allowed to
 * retake, discarding a completed attempt scoring 16/20".
 *
 * PINs are never recorded here, in any form.
 */

'use strict';

const db = require('./pool');

/**
 * The recordable actions.
 *
 * Mirrors the CHECK constraint on admin_audit. Kept as an explicit whitelist so
 * a typo fails loudly at the call site rather than being written and only
 * surfacing as a constraint violation — or, worse, as a category nobody
 * queries for.
 *
 * Two groups: what was done to an assessment, and who was given access to do
 * it. In an organisation with several facilitators, "who let that person in?"
 * is exactly the question an audit exists to answer.
 */
const ACTIONS = {
    // Assessment
    RETAKE_ALLOWED: 'RETAKE_ALLOWED',
    PIN_REISSUED: 'PIN_REISSUED',
    // Administrator accounts
    ADMIN_INVITED: 'ADMIN_INVITED',
    ADMIN_INVITE_REVOKED: 'ADMIN_INVITE_REVOKED',
    ADMIN_JOINED: 'ADMIN_JOINED',
    ADMIN_ROLE_CHANGED: 'ADMIN_ROLE_CHANGED',
    ADMIN_DEACTIVATED: 'ADMIN_DEACTIVATED',
    ADMIN_REACTIVATED: 'ADMIN_REACTIVATED',
    ADMIN_PASSWORD_CHANGED: 'ADMIN_PASSWORD_CHANGED',
};

function iso(value) {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : String(value);
}

function toEntry(row) {
    return {
        id: Number(row.id),
        occurred_at: iso(row.occurred_at),
        admin_username: row.admin_username,
        action: row.action,
        participant_number: row.participant_number,
        detail: row.detail || {},
        ip_address: row.ip_address,
    };
}

/**
 * Record an action.
 *
 * Accepts an optional client so the write can join the same transaction as the
 * change it describes — an audit row that survives a rolled-back deletion would
 * claim something happened that did not.
 */
async function record({ adminUsername, action, participantNumber, detail = {}, ipAddress }, client = null) {
    if (!ACTIONS[action]) throw new Error(`Unknown audit action "${action}".`);

    const sql = `INSERT INTO admin_audit
                   (admin_username, action, participant_number, detail, ip_address)
                 VALUES ($1, $2, $3, $4::jsonb, $5)`;
    const params = [
        String(adminUsername),
        action,
        participantNumber === undefined ? null : participantNumber,
        JSON.stringify(detail || {}),
        ipAddress || null,
    ];

    if (client) {
        await client.query(sql, params);
    } else {
        await db.query(sql, params);
    }
}

async function listRecent(limit = 100) {
    const rows = await db.query(
        `SELECT * FROM admin_audit ORDER BY occurred_at DESC, id DESC LIMIT $1`,
        [Math.min(Number(limit) || 100, 500)]
    );
    return rows.map(toEntry);
}

async function listForParticipant(participantNumber) {
    const rows = await db.query(
        `SELECT * FROM admin_audit
          WHERE participant_number = $1
       ORDER BY occurred_at DESC, id DESC`,
        [participantNumber]
    );
    return rows.map(toEntry);
}

async function count() {
    const row = await db.queryOne('SELECT count(*)::int AS n FROM admin_audit');
    return row ? row.n : 0;
}

module.exports = { ACTIONS, record, listRecent, listForParticipant, count };
