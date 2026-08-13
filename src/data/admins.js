/**
 * Administrator accounts.
 *
 * Passwords are bcrypt-hashed at seed time from ADMIN_PASSWORD and stored in no
 * other form.
 */

'use strict';

const bcrypt = require('bcryptjs');
const db = require('./pool');

const BCRYPT_ROUNDS = 12;

// Compared against when the username is unknown, so a missing account and a
// wrong password cost the same time.
const DUMMY_HASH = '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidiu';

async function getByUsername(username) {
    const row = await db.queryOne(
        'SELECT username, password_hash FROM admin_users WHERE username = $1',
        [String(username)]
    );
    return row ? { id: row.username, username: row.username, password_hash: row.password_hash } : null;
}

/** Returns the admin on success, null on any failure. */
async function verifyCredentials(username, password) {
    const admin = await getByUsername(username);
    const ok = await bcrypt.compare(String(password), admin ? admin.password_hash : DUMMY_HASH);
    return (admin && ok) ? { id: admin.username, username: admin.username } : null;
}

async function replaceAll(username, password) {
    const hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    return db.transaction(async (client) => {
        await client.query('DELETE FROM admin_users');
        await client.query(
            'INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)',
            [String(username), hash]
        );
    });
}

module.exports = { getByUsername, verifyCredentials, replaceAll };
