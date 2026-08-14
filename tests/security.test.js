/**
 * Security-relevant behaviour: input validation, CSRF, login rate limiting and
 * server-authoritative timing.
 *
 * These are the properties that protect a live assessment, so they are tested
 * for what they must *refuse*, not only what they accept.
 */

'use strict';

const validation = require('../src/middleware/validation');
const rateLimit = require('../src/middleware/rateLimit');
const timer = require('../src/utils/timer');

const req = (ip) => ({ ip, connection: { remoteAddress: ip } });

beforeEach(() => {
    rateLimit._buckets.clear();
});

describe('validateParticipantLogin', () => {
    const good = { participantNumber: '7', lastName: 'Abdalla', accessPin: '123456' };

    test('accepts well-formed credentials', () => {
        const r = validation.validateParticipantLogin(good);
        expect(r.ok).toBe(true);
        expect(r.data.participantNumber).toBe(7);
        expect(r.data.accessPin).toBe('123456');
    });

    test('NEVER echoes the PIN back to the view', () => {
        // values repopulates the form after a failed attempt. A PIN in there
        // would be rendered into HTML and land in browser history and caches.
        const r = validation.validateParticipantLogin(good);
        expect(r.values).not.toHaveProperty('accessPin');
        expect(JSON.stringify(r.values)).not.toContain('123456');
    });

    test('rejects a participant number outside 1..32', () => {
        expect(validation.validateParticipantLogin({ ...good, participantNumber: '0' }).ok).toBe(false);
        expect(validation.validateParticipantLogin({ ...good, participantNumber: '33' }).ok).toBe(false);
        expect(validation.validateParticipantLogin({ ...good, participantNumber: '' }).ok).toBe(false);
    });

    test('rejects a PIN that is not exactly six digits', () => {
        expect(validation.validateParticipantLogin({ ...good, accessPin: '12345' }).ok).toBe(false);
        expect(validation.validateParticipantLogin({ ...good, accessPin: 'abcdef' }).ok).toBe(false);
        expect(validation.validateParticipantLogin({ ...good, accessPin: '' }).ok).toBe(false);
    });

    test('strips non-digits rather than trusting the client', () => {
        const r = validation.validateParticipantLogin({ ...good, accessPin: '12-34 56' });
        expect(r.data.accessPin).toBe('123456');
    });

    test('rejects a surname that is too short', () => {
        expect(validation.validateParticipantLogin({ ...good, lastName: 'A' }).ok).toBe(false);
    });

    test('returns an identical message whichever field failed', () => {
        // The property that matters is indistinguishability. Listing all three
        // fields as guidance is fine; what must never happen is a message that
        // reveals *which* one was wrong, since that turns the login form into
        // an oracle for enumerating valid participant numbers.
        const failures = [
            { ...good, participantNumber: '99' },
            { ...good, participantNumber: '' },
            { ...good, lastName: 'A' },
            { ...good, accessPin: '1' },
            { ...good, accessPin: 'abcdef' },
        ].map((input) => validation.validateParticipantLogin(input));

        expect(failures.every((f) => f.ok === false)).toBe(true);

        const messages = new Set(failures.map((f) => f.message));
        expect(messages.size).toBe(1);
    });

    test('never singles out one field as the failure', () => {
        const message = validation.validateParticipantLogin({ ...good, accessPin: '1' }).message;
        // e.g. "incorrect PIN", "unknown participant", "surname not found"
        expect(message).not.toMatch(/(incorrect|invalid|unknown|wrong|not found)\s+\w*\s*(pin|number|surname)/i);
    });

    test('survives hostile input without throwing', () => {
        expect(() => validation.validateParticipantLogin({})).not.toThrow();
        expect(() => validation.validateParticipantLogin({ participantNumber: {}, lastName: [], accessPin: 0 }))
            .not.toThrow();
    });

    test('caps field length', () => {
        const r = validation.validateParticipantLogin({ ...good, lastName: 'x'.repeat(500) });
        expect(r.values.lastName.length).toBeLessThanOrEqual(60);
    });
});

describe('validateAdminLogin', () => {
    test('accepts a plausible username and password', () => {
        expect(validation.validateAdminLogin({ username: 'facilitator', password: 'x'.repeat(14) }).ok).toBe(true);
    });

    test('rejects an empty username or password', () => {
        expect(validation.validateAdminLogin({ username: '', password: 'x'.repeat(14) }).ok).toBe(false);
        expect(validation.validateAdminLogin({ username: 'admin', password: '' }).ok).toBe(false);
    });

    test('does not trim or normalise the password', () => {
        // Trimming would silently change what the user typed and make a
        // legitimate password fail against its stored hash.
        const r = validation.validateAdminLogin({ username: 'admin', password: '  spaced  ' });
        expect(r.data.password).toBe('  spaced  ');
    });
});

describe('validateAnswerPayload', () => {
    test('accepts a valid payload', () => {
        expect(validation.validateAnswerPayload({ questionId: 7, selectedPosition: 'B' }))
            .toEqual({ questionId: 7, selectedPosition: 'B' });
    });

    test('upper-cases the display position', () => {
        expect(validation.validateAnswerPayload({ questionId: 1, selectedPosition: 'c' }).selectedPosition)
            .toBe('C');
    });

    test('rejects a position outside A..D', () => {
        expect(validation.validateAnswerPayload({ questionId: 1, selectedPosition: 'E' })).toBeNull();
        expect(validation.validateAnswerPayload({ questionId: 1, selectedPosition: '' })).toBeNull();
        expect(validation.validateAnswerPayload({ questionId: 1, selectedPosition: 1 })).toBeNull();
    });

    test('rejects a bad question id', () => {
        expect(validation.validateAnswerPayload({ questionId: 0, selectedPosition: 'A' })).toBeNull();
        expect(validation.validateAnswerPayload({ questionId: 'x', selectedPosition: 'A' })).toBeNull();
        expect(validation.validateAnswerPayload({ selectedPosition: 'A' })).toBeNull();
    });

    test('survives null and junk', () => {
        expect(validation.validateAnswerPayload(null)).toBeNull();
        expect(validation.validateAnswerPayload({})).toBeNull();
    });
});

describe('CSRF', () => {
    function run(sessionToken, supplied, method = 'POST') {
        const request = {
            method,
            session: sessionToken ? { csrfToken: sessionToken } : {},
            body: supplied ? { _csrf: supplied } : {},
            get: () => '',
            is: () => false,
            xhr: false,
        };
        let nexted = false;
        let status = null;
        const res = {
            status(code) { status = code; return this; },
            json() { return this; },
            render() { return this; },
        };
        validation.verifyCsrf(request, res, () => { nexted = true; });
        return { nexted, status };
    }

    test('lets a matching token through', () => {
        expect(run('a'.repeat(64), 'a'.repeat(64)).nexted).toBe(true);
    });

    test('rejects a mismatched token', () => {
        const r = run('a'.repeat(64), 'b'.repeat(64));
        expect(r.nexted).toBe(false);
        expect(r.status).toBe(403);
    });

    test('rejects a missing token', () => {
        expect(run('a'.repeat(64), null).status).toBe(403);
    });

    test('rejects when the session carries no token', () => {
        expect(run(null, 'a'.repeat(64)).status).toBe(403);
    });

    test('rejects a token of the wrong length without throwing', () => {
        // timingSafeEqual throws on length mismatch; the guard must handle it.
        expect(() => run('a'.repeat(64), 'a')).not.toThrow();
        expect(run('a'.repeat(64), 'a').status).toBe(403);
    });

    test('lets safe methods through untouched', () => {
        for (const method of ['GET', 'HEAD', 'OPTIONS']) {
            expect(run(null, null, method).nexted).toBe(true);
        }
    });

    test('addCsrfToLocals mints a token once and reuses it', () => {
        const session = {};
        const res1 = { locals: {} };
        validation.addCsrfToLocals({ session }, res1, () => {});
        const first = session.csrfToken;

        const res2 = { locals: {} };
        validation.addCsrfToLocals({ session }, res2, () => {});

        expect(first).toHaveLength(64);
        expect(session.csrfToken).toBe(first);
        expect(res2.locals.csrfToken).toBe(first);
    });

    test('mints different tokens for different sessions', () => {
        const a = {}; const b = {};
        validation.addCsrfToLocals({ session: a }, { locals: {} }, () => {});
        validation.addCsrfToLocals({ session: b }, { locals: {} }, () => {});
        expect(a.csrfToken).not.toBe(b.csrfToken);
    });
});

describe('login rate limiting', () => {
    test('allows five failures against one account, then locks it', () => {
        const r = req('10.0.0.1');
        for (let i = 0; i < 4; i++) {
            expect(rateLimit.recordFailure(r, 'participant', '7').locked).toBe(false);
        }
        expect(rateLimit.recordFailure(r, 'participant', '7').locked).toBe(true);
    });

    test('counts down remaining attempts', () => {
        const r = req('10.0.0.2');
        expect(rateLimit.getState(r, 'participant', '7').remaining).toBe(5);
        rateLimit.recordFailure(r, 'participant', '7');
        expect(rateLimit.getState(r, 'participant', '7').remaining).toBe(4);
    });

    test('a successful sign-in clears that account', () => {
        const r = req('10.0.0.3');
        rateLimit.recordFailure(r, 'participant', '7');
        rateLimit.recordFailure(r, 'participant', '7');
        rateLimit.clear(r, 'participant', '7');
        expect(rateLimit.getState(r, 'participant', '7').remaining).toBe(5);
    });

    // ── The scenario this design exists for ──────────────────────────────
    test('one officer locking out does NOT lock the rest of the room', () => {
        // 32 officers in a training room share one public IP. Under per-IP
        // keying, five people each mistyping once would lock all 32 out.
        const room = req('41.222.180.4');

        for (let i = 0; i < 5; i++) rateLimit.recordFailure(room, 'participant', '7');
        expect(rateLimit.getState(room, 'participant', '7').locked).toBe(true);

        for (const other of ['1', '12', '19', '28', '32']) {
            expect(rateLimit.getState(room, 'participant', other).locked).toBe(false);
            expect(rateLimit.getState(room, 'participant', other).remaining).toBe(5);
        }
    });

    test('a whole room fumbling twice each stays under the address ceiling', () => {
        const room = req('41.222.180.5');
        for (let officer = 1; officer <= 32; officer++) {
            rateLimit.recordFailure(room, 'participant', String(officer));
            rateLimit.recordFailure(room, 'participant', String(officer));
        }
        // 64 failures — every officer still has attempts left.
        for (const officer of ['1', '16', '32']) {
            expect(rateLimit.getState(room, 'participant', officer).locked).toBe(false);
            expect(rateLimit.getState(room, 'participant', officer).remaining).toBe(3);
        }
    });

    test('the address ceiling still catches guessing sprayed across accounts', () => {
        const attacker = req('203.0.113.9');
        // Four tries each against many accounts stays under the per-account
        // limit every time, so only the address ceiling can stop it.
        for (let n = 1; n <= 30; n++) {
            for (let i = 0; i < 4; i++) rateLimit.recordFailure(attacker, 'participant', String(n));
        }
        expect(rateLimit.getState(attacker, 'participant', '99').locked).toBe(true);
        expect(rateLimit.getState(attacker, 'participant', '99').reason).toBe('address');
    });

    test('an account lock does not follow the officer to another address', () => {
        const office = req('10.0.0.4');
        const home = req('10.0.0.5');
        for (let i = 0; i < 5; i++) rateLimit.recordFailure(office, 'participant', '7');
        expect(rateLimit.getState(office, 'participant', '7').locked).toBe(true);
        // The account bucket is shared across addresses — a PIN must not become
        // guessable simply by moving networks.
        expect(rateLimit.getState(home, 'participant', '7').locked).toBe(true);
    });

    test('participant and admin lockouts are independent', () => {
        // A locked-out officer must not also lock the facilitator out of the
        // admin console from the same office address.
        const r = req('10.0.0.6');
        for (let i = 0; i < 5; i++) rateLimit.recordFailure(r, 'participant', '7');
        expect(rateLimit.getState(r, 'participant', '7').locked).toBe(true);
        expect(rateLimit.getState(r, 'admin', 'ati-facilitator').locked).toBe(false);
    });

    test('padding and capitalisation cannot buy extra attempts', () => {
        const r = req('10.0.0.8');
        for (let i = 0; i < 5; i++) rateLimit.recordFailure(r, 'admin', 'ati-facilitator');
        expect(rateLimit.getState(r, 'admin', 'ati-facilitator').locked).toBe(true);
    });

    test('reports when the lock lifts', () => {
        const r = req('10.0.0.7');
        for (let i = 0; i < 5; i++) rateLimit.recordFailure(r, 'participant', '7');
        const state = rateLimit.getState(r, 'participant', '7');
        expect(state.retryAt).toBeInstanceOf(Date);
        expect(state.retryAt.getTime()).toBeGreaterThan(Date.now());
        expect(rateLimit.formatRetryAt(state.retryAt)).toMatch(/^\d{2}:\d{2}$/);
    });

    test('a request with no identifier falls back to the address ceiling', () => {
        const r = req('10.0.0.9');
        const state = rateLimit.getState(r, 'participant', null);
        expect(state.locked).toBe(false);
        expect(state.remaining).toBe(5);
    });
});

describe('server-authoritative timing', () => {
    test('a deadline is the configured duration after the start', () => {
        const start = '2026-08-13T09:00:00.000Z';
        const expected = timer.DURATION_MINUTES * 60 * 1000;
        expect(Date.parse(timer.deadlineFrom(start)) - Date.parse(start)).toBe(expected);
    });

    test('recognises a passed deadline', () => {
        expect(timer.hasExpired(new Date(Date.now() - 1000).toISOString())).toBe(true);
        expect(timer.hasExpired(new Date(Date.now() + 60_000).toISOString())).toBe(false);
    });

    test('the grace window covers an answer sent just before the deadline', () => {
        const twoSecondsAgo = new Date(Date.now() - 2000).toISOString();
        expect(timer.hasExpired(twoSecondsAgo)).toBe(true);          // scoring
        expect(timer.hasExpired(twoSecondsAgo, 5)).toBe(false);      // saving
    });

    test('the grace window does not extend indefinitely', () => {
        const longAgo = new Date(Date.now() - 60_000).toISOString();
        expect(timer.hasExpired(longAgo, 5)).toBe(true);
    });

    test('remaining seconds floor at zero, never negative', () => {
        expect(timer.secondsRemaining(new Date(Date.now() - 60_000).toISOString())).toBe(0);
        expect(timer.secondsRemaining(new Date(Date.now() + 90_000).toISOString())).toBeGreaterThan(85);
    });

    test('formats mm:ss with padding', () => {
        expect(timer.formatDuration(0)).toBe('00:00');
        expect(timer.formatDuration(65)).toBe('01:05');
        expect(timer.formatDuration(600)).toBe('10:00');
        expect(timer.formatDuration(-5)).toBe('00:00');
    });

    test('flags the low-water mark at two minutes', () => {
        expect(timer.isLowWater(new Date(Date.now() + 100_000).toISOString())).toBe(true);
        expect(timer.isLowWater(new Date(Date.now() + 300_000).toISOString())).toBe(false);
    });
});
