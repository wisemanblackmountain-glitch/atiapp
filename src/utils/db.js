/**
 * SQLite access layer, backed by sql.js (SQLite compiled to WebAssembly).
 *
 * sql.js holds the entire database in memory. Nothing reaches disk until
 * export() is called, so every mutation path must persist. `run()` and
 * `transaction()` below do that for you — reach for those rather than driving
 * the raw handle.
 *
 * Note on WAL: DEVELOPER_HANDOFF §2 mentions WAL mode. WAL is a file-locking
 * strategy for the native SQLite driver and has no meaning under sql.js, which
 * has no incremental file writes to journal. Durability here comes from
 * serialising the whole image on write.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, '..', '..', 'database');
const DB_FILE = path.join(DB_DIR, 'ati-assessment.db');
const SCHEMA_FILE = path.join(DB_DIR, 'schema.sql');

let SQL = null;
let db = null;
let dirty = false;
let flushTimer = null;

/** Load the WASM engine and open (or create) the database image. */
async function initDb() {
    if (db) return db;

    const initSqlJs = require('sql.js');
    SQL = await initSqlJs({
        // sql.js ships the .wasm alongside its entry point.
        locateFile: (file) => path.join(path.dirname(require.resolve('sql.js')), file),
    });

    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

    db = fs.existsSync(DB_FILE)
        ? new SQL.Database(fs.readFileSync(DB_FILE))
        : new SQL.Database();

    db.run('PRAGMA foreign_keys = ON;');
    return db;
}

function getDb() {
    if (!db) throw new Error('Database not initialised. Call initDb() first.');
    return db;
}

function initializeSchema() {
    getDb().run(fs.readFileSync(SCHEMA_FILE, 'utf8'));
    persist();
}

/**
 * Serialise the in-memory image to disk.
 *
 * Written to a temporary file and renamed, so a crash mid-write cannot leave a
 * truncated database where a valid one used to be.
 */
function persist() {
    if (!db) return;
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, Buffer.from(db.export()));
    fs.renameSync(tmp, DB_FILE);
    dirty = false;
}

/**
 * Coalesce bursts of writes into one disk hit.
 *
 * Answer saves arrive one click at a time; flushing synchronously on each is
 * wasteful when the whole image is rewritten every time. A pending flush is
 * always forced before shutdown and before any read that must see disk state.
 */
function persistSoon() {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        if (dirty) persist();
    }, 250);
    if (flushTimer.unref) flushTimer.unref();
}

function flush() {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    if (dirty) persist();
}

// ── Query helpers ────────────────────────────────────────────────────────
// sql.js returns positional arrays; these normalise to plain objects so
// callers never index by column position.

function all(sql, params = []) {
    const stmt = getDb().prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
}

function get(sql, params = []) {
    const rows = all(sql, params);
    return rows.length ? rows[0] : null;
}

/** Execute a mutation and schedule a flush. */
function run(sql, params = []) {
    const stmt = getDb().prepare(sql);
    stmt.bind(params);
    stmt.step();
    stmt.free();
    persistSoon();
}

/**
 * Run `fn` inside a transaction, flushing once at the end.
 *
 * Starting an attempt writes 20 mapping rows plus the attempt itself; without
 * this they would be 21 separate full-image writes, and a failure part-way
 * would leave an attempt with an incomplete option mapping.
 */
function transaction(fn) {
    const handle = getDb();
    handle.run('BEGIN');
    try {
        const result = fn();
        handle.run('COMMIT');
        flush();
        return result;
    } catch (err) {
        handle.run('ROLLBACK');
        throw err;
    }
}

function lastInsertId() {
    const row = get('SELECT last_insert_rowid() AS id');
    return row ? row.id : null;
}

/** True once content and roster are present. Used by server.js on boot. */
function isSeeded() {
    try {
        const q = get('SELECT COUNT(*) AS n FROM questions');
        const p = get('SELECT COUNT(*) AS n FROM participants');
        return Boolean(q && p && q.n > 0 && p.n > 0);
    } catch (err) {
        // Tables absent on a fresh image.
        return false;
    }
}

function closeDb() {
    if (!db) return;
    flush();
    db.close();
    db = null;
}

module.exports = {
    initDb,
    getDb,
    initializeSchema,
    isSeeded,
    closeDb,
    all,
    get,
    run,
    transaction,
    lastInsertId,
    persist,
    flush,
    DB_FILE,
};
