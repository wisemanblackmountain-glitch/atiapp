/**
 * Assessment timing.
 *
 * The server owns expiry. public/js/timer.js renders a countdown, but it is
 * display only — every route that accepts a mutation must call hasExpired()
 * before writing, because a client can disable JavaScript, pause a tab, or
 * change its system clock.
 */

'use strict';

const DURATION_MINUTES = Number(process.env.ASSESSMENT_DURATION || 10);
const LOW_WATER_SECONDS = 120;

/** ISO timestamp for "now", the single source of time for the whole app. */
function nowIso() {
    return new Date().toISOString();
}

/** Deadline for an attempt starting at `startIso`. */
function deadlineFrom(startIso) {
    return new Date(Date.parse(startIso) + DURATION_MINUTES * 60 * 1000).toISOString();
}

/** Whole seconds left, floored at zero. */
function secondsRemaining(deadlineIso) {
    const ms = Date.parse(deadlineIso) - Date.now();
    return ms <= 0 ? 0 : Math.floor(ms / 1000);
}

/**
 * Authoritative expiry check.
 *
 * A small grace window absorbs the round trip of an answer saved in the last
 * moment before the deadline. Without it, a click at 9:59.8 that reaches the
 * server at 10:00.1 is discarded, which reads to the participant as a lost
 * answer. The grace applies to saves only; scoring still uses the true
 * deadline.
 */
function hasExpired(deadlineIso, graceSeconds = 0) {
    return Date.now() > Date.parse(deadlineIso) + graceSeconds * 1000;
}

/** mm:ss, for server-rendered fallbacks and admin views. */
function formatDuration(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function isLowWater(deadlineIso) {
    return secondsRemaining(deadlineIso) <= LOW_WATER_SECONDS;
}

module.exports = {
    DURATION_MINUTES,
    LOW_WATER_SECONDS,
    nowIso,
    deadlineFrom,
    secondsRemaining,
    hasExpired,
    formatDuration,
    isLowWater,
};
