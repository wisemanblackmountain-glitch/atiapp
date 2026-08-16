/**
 * Administrator accounts, roles and invitations.
 *
 * ── Roles ───────────────────────────────────────────────────────────────────
 *   OWNER        everything, including managing other administrators
 *   FACILITATOR  runs sessions — PINs, retakes, reports, audit
 *   VIEWER       dashboard and analytics only; no answer key, no actions
 *
 * ── Invitations ─────────────────────────────────────────────────────────────
 * There is no email service on the free tier, so an invitation is a one-time
 * code shown once and handed over — the same pattern as participant PINs.
 *
 * Only the hash is stored. An invite code is a credential: whoever holds one
 * can create an account at the role it carries, so a leaked database must not
 * yield usable codes. The plaintext exists only in the response that created
 * it.
 *
 * ── Deactivation, not deletion ──────────────────────────────────────────────
 * Accounts are disabled rather than removed, so audit rows written months ago
 * still name a real person. `admin_audit` deliberately has no foreign key to
 * this table, but attribution is only meaningful while the account still
 * exists to look up.
 */

'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./pool');

const BCRYPT_ROUNDS = 12;
const INVITE_TTL_HOURS = Number(process.env.ADMIN_INVITE_TTL_HOURS || 72);
const MIN_PASSWORD_LENGTH = 12;

const ROLES = { OWNER: 'OWNER', FACILITATOR: 'FACILITATOR', VIEWER: 'VIEWER' };
const ROLE_LIST = [ROLES.OWNER, ROLES.FACILITATOR, ROLES.VIEWER];

// Compared against when the username is unknown, so a missing account and a
// wrong password cost the same time.
const DUMMY_HASH = '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu';

function iso(v) {
    if (!v) return null;
    return v instanceof Date ? v.toISOString() : String(v);
}

function toAdmin(row) {
    if (!row) return null;
    return {
        id: row.username,
        username: row.username,
        full_name: row.full_name || row.username,
        email: row.email || null,
        role: row.role,
        is_active: row.is_active,
        created_at: iso(row.created_at),
        created_by: row.created_by,
        password_changed_at: iso(row.password_changed_at),
        last_signed_in_at: iso(row.last_signed_in_at),
    };
}

// ── Accounts ─────────────────────────────────────────────────────────────

async function getByUsername(username) {
    const row = await db.queryOne(
        'SELECT * FROM admin_users WHERE lower(username) = lower($1)',
        [String(username || '')]
    );
    if (!row) return null;
    return Object.assign(toAdmin(row), { password_hash: row.password_hash });
}

async function listAll() {
    const rows = await db.query(
        `SELECT * FROM admin_users ORDER BY is_active DESC,
                array_position(ARRAY['OWNER','FACILITATOR','VIEWER'], role), username`
    );
    return rows.map(toAdmin);
}

/**
 * Verify sign-in credentials.
 *
 * A deactivated account fails like a wrong password rather than announcing its
 * state — someone whose access was withdrawn does not need confirmation that
 * their username still exists.
 */
async function verifyCredentials(username, password) {
    const admin = await getByUsername(username);
    const ok = await bcrypt.compare(String(password), admin ? admin.password_hash : DUMMY_HASH);
    if (!admin || !ok || !admin.is_active) return null;
    return toAdmin(admin);
}

async function recordSignIn(username) {
    await db.query(
        'UPDATE admin_users SET last_signed_in_at = now() WHERE lower(username) = lower($1)',
        [String(username)]
    );
}

async function countActiveOwners(excludeUsername = null) {
    const row = await db.queryOne(
        `SELECT count(*)::int AS n FROM admin_users
          WHERE role = 'OWNER' AND is_active
            AND ($1::text IS NULL OR lower(username) <> lower($1))`,
        [excludeUsername]
    );
    return row ? row.n : 0;
}

/**
 * Change a role.
 *
 * Refuses to remove the last active owner. Locking every administrator out of
 * their own system is the kind of mistake that needs database access to undo,
 * so it is prevented rather than warned about.
 */
async function setRole(username, role, client = null) {
    if (!ROLE_LIST.includes(role)) throw new Error(`Unknown role "${role}".`);

    const current = await getByUsername(username);
    if (!current) return { ok: false, reason: 'not-found' };

    if (current.role === ROLES.OWNER && role !== ROLES.OWNER) {
        if (await countActiveOwners(username) === 0) {
            return { ok: false, reason: 'last-owner' };
        }
    }

    const sql = 'UPDATE admin_users SET role = $2 WHERE lower(username) = lower($1)';
    if (client) await client.query(sql, [username, role]);
    else await db.query(sql, [username, role]);
    return { ok: true, previous: current.role };
}

/** Enable or disable an account. Also refuses to strand the last owner. */
async function setActive(username, active, client = null) {
    const current = await getByUsername(username);
    if (!current) return { ok: false, reason: 'not-found' };

    if (!active && current.role === ROLES.OWNER && await countActiveOwners(username) === 0) {
        return { ok: false, reason: 'last-owner' };
    }

    const sql = 'UPDATE admin_users SET is_active = $2 WHERE lower(username) = lower($1)';
    if (client) await client.query(sql, [username, Boolean(active)]);
    else await db.query(sql, [username, Boolean(active)]);
    return { ok: true };
}

async function changePassword(username, newPassword, client = null) {
    if (String(newPassword).length < MIN_PASSWORD_LENGTH) {
        return { ok: false, reason: 'too-short' };
    }
    const hash = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);
    const sql = `UPDATE admin_users
                    SET password_hash = $2, password_changed_at = now()
                  WHERE lower(username) = lower($1)`;
    if (client) await client.query(sql, [username, hash]);
    else await db.query(sql, [username, hash]);
    return { ok: true };
}

// ── Invitations ──────────────────────────────────────────────────────────

/** Codes are read aloud and typed, so the alphabet excludes 0/O and 1/I/L. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateCode() {
    const bytes = crypto.randomBytes(16);
    let out = '';
    for (let i = 0; i < 16; i++) {
        out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
        if (i % 4 === 3 && i < 15) out += '-';
    }
    return out;   // XXXX-XXXX-XXXX-XXXX
}

function hashCode(code) {
    return crypto.createHash('sha256')
        .update(String(code).toUpperCase().replace(/[^A-Z0-9]/g, ''))
        .digest('hex');
}

/**
 * Create an invitation.
 *
 * Returns the plaintext code exactly once. It is not stored and cannot be
 * recovered — a lost invitation is revoked and reissued, not looked up.
 */
async function createInvitation({ fullName, role, invitedBy }, client = null) {
    if (!ROLE_LIST.includes(role)) throw new Error(`Unknown role "${role}".`);

    const code = generateCode();
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 3600 * 1000);

    const sql = `INSERT INTO admin_invitations
                   (token_hash, full_name, role, invited_by, expires_at)
                 VALUES ($1, $2, $3, $4, $5)`;
    const params = [hashCode(code), String(fullName).trim(), role, String(invitedBy), expiresAt];

    if (client) await client.query(sql, params);
    else await db.query(sql, params);

    return { code, expiresAt: expiresAt.toISOString(), role, fullName };
}

async function listInvitations() {
    const rows = await db.query(
        `SELECT id, full_name, role, invited_by, created_at, expires_at,
                accepted_at, accepted_username, revoked_at
           FROM admin_invitations
       ORDER BY created_at DESC LIMIT 100`
    );
    return rows.map((r) => ({
        id: Number(r.id),
        full_name: r.full_name,
        role: r.role,
        invited_by: r.invited_by,
        created_at: iso(r.created_at),
        expires_at: iso(r.expires_at),
        accepted_at: iso(r.accepted_at),
        accepted_username: r.accepted_username,
        revoked_at: iso(r.revoked_at),
        status: r.revoked_at ? 'REVOKED'
            : r.accepted_at ? 'ACCEPTED'
                : (new Date(r.expires_at) < new Date() ? 'EXPIRED' : 'OPEN'),
    }));
}

async function findOpenInvitation(code) {
    return db.queryOne(
        `SELECT * FROM admin_invitations
          WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL
            AND expires_at > now()`,
        [hashCode(code)]
    );
}

async function revokeInvitation(id, client = null) {
    const sql = `UPDATE admin_invitations SET revoked_at = now()
                  WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`;
    if (client) return (await client.query(sql, [id])).rowCount > 0;
    return (await db.execute(sql, [id])).rowCount > 0;
}

/**
 * Redeem an invitation and create the account.
 *
 * Runs as one transaction: an account without its invitation marked accepted
 * would leave the code reusable, and a consumed invitation without an account
 * would strand the invitee.
 */
async function acceptInvitation({ code, username, password }) {
    const invite = await findOpenInvitation(code);
    if (!invite) return { ok: false, reason: 'invalid-code' };

    if (String(password).length < MIN_PASSWORD_LENGTH) {
        return { ok: false, reason: 'password-too-short' };
    }

    const clean = String(username || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{2,39}$/.test(clean)) {
        return { ok: false, reason: 'invalid-username' };
    }
    if (await getByUsername(clean)) return { ok: false, reason: 'username-taken' };

    const hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);

    await db.transaction(async (client) => {
        await client.query(
            `INSERT INTO admin_users
               (username, password_hash, full_name, role, is_active, created_by, password_changed_at)
             VALUES ($1, $2, $3, $4, TRUE, $5, now())`,
            [clean, hash, invite.full_name, invite.role, invite.invited_by]
        );
        await client.query(
            `UPDATE admin_invitations
                SET accepted_at = now(), accepted_username = $2
              WHERE id = $1`,
            [invite.id, clean]
        );
    });

    return { ok: true, username: clean, role: invite.role, fullName: invite.full_name };
}

/** Bootstrap the first owner. Seeding only. */
async function replaceAll(username, password, fullName = '') {
    const hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    return db.transaction(async (client) => {
        await client.query('DELETE FROM admin_invitations');
        await client.query('DELETE FROM admin_users');
        await client.query(
            `INSERT INTO admin_users
               (username, password_hash, full_name, role, is_active, password_changed_at)
             VALUES ($1, $2, $3, 'OWNER', TRUE, now())`,
            [String(username).toLowerCase(), hash, fullName || String(username)]
        );
    });
}

module.exports = {
    ROLES,
    ROLE_LIST,
    MIN_PASSWORD_LENGTH,
    INVITE_TTL_HOURS,
    getByUsername,
    listAll,
    verifyCredentials,
    recordSignIn,
    countActiveOwners,
    setRole,
    setActive,
    changePassword,
    createInvitation,
    listInvitations,
    revokeInvitation,
    acceptInvitation,
    replaceAll,
};
