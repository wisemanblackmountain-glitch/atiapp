/**
 * Return the system to a pristine state before handover.
 *
 *   node database/reset-handover.js              dry run — shows what would go
 *   node database/reset-handover.js --confirm    actually do it
 *
 * Clears everything that testing leaves behind, so the organisation receives a
 * system with no history of ours in it:
 *
 *   attempts, responses, option mappings   the assessment data
 *   proctoring events                      who left the window during testing
 *   administrator audit                    retakes and reissues we performed
 *   sessions                               anyone still signed in
 *
 * Then reissues all 32 PINs and writes a fresh credentials file.
 *
 * ── Why the audit is cleared here and nowhere else ──────────────────────────
 * The application deliberately cannot edit admin_audit — an audit an operator
 * can quietly tidy is not an audit. This script is the single, explicit,
 * loudly-announced exception, and it exists for one narrow purpose: before
 * go-live the log contains only our test actions, and handing those over as
 * though they were operational history would be misleading.
 *
 * It is emphatically NOT for use once a cohort has sat the assessment. The
 * confirmation below exists to make that hard to do by accident.
 */

'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const pool = require('../src/data/pool');

const ROOT = path.join(__dirname, '..');
const args = new Set(process.argv.slice(2));
const CONFIRMED = args.has('--confirm');

function line(char = '─') { return char.repeat(58); }

async function counts() {
    const row = await pool.queryOne(`
        SELECT (SELECT count(*)::int FROM assessment_attempts) AS attempts,
               (SELECT count(*)::int FROM responses)           AS responses,
               (SELECT count(*)::int FROM randomized_mappings) AS mappings,
               (SELECT count(*)::int FROM proctoring_events)   AS proctoring,
               (SELECT count(*)::int FROM admin_audit)         AS audit,
               (SELECT count(*)::int FROM sessions)            AS sessions,
               (SELECT count(*)::int FROM participants)        AS participants,
               (SELECT count(*)::int FROM questions)           AS questions`);
    return row;
}

async function main() {
    console.log('\nATI ZMATF — reset for handover\n' + line());

    pool.initPool();
    const target = pool.describeTarget();
    console.log(`  TARGET DATABASE   ${target}`);
    console.log(line());

    const before = await counts();

    console.log('  will be DESTROYED:');
    console.log(`    assessment attempts     ${before.attempts}`);
    console.log(`    saved responses         ${before.responses}`);
    console.log(`    option mappings         ${before.mappings}`);
    console.log(`    proctoring events       ${before.proctoring}`);
    console.log(`    administrator audit     ${before.audit}`);
    console.log(`    active sessions         ${before.sessions}`);
    console.log('');
    console.log('  will be KEPT (and PINs reissued):');
    console.log(`    participants            ${before.participants}`);
    console.log(`    questions               ${before.questions}`);
    console.log(line());

    if (!CONFIRMED) {
        console.log('  DRY RUN — nothing has been changed.');
        console.log('');
        console.log('  If the numbers above are what you expect, re-run with:');
        console.log('    node database/reset-handover.js --confirm');
        console.log('');
        console.log('  Check the target database first. This is irreversible,');
        console.log('  and there is no reason ever to run it against a database');
        console.log('  where a cohort has already sat the assessment.');
        console.log('');
        await pool.closePool();
        return;
    }

    // A cohort's results are not something to discard on a flag alone.
    if (before.attempts > 0) {
        console.log(`  WARNING: ${before.attempts} attempt(s) exist on ${target}.`);
        console.log('  If any of these are real officer results, stop now.');
        console.log('');
    }

    await pool.transaction(async (client) => {
        // assessment_attempts cascades to responses and randomized_mappings.
        await client.query('DELETE FROM assessment_attempts');
        await client.query('DELETE FROM proctoring_events');
        await client.query('DELETE FROM admin_audit');
        await client.query('DELETE FROM sessions');
        // Clear any proctoring revocation so nobody starts out locked out.
        await client.query('UPDATE participants SET pin_revoked_at = NULL');
    });

    console.log('  cleared           attempts, proctoring, audit, sessions');
    await pool.closePool();

    // Reissue PINs by delegating to the seeder, so there is one implementation
    // of credential issuing rather than two that could drift apart.
    console.log('  reissuing PINs    (running seed --force)');
    execFileSync(process.execPath, [path.join(__dirname, 'seed.js'), '--force'], {
        cwd: ROOT, stdio: 'inherit',
    });

    // Slips are only regenerated if the tool has been used before, so this does
    // not surprise anyone who distributes credentials another way.
    if (fs.existsSync(path.join(ROOT, 'participant-slips.html'))) {
        console.log('  regenerating slips');
        execFileSync(process.execPath, [path.join(__dirname, 'tools', 'build-slips.js')], {
            cwd: ROOT, stdio: 'inherit',
        });
    }

    // Verify rather than assert.
    pool.initPool();
    const after = await counts();
    const clean = after.attempts === 0 && after.responses === 0 && after.mappings === 0
        && after.proctoring === 0 && after.audit === 0 && after.sessions === 0;

    console.log(line());
    console.log(`  attempts ${after.attempts} | responses ${after.responses} | mappings ${after.mappings}`);
    console.log(`  proctoring ${after.proctoring} | audit ${after.audit} | sessions ${after.sessions}`);
    console.log(`  participants ${after.participants} | questions ${after.questions}`);
    console.log(line());
    console.log(clean
        ? '  Clean. Fresh PINs issued — distribute the new slips.\n'
        : '  NOT CLEAN — something above is non-zero. Investigate before handover.\n');

    await pool.closePool();
    process.exit(clean ? 0 : 1);
}

main().catch(async (err) => {
    console.error('\nReset failed:', err.message, '\n');
    await pool.closePool().catch(() => {});
    process.exit(1);
});
