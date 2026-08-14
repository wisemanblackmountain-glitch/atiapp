/**
 * ATI ZMATF — assessment window monitoring
 *
 * Reports when the assessment tab is hidden during an attempt. The server
 * decides what follows: a warning first, ejection on the next occurrence.
 *
 * ── What this can and cannot see ────────────────────────────────────────────
 * The Page Visibility API reports this browser's own state — a tab switched
 * away from, a window minimised, a device locked. It cannot see a phone on the
 * desk or a second machine. This deters and documents; it does not prevent, and
 * it should not be described to participants as though it does.
 *
 * ── Why brief hides are ignored ─────────────────────────────────────────────
 * visibilitychange fires for far more than deliberate switching: a notification
 * banner, an incoming call, a screen locking on idle. Reporting every one would
 * eject officers who did nothing wrong. Only hides longer than the server's
 * grace period are sent, and the server applies its own threshold again — the
 * client is not trusted to be the only check.
 *
 * Disclosed on the briefing screen. Monitoring people without telling them is
 * not something to do quietly.
 */

(function () {
    'use strict';

    var group = document.getElementById('option-group');
    var reviewMarker = document.getElementById('review-remaining');
    // Only run where an attempt is actually in progress.
    if (!group && !reviewMarker) return;

    var meta = document.querySelector('meta[name="csrf-token"]');
    var csrfToken = meta ? meta.content : '';

    var hiddenAt = null;
    var reporting = false;

    function banner(message, tone) {
        var existing = document.getElementById('proctor-banner');
        if (existing) existing.remove();

        var el = document.createElement('div');
        el.id = 'proctor-banner';
        el.className = tone === 'danger' ? 'alert alert-danger' : 'alert';
        el.setAttribute('role', 'alert');
        el.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);'
            + 'top:12px;z-index:200;max-width:560px;box-shadow:var(--flat-lg)';
        el.textContent = message;
        document.body.appendChild(el);
    }

    function currentQuestion() {
        return group ? group.dataset.questionNumber || null : null;
    }

    /**
     * Report a hide and act on the verdict.
     *
     * Uses fetch rather than sendBeacon because the response matters — the
     * officer needs to be told they have been warned, or moved off a session
     * that no longer exists.
     */
    function report(hiddenMs) {
        if (reporting) return;
        reporting = true;

        fetch('/assessment/proctor-event', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
            body: JSON.stringify({ hiddenMs: hiddenMs, question: currentQuestion() }),
            credentials: 'same-origin',
        })
            .then(function (res) { return res.ok ? res.json() : null; })
            .then(function (data) {
                if (!data) return;
                if (data.status === 'ejected') {
                    window.location.href = data.redirect || '/assessment/ejected';
                    return;
                }
                if (data.status === 'warned') {
                    banner(data.message || 'Leaving the assessment window again will end your session.', 'danger');
                }
            })
            .catch(function () {
                // A failed report must not break the assessment. The server
                // still holds whatever it recorded.
            })
            .finally(function () { reporting = false; });
    }

    document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
            hiddenAt = Date.now();
            return;
        }

        if (hiddenAt === null) return;
        var away = Date.now() - hiddenAt;
        hiddenAt = null;

        // The server applies the authoritative threshold; this only avoids
        // sending obvious noise.
        if (away >= 1000) report(away);
    });

    /**
     * Closing the tab outright.
     *
     * fetch will not survive the unload, so this is the one case for a beacon:
     * fire-and-forget, no verdict, but the event is still recorded. The officer
     * finds out when they sign back in.
     */
    window.addEventListener('pagehide', function () {
        if (document.visibilityState !== 'hidden') return;
        if (!navigator.sendBeacon) return;

        var payload = new Blob(
            [JSON.stringify({ hiddenMs: 60000, question: currentQuestion(), _csrf: csrfToken })],
            { type: 'application/json' }
        );
        navigator.sendBeacon('/assessment/proctor-event', payload);
    });
})();
