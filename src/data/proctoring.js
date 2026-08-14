/**
 * Proctoring events.
 *
 * Records the assessment tab being hidden during an attempt, and the escalation
 * that follows: a warning first, ejection on the next occurrence.
 *
 * ── What this actually observes ─────────────────────────────────────────────
 * The Page Visibility API reports the browser's own state. It sees a tab
 * switched away from, a window minimised, a device locked. It cannot see a
 * phone on the desk, a printed sheet, or a second machine. This deters and
 * documents; it does not prevent.
 *
 * ── Why the thresholds exist ────────────────────────────────────────────────
 * visibilitychange fires for far more than deliberate tab-switching — a
 * notification banner, a screen lock, an incoming call. With 32 officers on
 * mixed devices in a ten-minute window, treating every event as cheating would
 * eject people who did nothing wrong, each one costing the facilitator a trip
 * and the officer their running clock. So brief hides are ignored, and the
 * first real one warns rather than ejects.
 */

'use strict';

const db = require('./pool');

// A hide shorter than this is almost always a notification stealing focus.
const GRACE_MS = Number(process.env.PROCTOR_GRACE_MS || 3000);
// Occurrences allowed before ejection. Set PROCTOR_STRIKES=1 for zero tolerance.
const STRIKES = Math.max(1, Number(process.env.PROCTOR_STRIKES || 2));

const EVENTS = { HIDDEN: 'HIDDEN', WARNED: 'WARNED', EJECTED: 'EJECTED' };

function iso(v) {
    if (!v) return null;
    return v instanceof Date ? v.toISOString() : String(v);
}

function toEvent(row) {
    return {
        id: Number(row.id),
        participant_number: row.participant_number,
        occurred_at: iso(row.occurred_at),
        event_type: row.event_type,
        hidden_ms: row.hidden_ms === null ? null : Number(row.hidden_ms),
        detail: row.detail || {},
    };
}

async function record({ participantNumber, eventType, hiddenMs = null, detail = {} }, client = null) {
    const sql = `INSERT INTO proctoring_events
                   (participant_number, event_type, hidden_ms, detail)
                 VALUES ($1, $2, $3, $4::jsonb)`;
    const params = [participantNumber, eventType, hiddenMs, JSON.stringify(detail || {})];
    if (client) await client.query(sql, params);
    else await db.query(sql, params);
}

/**
 * How many qualifying hides this officer has accrued.
 *
 * Counts HIDDEN only — WARNED and EJECTED are consequences, not fresh
 * offences, and counting them would double-charge a single incident.
 */
async function strikeCount(participantNumber) {
    const row = await db.queryOne(
        `SELECT count(*)::int AS n FROM proctoring_events
          WHERE participant_number = $1 AND event_type = 'HIDDEN'`,
        [participantNumber]
    );
    return row ? row.n : 0;
}

/** Every event for one officer, oldest first. Administrator views. */
async function listForParticipant(participantNumber) {
    const rows = await db.query(
        `SELECT * FROM proctoring_events
          WHERE participant_number = $1
       ORDER BY occurred_at ASC, id ASC`,
        [participantNumber]
    );
    return rows.map(toEvent);
}

/** participant number → { hidden, warned, ejected }, for the roster. */
async function summary() {
    const rows = await db.query(
        `SELECT participant_number,
                count(*) FILTER (WHERE event_type = 'HIDDEN')::int  AS hidden,
                count(*) FILTER (WHERE event_type = 'WARNED')::int  AS warned,
                count(*) FILTER (WHERE event_type = 'EJECTED')::int AS ejected
           FROM proctoring_events
       GROUP BY participant_number`
    );
    const out = {};
    for (const r of rows) {
        out[r.participant_number] = {
            hidden: r.hidden, warned: r.warned, ejected: r.ejected,
        };
    }
    return out;
}

async function clearForParticipant(participantNumber, client = null) {
    const sql = 'DELETE FROM proctoring_events WHERE participant_number = $1';
    if (client) await client.query(sql, [participantNumber]);
    else await db.query(sql, [participantNumber]);
}

module.exports = {
    GRACE_MS,
    STRIKES,
    EVENTS,
    record,
    strikeCount,
    listForParticipant,
    summary,
    clearForParticipant,
};
