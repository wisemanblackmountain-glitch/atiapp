# View Contract

**What every EJS view expects from its route.**
*ATI ZMATF Executive Training Assessment — branch `design/glassmorphism-premium-v1`*

---

## Why this document exists

The views were built before `src/routes/` existed. This is therefore a
**specification the routes must satisfy**, not a description of existing code.
Every local named here is consumed by a template; supplying a different name or
shape will produce a blank region or a render error.

Each view also carries this contract in a comment block at the top of its own
file. This document is the index.

**Endpoints and field names marked `[LOCKED]` are fixed by DEVELOPER_HANDOFF §14
and must not be renamed.** Everything else was defined here and may be changed,
provided the views are updated to match.

---

## 1. Globals available to every view

Supplied by middleware already registered in `server.js`:

| Local | Source | Notes |
|---|---|---|
| `csrfToken` | `addCsrfToLocals` | Every form needs `<input type="hidden" name="_csrf">`. AJAX reads it from `<meta name="csrf-token">`. |
| `user` | `addUserToLocals` | Session participant or admin, or falsy when signed out. |

Optional on any render:

| Local | Type | Effect |
|---|---|---|
| `title` | String | `<title>` text. |
| `error` | String | Renders a danger alert above the view body. |
| `success` | String | Renders a success alert above the view body. |
| `nav` | String | `'none'` \| `'assessment'` \| `'admin'`. Omit for the default bar. |
| `navTitle` | String | Text beside the seal. |
| `navCounter` | String | Assessment nav only, e.g. `'Q 07 / 20'`. |
| `navDeadline` | String | ISO timestamp. Becomes `data-deadline` on the timer. |
| `scripts` | Array | Paths appended as deferred `<script>`. Nothing loads globally. |

---

## 2. Answer key privacy — non-negotiable

Views under `views/assessment/` are participant-facing. They must **never**
receive `is_correct`, `correct_option_text`, `original_position`, or option IDs
(`opt_q7_c`). The scoring engine resolves display position back to option ID
server-side.

`views/admin/result-detail.ejs` is the **only** view in the application that
renders answer keys. It must only ever be reached through an admin-guarded
route, and its audit table must not be extracted into a shared partial.
Duplication is the correct trade.

A regression check for this is described in §6.

---

## 3. Participant flow

### `landing.ejs` → `GET /`
No locals beyond `title`. Already wired in `server.js`.

### `auth/login.ejs` → `GET /login`, `POST /login` `[LOCKED]`

```js
{ title, nav: 'none',
  values:      { participantNumber, lastName },  // optional, repopulates after failure
  lockedUntil: '09:47'                           // optional, rate limiter tripped
}
```

POST fields: **`participantNumber`, `lastName`, `accessPin`** `[LOCKED]`.
`accessPin` is never echoed back into `values`.

### `auth/admin-login.ejs` → `GET /admin/login`, `POST /admin/login` `[LOCKED]`

```js
{ title, nav: 'none', lockedUntil }
```

POST fields: **`username`, `password`** `[LOCKED]`.

### `assessment/confirm.ejs` → `GET /assessment/confirm`

```js
{ title, participant: { participant_number, full_name, title, agency } }
```

No attempt is created here. Continues via a link to `/assessment/instructions`.

### `assessment/instructions.ejs` → `GET /assessment/instructions`

```js
{ title,
  participant: { full_name, participant_number },
  resuming: false        // true when an IN_PROGRESS attempt already exists
}
```

Submits to **`POST /assessment/start`** *(defined here, not locked)*, which
creates the attempt, stamps `started_at` and `deadline_at` (+10 min), assigns the
20 permutations, and redirects to `/assessment/questions/1`.

> When `resuming` is true, `POST /assessment/start` **must not reset
> `deadline_at`.** Resetting it would hand a second full ten minutes to anyone
> who revisits the briefing screen.

### `assessment/questions.ejs` → `GET /assessment/questions/:number`

```js
{ title, nav: 'assessment', navCounter, navDeadline,
  scripts: ['/js/timer.js', '/js/assessment.js'],

  question: { id, question_number, section_label, question_text },

  choices: [                       // DISPLAY order, already randomised
    { position: 'A', text: '...' },
    { position: 'B', text: '...' },
    { position: 'C', text: '...' },
    { position: 'D', text: '...' }
  ],

  selectedPosition: 'B' | null,

  progress: { answered: 6, total: 20,
              items: [ { number: 1, answered: true }, ... ] },   // all 20

  prevNumber: 6 | null,            // null on question 1
  nextNumber: 8 | null             // null on question 20
}
```

`choices[].position` is a **display** position, not the original source letter.
`choices` carries **only** `position` and `text`.

Saves via **`POST /assessment/save-answer`** `[LOCKED]`, JSON body
`{ questionId, selectedPosition }`, header `X-CSRF-Token`.

### `assessment/review.ejs` → `GET /assessment/review`

```js
{ title, nav: 'assessment', navDeadline, scripts: ['/js/timer.js'],
  stats: { total: 20, answered: 18, unanswered: 2 },
  items: [ { number: 1, section_label: 'A', answered: true }, ... ],  // all 20
  deadline: '2026-08-12T09:24:02.000Z'
}
```

Submits to **`POST /assessment/submit`** `[LOCKED]`. The modal is a plain form,
so submission still works with JavaScript disabled.

### `assessment/results.ejs` → `GET /assessment/results`

```js
{ title,
  participant: { participant_number, full_name, title, agency },
  attempt: { score, total_marks, percentage,
             knowledge_level,            // ADVANCED | COMPETENT | DEVELOPING | FOUNDATIONAL
             knowledge_interpretation,
             status,                     // COMPLETED | TIMED_OUT
             submitted_at }              // may be null
}
```

Score, percentage and level only. No per-question data.

---

## 4. Administrator flow

### `admin/dashboard.ejs` → `GET /admin/dashboard`

```js
{ title, nav: 'admin', navTitle: 'Administration',
  metrics: { roster, completed, in_progress, not_started,
             mean_score,        // Number to 1dp, or null when no attempts
             mean_percentage },
  distribution: [               // always all four levels, in this order
    { level: 'ADVANCED',     count, percent },
    { level: 'COMPETENT',    count, percent },
    { level: 'DEVELOPING',   count, percent },
    { level: 'FOUNDATIONAL', count, percent }
  ]
}
```

Renders an empty state when `metrics.completed === 0`.

### `admin/participants.ejs` → `GET /admin/participants?q=&status=`

```js
{ title, nav: 'admin',
  participants: [ { participant_number, full_name, title, agency,
                    status,          // NOT_STARTED | IN_PROGRESS | COMPLETED | TIMED_OUT
                    score, total_marks, percentage, knowledge_level } ],
  filters: { q: '', status: '' },   // echoed back into the controls
  total: 32                          // roster size before filtering
}
```

Score fields are `null` unless status is `COMPLETED` or `TIMED_OUT`. Filtering is
server-side so results stay linkable. Links to `/admin/results/:participantNumber`.

### `admin/result-detail.ejs` → `GET /admin/results/:participantNumber`

⚠️ **Renders the answer key. Admin-guarded routes only.**

```js
{ title, nav: 'admin', participant, attempt,
  responses: [ { question_number, section_label, question_text,
                 selected_display_position,   // 'A'..'D' or null
                 selected_option_text,        // null when unanswered
                 correct_option_text,
                 is_correct } ]               // null when unanswered
}
```

`attempt` additionally needs `started_at`.

### `admin/analytics.ejs` → `GET /admin/analytics`

```js
{ title, nav: 'admin',
  summary: { attempts, mean_score, median_score, highest, lowest },
  histogram: [ { score: 0, count: 0 }, ... ],   // all 21 buckets, ascending
  items: [ { question_number, section_label, question_text,
             correct_count, attempted_count, difficulty_percent } ]
}
```

Aggregate only — no officer is identifiable, and correct option text is not
shown. Export link points at `GET /admin/analytics/export.csv`.

---

## 5. Endpoints this contract introduces

Not in DEVELOPER_HANDOFF §14, defined here:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/assessment/start` | Create attempt, stamp deadline, assign permutations |
| `GET` | `/assessment/confirm` | Identity confirmation |
| `GET` | `/assessment/instructions` | Briefing |
| `GET` | `/assessment/questions/:number` | Question canvas, 1–20 |
| `GET` | `/assessment/review` | Review grid |
| `GET` | `/assessment/results` | Participant result |
| `POST` | `/logout` | Sign out, CSRF-protected |
| `GET` | `/admin/dashboard` | Cohort status |
| `GET` | `/admin/participants` | Roster, `?q=` `&status=` |
| `GET` | `/admin/results/:participantNumber` | Officer report |
| `GET` | `/admin/analytics` | Distribution and item difficulty |
| `GET` | `/admin/analytics/export.csv` | CSV dataset |

---

## 6. Still outstanding

Two client scripts are referenced but not yet written:

- **`public/js/timer.js`** — reads `data-deadline` from `#assessment-timer`,
  renders the countdown, adds `.is-low` at two minutes, and triggers
  auto-submission at zero. The server stays authoritative on expiry; the client
  is display only.
- **`public/js/assessment.js`** — click handling on `.option-btn`, POSTs
  `{ questionId, selectedPosition }` to `/assessment/save-answer` with the
  `X-CSRF-Token` header, updates `aria-checked` and `#save-status`.

Font files are also outstanding — see the comment block in
`views/layouts/main.ejs`.

### Regression check worth keeping

All 14 views render green through a harness that asserts no participant-facing
render contains `is_correct`, `correct_option`, `answer_key`, `original_position`,
or an `opt_qN_x` identifier. That assertion is worth porting into
`tests/security.test.js` so the guarantee is enforced in CI rather than by
convention.
