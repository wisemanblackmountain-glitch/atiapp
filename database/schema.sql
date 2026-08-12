-- ══════════════════════════════════════════════════════════════════════════
-- ATI ZMATF Executive Training Assessment — schema
--
-- Engine: SQLite via sql.js (WASM). The database is held in memory and
-- serialised to database/ati-assessment.db by src/utils/db.js.
--
-- Schema follows DEVELOPER_HANDOFF §4. Option ids (opt_qN_x), participant ids
-- and question ids are contract-locked per §14.2 and must not be renamed.
-- ══════════════════════════════════════════════════════════════════════════

PRAGMA foreign_keys = ON;

-- ── Participants ─────────────────────────────────────────────────────────
-- access_pin is the 6-digit code issued to each officer. It is stored as
-- issued, per the documented schema.
--
-- SECURITY: the .db file and the generated credentials file are both
-- gitignored and must stay that way. Hashing the PIN would be a sensible
-- hardening step but changes the documented schema, so it is flagged in
-- VIEW_CONTRACT.md rather than applied unilaterally.
CREATE TABLE IF NOT EXISTS participants (
    id                 INTEGER PRIMARY KEY,
    participant_number INTEGER NOT NULL UNIQUE,
    full_name          TEXT    NOT NULL,
    title              TEXT    NOT NULL DEFAULT '',
    agency             TEXT    NOT NULL DEFAULT '',
    last_name          TEXT    NOT NULL,
    access_pin         TEXT    NOT NULL,
    is_active          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS admin_users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
);

-- ── Assessment content ───────────────────────────────────────────────────
-- Official ATI content. Loaded by database/seed.js from gitignored source
-- files. Never edit question_text or option_text (DEVELOPER_HANDOFF §6).
CREATE TABLE IF NOT EXISTS questions (
    id              INTEGER PRIMARY KEY,
    question_number INTEGER NOT NULL UNIQUE,
    section_label   TEXT    NOT NULL,
    question_text   TEXT    NOT NULL,
    marks           INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS options (
    id                TEXT    PRIMARY KEY,          -- opt_q1_a .. opt_q20_d
    question_id       INTEGER NOT NULL REFERENCES questions(id),
    original_position TEXT    NOT NULL,             -- source letter A–D
    option_text       TEXT    NOT NULL,
    is_correct        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_options_question ON options(question_id);

-- ── Attempts ─────────────────────────────────────────────────────────────
-- One attempt per participant, enforced by the UNIQUE constraint.
CREATE TABLE IF NOT EXISTS assessment_attempts (
    id                       INTEGER PRIMARY KEY,
    participant_id           INTEGER NOT NULL UNIQUE REFERENCES participants(id),
    status                   TEXT    NOT NULL DEFAULT 'IN_PROGRESS',
    started_at               TEXT    NOT NULL,
    submitted_at             TEXT,
    deadline_at              TEXT    NOT NULL,
    score                    INTEGER,
    total_marks              INTEGER NOT NULL DEFAULT 20,
    percentage               INTEGER,
    knowledge_level          TEXT,
    knowledge_interpretation TEXT
);

CREATE INDEX IF NOT EXISTS idx_attempts_status ON assessment_attempts(status);

-- ── Per-attempt option randomisation ─────────────────────────────────────
-- The heart of position independence. Each attempt receives one of 24
-- permutations per question. The letter a participant sees is a DISPLAY
-- position and does not correspond to the source letter.
-- DEVELOPER_HANDOFF §5 — this resolution logic must not be altered.
CREATE TABLE IF NOT EXISTS randomized_mappings (
    id                          INTEGER PRIMARY KEY,
    attempt_id                  INTEGER NOT NULL REFERENCES assessment_attempts(id),
    question_id                 INTEGER NOT NULL REFERENCES questions(id),
    permutation_key             INTEGER NOT NULL,   -- 0..23
    display_position_a_option_id TEXT NOT NULL REFERENCES options(id),
    display_position_b_option_id TEXT NOT NULL REFERENCES options(id),
    display_position_c_option_id TEXT NOT NULL REFERENCES options(id),
    display_position_d_option_id TEXT NOT NULL REFERENCES options(id),
    UNIQUE (attempt_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_mappings_attempt ON randomized_mappings(attempt_id);

-- ── Responses ────────────────────────────────────────────────────────────
-- selected_option_id is resolved server-side from the display position via
-- randomized_mappings. is_correct is NULL while unanswered and is only
-- written at submission.
CREATE TABLE IF NOT EXISTS responses (
    id                       INTEGER PRIMARY KEY,
    attempt_id               INTEGER NOT NULL REFERENCES assessment_attempts(id),
    question_id              INTEGER NOT NULL REFERENCES questions(id),
    selected_option_id       TEXT REFERENCES options(id),
    selected_display_position TEXT,
    is_correct               INTEGER,
    saved_at                 TEXT NOT NULL,
    UNIQUE (attempt_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_responses_attempt ON responses(attempt_id);
