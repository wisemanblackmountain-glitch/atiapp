-- ══════════════════════════════════════════════════════════════════════════
-- ATI ZMATF Executive Training Assessment — PostgreSQL schema
--
-- Target: Neon (managed Postgres) in production, a local container in dev.
--
-- Idempotent: safe to run on every boot. database/migrate.js applies it.
--
-- Contract-locked per DEVELOPER_HANDOFF §14.2: option ids (opt_qN_x),
-- participant numbers and question numbers are stable identifiers.
--
-- Constraints are declared rather than left to application code. The SQLite
-- build relied on convention for several of these; here the database refuses
-- bad writes outright, which matters for an official assessment record.
-- ══════════════════════════════════════════════════════════════════════════

-- ── Participants ─────────────────────────────────────────────────────────
-- pin_hash is bcrypt. Plaintext PINs exist only in the gitignored credentials
-- file produced at seed time; nothing can recover one from this table.
CREATE TABLE IF NOT EXISTS participants (
    participant_number  SMALLINT     PRIMARY KEY
                        CHECK (participant_number BETWEEN 1 AND 999),
    full_name           TEXT         NOT NULL CHECK (length(btrim(full_name)) > 0),
    title               TEXT         NOT NULL DEFAULT '',
    agency              TEXT         NOT NULL DEFAULT '',
    last_name           TEXT         NOT NULL CHECK (length(btrim(last_name)) > 0),
    pin_hash            TEXT         NOT NULL,
    is_active           BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Surname lookups are case-insensitive at sign-in.
CREATE INDEX IF NOT EXISTS idx_participants_last_name
    ON participants (lower(last_name));

CREATE TABLE IF NOT EXISTS admin_users (
    username       TEXT        PRIMARY KEY CHECK (length(btrim(username)) > 0),
    password_hash  TEXT        NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Assessment content ───────────────────────────────────────────────────
-- Official ATI content, loaded by database/seed.js from gitignored source
-- files. Never edit question_text or option_text (DEVELOPER_HANDOFF §6).
CREATE TABLE IF NOT EXISTS questions (
    question_number  SMALLINT PRIMARY KEY CHECK (question_number BETWEEN 1 AND 20),
    section_label    CHAR(1)  NOT NULL CHECK (section_label IN ('A', 'B')),
    question_text    TEXT     NOT NULL CHECK (length(btrim(question_text)) > 0),
    marks            SMALLINT NOT NULL DEFAULT 1 CHECK (marks > 0)
);

CREATE TABLE IF NOT EXISTS options (
    option_id          TEXT     PRIMARY KEY,          -- opt_q1_a .. opt_q20_d
    question_number    SMALLINT NOT NULL
                       REFERENCES questions(question_number) ON DELETE CASCADE,
    original_position  CHAR(1)  NOT NULL CHECK (original_position IN ('A','B','C','D')),
    option_text        TEXT     NOT NULL CHECK (length(btrim(option_text)) > 0),
    is_correct         BOOLEAN  NOT NULL DEFAULT FALSE,
    UNIQUE (question_number, original_position)
);

CREATE INDEX IF NOT EXISTS idx_options_question ON options (question_number);

-- Exactly one correct option per question. A partial unique index enforces
-- this in the database rather than trusting the seeder to get it right.
CREATE UNIQUE INDEX IF NOT EXISTS uq_options_one_correct
    ON options (question_number) WHERE is_correct;

-- ── Attempts ─────────────────────────────────────────────────────────────
-- One attempt per officer, enforced by the primary key.
CREATE TABLE IF NOT EXISTS assessment_attempts (
    participant_number       SMALLINT PRIMARY KEY
                             REFERENCES participants(participant_number) ON DELETE CASCADE,
    status                   TEXT        NOT NULL DEFAULT 'IN_PROGRESS'
                             CHECK (status IN ('IN_PROGRESS','COMPLETED','TIMED_OUT')),
    started_at               TIMESTAMPTZ NOT NULL,
    submitted_at             TIMESTAMPTZ,
    deadline_at              TIMESTAMPTZ NOT NULL,
    score                    SMALLINT    CHECK (score IS NULL OR score >= 0),
    total_marks              SMALLINT    NOT NULL DEFAULT 20,
    percentage               SMALLINT    CHECK (percentage IS NULL OR percentage BETWEEN 0 AND 100),
    knowledge_level          TEXT        CHECK (knowledge_level IS NULL OR knowledge_level IN
                                 ('ADVANCED','COMPETENT','DEVELOPING','FOUNDATIONAL')),
    knowledge_interpretation TEXT,

    -- The deadline must follow the start, and a finished attempt must carry a
    -- score. Both were only conventions in the SQLite build.
    CONSTRAINT deadline_after_start CHECK (deadline_at > started_at),
    CONSTRAINT finished_has_score CHECK (
        status = 'IN_PROGRESS' OR (score IS NOT NULL AND submitted_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_attempts_status ON assessment_attempts (status);

-- ── Per-attempt option randomisation ─────────────────────────────────────
-- The heart of position independence. Each attempt gets one of 24 permutations
-- per question. The letter a participant sees is a DISPLAY position and does
-- not correspond to the source letter.
-- DEVELOPER_HANDOFF §5 — this resolution logic must not be altered.
CREATE TABLE IF NOT EXISTS randomized_mappings (
    participant_number  SMALLINT NOT NULL
                        REFERENCES assessment_attempts(participant_number) ON DELETE CASCADE,
    question_number     SMALLINT NOT NULL
                        REFERENCES questions(question_number) ON DELETE CASCADE,
    permutation_key     SMALLINT NOT NULL CHECK (permutation_key BETWEEN 0 AND 23),
    display_a_option_id TEXT NOT NULL REFERENCES options(option_id),
    display_b_option_id TEXT NOT NULL REFERENCES options(option_id),
    display_c_option_id TEXT NOT NULL REFERENCES options(option_id),
    display_d_option_id TEXT NOT NULL REFERENCES options(option_id),
    PRIMARY KEY (participant_number, question_number),

    -- All four display slots must show different options. A permutation that
    -- repeated one would silently make a question unanswerable correctly.
    CONSTRAINT distinct_display_options CHECK (
        display_a_option_id <> display_b_option_id AND
        display_a_option_id <> display_c_option_id AND
        display_a_option_id <> display_d_option_id AND
        display_b_option_id <> display_c_option_id AND
        display_b_option_id <> display_d_option_id AND
        display_c_option_id <> display_d_option_id
    )
);

-- ── Responses ────────────────────────────────────────────────────────────
-- selected_option_id is resolved server-side from the display position via
-- randomized_mappings. is_correct stays NULL until submission.
CREATE TABLE IF NOT EXISTS responses (
    participant_number        SMALLINT NOT NULL
                              REFERENCES assessment_attempts(participant_number) ON DELETE CASCADE,
    question_number           SMALLINT NOT NULL
                              REFERENCES questions(question_number) ON DELETE CASCADE,
    selected_option_id        TEXT REFERENCES options(option_id),
    selected_display_position CHAR(1) CHECK (
                                  selected_display_position IS NULL OR
                                  selected_display_position IN ('A','B','C','D')),
    is_correct                BOOLEAN,
    saved_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (participant_number, question_number),

    -- A recorded position implies a resolved option, and vice versa.
    CONSTRAINT position_implies_option CHECK (
        (selected_display_position IS NULL) = (selected_option_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_responses_question ON responses (question_number);

-- ── Sessions ─────────────────────────────────────────────────────────────
-- express-session storage. Kept here rather than in memory so sessions survive
-- Render restarts and the free tier's 15-minute spin-down.
CREATE TABLE IF NOT EXISTS sessions (
    sid        TEXT        PRIMARY KEY,
    payload    JSONB       NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- ── Administrator audit ──────────────────────────────────────────────────
-- Records destructive facilitator actions: clearing an attempt so an officer
-- can retake, and reissuing a PIN.
--
-- Deliberately carries NO foreign keys. An audit row must outlive whatever it
-- describes — if a participant row were ever removed, a cascade would erase the
-- evidence of what was done to them, which is precisely backwards for an audit
-- trail on an official record.
--
-- Append-only by convention: the application never updates or deletes here.
CREATE TABLE IF NOT EXISTS admin_audit (
    id                 BIGSERIAL   PRIMARY KEY,
    occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    admin_username     TEXT        NOT NULL,
    action             TEXT        NOT NULL
                       CHECK (action IN ('RETAKE_ALLOWED', 'PIN_REISSUED')),
    participant_number SMALLINT,
    -- What was discarded, so "who let officer 12 retake, and what score did
    -- they lose?" is answerable months later.
    detail             JSONB       NOT NULL DEFAULT '{}'::jsonb,
    ip_address         TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_occurred ON admin_audit (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_participant ON admin_audit (participant_number);

-- ── Metadata ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
