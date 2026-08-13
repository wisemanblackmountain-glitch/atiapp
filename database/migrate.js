/**
 * Apply database/schema.sql.
 *
 *   node database/migrate.js
 *
 * The schema is written to be idempotent — every statement is CREATE ... IF NOT
 * EXISTS — so this is safe to run on every deploy. Render's start command runs
 * it before the server boots, which means a fresh Neon database becomes usable
 * without a manual step.
 *
 * This is deliberately not a versioned migration framework. The schema is small
 * and the deployment is a single service; adding one would be more moving parts
 * than the problem needs. If the schema starts changing under live data, that
 * calculation changes.
 */

'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const pool = require('../src/data/pool');

const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

async function main() {
    const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');

    pool.initPool();
    console.log(`\nApplying schema to ${pool.describeTarget()}`);

    await pool.query(sql);

    const tables = await pool.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' ORDER BY table_name`
    );

    console.log(`  ${tables.length} tables present: ${tables.map((t) => t.table_name).join(', ')}`);
    console.log('  schema applied\n');

    await pool.closePool();
}

main().catch(async (err) => {
    console.error('\nMigration failed:', err.message, '\n');
    await pool.closePool().catch(() => {});
    process.exit(1);
});
