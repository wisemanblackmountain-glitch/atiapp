/**
 * ATI ZMATF — Assessment countdown
 *
 * Renders the remaining time and triggers auto-submission at zero.
 *
 * ── This clock is DISPLAY ONLY ──────────────────────────────────────────────
 * The server owns expiry. It stamps deadline_at when the attempt starts and
 * must re-check it on POST /assessment/submit and on every save-answer. A
 * participant with a manipulated system clock, a paused tab, or JavaScript
 * disabled changes what is shown here and nothing else.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Markup contract (views/layouts/main.ejs):
 *   #assessment-timer[data-deadline]   ISO timestamp, required
 *   #assessment-timer[data-now]        ISO server time at render, optional.
 *                                      When present, corrects for client clock skew.
 *   #timer-announcer                   visually hidden, aria-live="polite"
 *
 * Also updates #review-remaining on the review screen when present.
 */

(function () {
    'use strict';

    var el = document.getElementById('assessment-timer');
    if (!el || !el.dataset.deadline) return;

    var deadline = Date.parse(el.dataset.deadline);
    if (isNaN(deadline)) return;

    var mirror = document.getElementById('review-remaining');
    var announcer = document.getElementById('timer-announcer');

    /* Clock skew correction. If the server told us its own time at render, any
       difference from the browser clock is offset applied to every reading. */
    var skew = 0;
    if (el.dataset.now) {
        var serverNow = Date.parse(el.dataset.now);
        if (!isNaN(serverNow)) skew = Date.now() - serverNow;
    }

    var LOW_WATER = 120;   // seconds — shift to calm amber
    var lastShown = null;
    var announced = {};
    var submitted = false;

    function remaining() {
        return Math.max(0, Math.round((deadline - (Date.now() - skew)) / 1000));
    }

    function format(total) {
        var m = Math.floor(total / 60);
        var s = total % 60;
        return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }

    /* Milestones are announced to screen readers, but the visible timer is
       aria-live="off" — a value read aloud every second would be unusable. */
    function announce(total) {
        if (!announcer) return;
        var marks = [300, 120, 60, 30];
        for (var i = 0; i < marks.length; i++) {
            var mark = marks[i];
            if (total <= mark && !announced[mark]) {
                announced[mark] = true;
                announcer.textContent = mark >= 60
                    ? (mark / 60) + (mark === 60 ? ' minute remaining' : ' minutes remaining')
                    : mark + ' seconds remaining';
                return;
            }
        }
    }

    /**
     * Auto-submission. Builds a real form and submits it rather than using
     * fetch, so the browser follows the redirect to the results page exactly as
     * a manual submission would. Fires once.
     */
    function autoSubmit() {
        if (submitted) return;
        submitted = true;

        if (announcer) announcer.textContent = 'Time has run out. Submitting your assessment.';

        var meta = document.querySelector('meta[name="csrf-token"]');
        var form = document.createElement('form');
        form.method = 'POST';
        form.action = '/assessment/submit';
        form.style.display = 'none';

        if (meta && meta.content) {
            var token = document.createElement('input');
            token.type = 'hidden';
            token.name = '_csrf';
            token.value = meta.content;
            form.appendChild(token);
        }

        var reason = document.createElement('input');
        reason.type = 'hidden';
        reason.name = 'autoSubmit';
        reason.value = '1';
        form.appendChild(reason);

        document.body.appendChild(form);
        form.submit();
    }

    function tick() {
        var total = remaining();

        /* Only touch the DOM when the displayed second actually changes. */
        if (total !== lastShown) {
            lastShown = total;
            var text = format(total);

            el.textContent = text;
            if (mirror) mirror.textContent = text;

            /* Calm amber at two minutes, and nothing further. The timer never
               pulses, flashes, or turns red — manufacturing anxiety during a
               timed assessment is a design failure, not a feature. */
            if (total <= LOW_WATER) el.classList.add('is-low');

            announce(total);
        }

        if (total <= 0) {
            autoSubmit();
            return;
        }

        window.setTimeout(tick, 200);
    }

    /* Recompute immediately when the tab regains focus, so a backgrounded tab
       never shows a stale value. Reading from the wall clock each tick means
       throttled timers self-correct rather than drift. */
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden && !submitted) {
            lastShown = null;
            tick();
        }
    });

    tick();
})();
