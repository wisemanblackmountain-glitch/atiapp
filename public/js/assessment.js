/**
 * ATI ZMATF — Answer selection and persistence
 *
 * Handles option selection on the question canvas and saves each choice to the
 * server as it is made.
 *
 * ── Position independence ───────────────────────────────────────────────────
 * `selectedPosition` is the DISPLAY position ('A'..'D') on this officer's
 * randomised option order. It is NOT the original source letter. The server
 * resolves it back to an option id through randomized_mappings and scores from
 * there. Never send, infer, or store option ids client-side.
 * See DEVELOPER_HANDOFF §5 and §14.4.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Endpoint (LOCKED, DEVELOPER_HANDOFF §14):
 *   POST /assessment/save-answer
 *   headers: Content-Type: application/json, X-CSRF-Token: <token>
 *   body:    { questionId, selectedPosition }
 *
 * Markup contract (views/assessment/questions.ejs):
 *   [role="radiogroup"]#option-group
 *   .option-btn[data-position][data-question-id][role="radio"][aria-checked]
 *   #save-status  role="status" aria-live="polite"
 */

(function () {
    'use strict';

    var group = document.getElementById('option-group');
    if (!group) return;

    var options = Array.prototype.slice.call(group.querySelectorAll('.option-btn'));
    if (!options.length) return;

    var status = document.getElementById('save-status');
    var meta = document.querySelector('meta[name="csrf-token"]');
    var csrfToken = meta ? meta.content : '';

    var inFlight = null;      // AbortController for the outstanding request
    var lastGood = null;      // position confirmed saved, for rollback

    options.forEach(function (btn) {
        if (btn.classList.contains('selected')) lastGood = btn.dataset.position;
    });

    function setStatus(message, tone) {
        if (!status) return;
        status.textContent = message;
        status.classList.remove('text-faint', 'form-error');
        status.classList.add(tone === 'error' ? 'form-error' : 'text-faint');
    }

    /**
     * Paint selection. Kept separate from persistence so a failed save can roll
     * the interface back to what the server actually holds.
     */
    function paint(position) {
        options.forEach(function (btn) {
            var on = btn.dataset.position === position;
            btn.classList.toggle('selected', on);
            btn.setAttribute('aria-checked', on ? 'true' : 'false');
            /* Roving tabindex: the radiogroup is one tab stop, arrows move
               within it. */
            btn.tabIndex = on ? 0 : -1;
        });
        if (!position) options[0].tabIndex = 0;

        /* Mirror into the navigator so progress updates without a reload. */
        var qNumber = group.dataset.questionNumber;
        if (qNumber) {
            var dot = document.querySelector('.progress-dot[data-number="' + qNumber + '"]');
            if (dot && position) dot.classList.add('is-answered');
        }
    }

    function save(position, questionId) {
        if (inFlight) inFlight.abort();
        inFlight = new AbortController();

        setStatus('Saving…');

        fetch('/assessment/save-answer', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken
            },
            body: JSON.stringify({
                questionId: questionId,
                selectedPosition: position
            }),
            credentials: 'same-origin',
            signal: inFlight.signal
        })
            .then(function (res) {
                /* The session or the attempt may have expired mid-answer. A
                   reload lands the participant on whatever screen the server
                   now considers correct, rather than leaving them clicking into
                   a void. */
                if (res.status === 401 || res.status === 403 || res.status === 409) {
                    setStatus('Your session has changed. Reloading…', 'error');
                    window.setTimeout(function () { window.location.reload(); }, 1200);
                    return null;
                }
                if (!res.ok) throw new Error('save failed: ' + res.status);
                return res;
            })
            .then(function (res) {
                if (!res) return;
                lastGood = position;
                setStatus('Answer saved.');
            })
            .catch(function (err) {
                if (err.name === 'AbortError') return;   // superseded by a newer choice
                paint(lastGood);                          // roll back to server truth
                setStatus('Could not save that answer. Check your connection and select it again.', 'error');
            })
            .finally(function () {
                inFlight = null;
            });
    }

    function choose(btn) {
        var position = btn.dataset.position;
        var questionId = btn.dataset.questionId || group.dataset.questionId;
        if (!position || !questionId) return;
        if (position === lastGood && btn.classList.contains('selected')) return;

        paint(position);   // optimistic: the press should feel instant
        save(position, questionId);
    }

    options.forEach(function (btn) {
        btn.addEventListener('click', function () { choose(btn); });
    });

    /* Arrow-key navigation, per the WAI-ARIA radiogroup pattern. Moving focus
       within a radiogroup also selects, which matches how the keyboard is
       expected to behave here. */
    group.addEventListener('keydown', function (e) {
        var index = options.indexOf(document.activeElement);
        if (index === -1) return;

        var next = null;
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = (index + 1) % options.length;
        else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = (index - 1 + options.length) % options.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = options.length - 1;
        else return;

        e.preventDefault();
        options[next].focus();
        choose(options[next]);
    });

    /* Establish the initial roving tabindex from the server-rendered state. */
    paint(lastGood);
})();
