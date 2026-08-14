# ATI ZMATF Executive Training Assessment System

**Africa Transformational Initiative (ATI)**
*Zanzibar Multi-Agency Task Force (ZMATF) Executive Training Programme — Pre-Training Diagnostic Assessment*

A server-rendered assessment platform for 32 senior government officers. Twenty
questions, ten minutes, one attempt each — with per-officer option randomisation
so no two people see the same lettering.

---

## Documentation

| Document | Covers |
|---|---|
| **[VIEW_CONTRACT.md](VIEW_CONTRACT.md)** | What every route must supply to every view, the answer-key rules, and the application-layer notes |
| **[DEPLOYMENT.md](DEPLOYMENT.md)** | Neon, Render, seeding production, and the free-tier cold-start mitigation |
| **[DEVELOPER_HANDOFF.md](DEVELOPER_HANDOFF.md)** | Original technical handoff. Predates the PostgreSQL migration — see the note below |
| **[UI_HANDOFF.md](UI_HANDOFF.md)** | Original design system. Superseded by the current palette and typography |

> **On the two handoff documents:** both were written against the original
> SQLite build and the Warm Ivory palette. Their *contracts* still hold — the
> locked route and field names in §14, the position-independence rule in §5, and
> the directive not to alter official content in §6 — but their descriptions of
> the datastore, schema and visual system are out of date. Where they conflict
> with VIEW_CONTRACT.md, VIEW_CONTRACT.md is current.

---

## Stack

- **Node 20+ / Express 4**, EJS server-side rendering
- **PostgreSQL** — [Neon](https://neon.tech) in production, a container locally
- **Render** for hosting
- No client framework. The browser never talks to the database.

---

## Local setup

```bash
npm install
```

Start a local database:

```bash
npm run db:up
```

Copy the environment template and fill it in:

```bash
cp .env.example .env
```

Set `DATABASE_URL` to `postgresql://postgres:ati_dev_local@localhost:5433/ati_zmatf`,
generate a `SESSION_SECRET`, and choose an `ADMIN_USERNAME` / `ADMIN_PASSWORD`.

Apply the schema:

```bash
npm run migrate
```

Generate the assessment content from the official source documents:

```bash
npm run build:content
```

Seed the database:

```bash
npm run seed
```

Run the tests:

```bash
npm test
```

Start the server:

```bash
npm run dev
```

Then open `http://localhost:3000`.

---

## Content and credentials

The 20 questions, 80 options, the answer key and the officer roster are
**confidential and never committed**. `npm run build:content` derives
`database/content/*.json` from the source documents; both the sources and the
output are gitignored.

`npm run seed` issues fresh six-digit PINs from a CSPRNG, stores them as bcrypt
hashes, and writes the plaintext to `participant-credentials.txt` — the only
record of them, and also gitignored.

> **Every seed reissues every PIN.** That is the mechanism for a credential
> reissue. Use `--keep-pins` for a content-only reseed; `--force` is required if
> attempts already exist, and discards them.

Distribute each officer only their own row, through a private channel.

---

## The rules this system is built around

**The answer key never reaches the browser.** Question rendering uses
`getOptionsPublic()`, which cannot see correctness. The key-bearing accessor is
called in exactly two places: scoring, and the administrator audit view.

**Display letters are not answers.** Each attempt gets one of 24 permutations
per question, stored in `randomized_mappings`. Pressing "B" does not select
option B. Scoring resolves the display position back to an option id through
that stored row — never by recomputing the shuffle.

**The server owns time.** `public/js/timer.js` renders a countdown but decides
nothing. Every mutating route re-checks `deadline_at`, so a paused tab, a
disabled script or an altered system clock changes what a participant sees and
nothing else.

**Official content is verbatim.** The questions and options are reproduced
exactly as issued. Do not rewrite, paraphrase or re-order them.

---

## Tests

```bash
npm test
```

98 tests across three suites: the randomisation engine, the scoring engine, and
the security middleware. The permutation table is pinned deliberately —
`permutation_key` values stored against past attempts are interpreted through
it, so reordering it would silently re-score historical results.
