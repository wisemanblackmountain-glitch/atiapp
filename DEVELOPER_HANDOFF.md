# ATI ZMATF Assessment System — Developer Handoff

**Primary Technical Documentation & Transition Guide**  
*Africa Transformational Initiative (ATI) — Zanzibar Multi-Agency Task Force (ZMATF) Executive Training Programme*  
*Last Updated: August 2026*

---

## 1. Project Overview

The **ATI ZMATF Pre-Training Diagnostic Assessment System** is a secure, server-side web application built for the **Africa Transformational Initiative (ATI)** in partnership with the **Revolutionary Government of Zanzibar — Ministry of Agriculture, Irrigation, Natural Resources and Livestock**.

### Core Purpose
The application measures baseline domain knowledge for senior government officials, prosecutors, law enforcement officers, customs officials, and conservation authorities prior to commencing the **ZMATF Executive Training Programme**.

### Assessment Key Specifications
* **Total Questions**: 20 Multiple Choice Questions (Section A: Q01–Q10, Section B: Q11–Q20).
* **Scoring**: 1 mark per question (20 total marks maximum).
* **Duration**: 10-minute strict time limit with auto-submission upon timer expiry.
* **Participant Roster**: 32 authorized senior officers (8 facilitators are explicitly excluded from taking the assessment).
* **Security Principle**: Answer keys, correct option IDs, and evaluation logic reside **exclusively on the server**. The client browser never receives answer keys or correct option indicators.

---

## 2. Current Project Status

| Area / Component | Status | Notes / Empirical Verification |
|---|---|---|
| **Backend Core** | **COMPLETE** | Node.js + Express 4.21 server with custom middleware, session storage, and security headers. |
| **Database Architecture** | **COMPLETE** | SQLite3 (`sql.js`) with persistent file storage (`database/ati-assessment.db`) and WAL mode schema. |
| **Authentication System** | **COMPLETE** | Dual-realm authentication: Participant Number + Surname + 6-digit PIN for officers, Admin username/password for facilitators. |
| **Participant Roster** | **COMPLETE** | 32 pre-seeded senior officers with full metadata (agency, designation, PIN). |
| **Question Bank & Choices** | **COMPLETE** | All 20 questions and 80 answer options loaded verbatim from official assessment source. |
| **Randomization Engine** | **COMPLETE** | Deterministic 24-permutation option shuffling per participant. Verified by 11 unit tests. |
| **Scoring Engine** | **COMPLETE** | Position-independent scoring resolving display positions to original option IDs. Verified by 50 unit tests. |
| **Timer Engine** | **COMPLETE** | Server-backed deadline calculation with client sync, visual progress bar, and 10-min auto-submission. |
| **Automated Unit Tests** | **COMPLETE** | **73/73 tests passing** across `scoring.test.js`, `randomization.test.js`, and `security.test.js`. |
| **Admin Dashboard & Reports** | **COMPLETE** | Roster monitoring, status filters, participant report views, analytics score distribution, and CSV export. |
| **EJS Layout Integration** | **FIXED / COMPLETE** | Integrated `express-ejs-layouts` in `server.js` so `views/layouts/main.ejs` wraps all rendered views with global `<head>` & CSS. |
| **Participant UI Polish** | **IN PROGRESS** | Full ATI visual design system defined in `public/css/style.css`. Requires visual QA review per screen. |
| **Responsive UI** | **NEEDS REVIEW** | CSS media queries written for mobile/tablet. Requires final visual verification across viewports. |
| **Accessibility (a11y)** | **NEEDS REVIEW** | Semantic tags and ARIA attributes added. Requires keyboard navigation and screen reader QA. |

---

## 3. Backend Architecture

The backend is built with **Node.js** and **Express.js**, following clean modular architectural practices:

```
[Browser Client]
       │
       ▼ (HTTP/HTTPS)
┌─────────────────────────────────────────────────────────┐
│ Server Pipeline (server.js)                             │
│ ├─ Helmet (Security CSP & Headers)                      │
│ ├─ express.static ('public/')                           │
│ ├─ express-session (MemoryStore session handling)       │
│ ├─ csurf (CSRF token generation & verification)         │
│ ├─ express-ejs-layouts (wraps EJS views in main.ejs)    │
│ └─ Custom Rate Limiter (lockout after 5 failed attempts)│
└──────────────────────────┬──────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌──────────────┐   ┌────────────────┐   ┌─────────────┐
│ Auth Routes  │   │ Assessment     │   │ Admin       │
│ (auth.js)    │   │ Routes         │   │ Routes      │
│              │   │(assessment.js) │   │ (admin.js)  │
└───────┬──────┘   └───────┬────────┘   └──────┬──────┘
        │                  │                   │
        └──────────────────┼───────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│ Logic & Engine Layer                                    │
│ ├─ Randomization Engine (src/engines/randomization.js) │
│ ├─ Scoring Engine (src/engines/scoring.js)             │
│ ├─ Timer Engine (src/utils/timer.js)                   │
│ └─ Database Abstraction (src/utils/db.js / sql.js)     │
└─────────────────────────────────────────────────────────┘
```

### Key Server Middleware Stack (`server.js`)
* **View Engine**: EJS with `express-ejs-layouts` configured as `app.set('layout', 'layouts/main')`.
* **Security Headers**: `helmet()` with strict Content Security Policy (`defaultSrc: ["'self'"]`, fontSrc from Google Fonts, styleSrc for local & inline styles).
* **Static Assets**: Express static directory served at `public/`.
* **Session Storage**: `express-session` with `MemoryStore` and `sameSite: 'lax'`.
* **CSRF Protection**: Form hidden input `_csrf` and AJAX header `X-CSRF-Token`.

---

## 4. Database Schema

The database uses SQLite3 (`sql.js`) initialized via `src/utils/db.js`.

### Core Tables

#### 1. `participants`
* `id` (INTEGER PRIMARY KEY)
* `participant_number` (INTEGER UNIQUE): Roster ID #1 to #32.
* `full_name` (TEXT): Official name.
* `title` (TEXT): Designation / Rank.
* `agency` (TEXT): Department / Ministry.
* `last_name` (TEXT): Surname used for verification login.
* `access_pin` (TEXT): 6-digit PIN.
* `is_active` (INTEGER): Active flag (1 = active participant).

#### 2. `admin_users`
* `id` (INTEGER PRIMARY KEY)
* `username` (TEXT UNIQUE): Admin login username.
* `password_hash` (TEXT): bcrypt hash of admin password.

#### 3. `questions`
* `id` (INTEGER PRIMARY KEY)
* `question_number` (INTEGER UNIQUE): 1 through 20.
* `section_label` (TEXT): 'A' or 'B'.
* `question_text` (TEXT): Verbatim text of the question.
* `marks` (INTEGER): 1 mark per question.

#### 4. `options`
* `id` (TEXT PRIMARY KEY): e.g., `opt_q1_a`, `opt_q1_b`, `opt_q1_c`, `opt_q1_d`.
* `question_id` (INTEGER FK -> `questions.id`): Associated question.
* `original_position` (TEXT): Original source letter ('A', 'B', 'C', 'D').
* `option_text` (TEXT): Option text.
* `is_correct` (INTEGER): 1 = correct answer, 0 = distractor.

#### 5. `assessment_attempts`
* `id` (INTEGER PRIMARY KEY)
* `participant_id` (INTEGER FK -> `participants.id` UNIQUE)
* `status` (TEXT): `'IN_PROGRESS'`, `'COMPLETED'`, or `'TIMED_OUT'`.
* `started_at` (TEXT): ISO timestamp when assessment was initiated.
* `submitted_at` (TEXT): ISO timestamp when assessment was submitted.
* `deadline_at` (TEXT): ISO timestamp 10 minutes after `started_at`.
* `score` (INTEGER): Final calculated score (0–20).
* `total_marks` (INTEGER): 20.
* `percentage` (INTEGER): Rounded percentage score.
* `knowledge_level` (TEXT): `'ADVANCED'`, `'COMPETENT'`, `'DEVELOPING'`, or `'FOUNDATIONAL'`.
* `knowledge_interpretation` (TEXT): Standardized level narrative.

#### 6. `randomized_mappings`
* `id` (INTEGER PRIMARY KEY)
* `attempt_id` (INTEGER FK -> `assessment_attempts.id`)
* `question_id` (INTEGER FK -> `questions.id`)
* `permutation_key` (INTEGER): Permutation index (0 to 23) defining display mapping.
* `display_position_a_option_id` (TEXT FK -> `options.id`)
* `display_position_b_option_id` (TEXT FK -> `options.id`)
* `display_position_c_option_id` (TEXT FK -> `options.id`)
* `display_position_d_option_id` (TEXT FK -> `options.id`)

#### 7. `responses`
* `id` (INTEGER PRIMARY KEY)
* `attempt_id` (INTEGER FK -> `assessment_attempts.id`)
* `question_id` (INTEGER FK -> `questions.id`)
* `selected_option_id` (TEXT FK -> `options.id` NULLABLE)
* `selected_display_position` (TEXT NULLABLE): `'A'`, `'B'`, `'C'`, or `'D'`.
* `is_correct` (INTEGER NULLABLE): 1, 0, or NULL if unanswered.
* `saved_at` (TEXT): ISO timestamp of response recording.

---

## 5. Assessment Logic & Randomization Model

### Knowledge Level Thresholds
Scoring automatically resolves scores (0–20) into official ATI Knowledge Levels:
* **17–20 Marks (85%–100%)**: `ADVANCED` — Demonstrates strong executive understanding of maritime security frameworks and inter-agency operational protocols.
* **13–16 Marks (65%–80%)**: `COMPETENT` — Possesses solid baseline knowledge with minor gaps in operational implementation procedures.
* **9–12 Marks (45%–60%)**: `DEVELOPING` — Possesses basic domain familiarity requiring structured reinforcement during training modules.
* **0–8 Marks (0%–40%)**: `FOUNDATIONAL` — Requires comprehensive introductory instruction across fundamental task force concepts.

### Option Randomization & Position Independence
Each participant receives a unique, deterministic shuffling of answer choices per question upon starting the assessment.

* There are **24 possible permutations** of `[A, B, C, D]`.
* When an attempt starts, `src/engines/randomization.js` assigns a permutation key (0–23) to each of the 20 questions and stores the display mapping in `randomized_mappings`.
* **CRITICAL RULE**: The letter displayed on the screen (e.g. Option B) does **NOT** equal original Option B.
* **Example**:
  * Original Correct Answer for Q1 is `opt_q1_b` ("Option text B").
  * Participant #4's permutation for Q1 maps: Position A -> `opt_q1_c`, Position B -> `opt_q1_a`, Position C -> `opt_q1_d`, Position D -> `opt_q1_b`.
  * Participant #4 selects **Position D**.
  * The server receives Position D -> maps to `opt_q1_b` -> evaluates against `is_correct = 1` -> **SCORES CORRECT**.
* The next developer **MUST NOT** alter this position-independent resolution logic.

---

## 6. Official Content Rules

> [!IMPORTANT]
> **STRICT DIRECTIVE**: DO NOT ALTER THE 20 OFFICIAL QUESTIONS OR 80 OFFICIAL ANSWER OPTIONS.
> 
> * DO NOT rewrite questions.
> * DO NOT paraphrase questions or options.
> * DO NOT alter distractor choices.
> * DO NOT modify legal terminology or Swahili/English phrasing.
> 
> Note on Source Audit #1 (`database/AUDIT_NOTES.md`):
> Section A header in original document reads "Multiple Choice Questions (20 Marks)", but Section A has 10 questions (10 marks) and Section B has 10 questions (10 marks). Total is 20 marks. The source header text was preserved verbatim per ATI instructions.

---

## 7. Roster & Participant Authentication

* **Authorized Roster**: 32 senior government officers registered in `database/seed.js`.
* **Excluded Officers**: 8 facilitators are explicitly excluded from the diagnostic test roster.
* **Authentication Pipeline**:
  * POST `/login` requires: `participantNumber` (1–32), `lastName` (Surname), `accessPin` (6-digit PIN).
  * Rate limited to **5 attempts per 15 minutes** per IP address.
  * Credentials reference file `participant-credentials.txt` is listed in `.gitignore` and **must never be committed to source control**.

---

## 8. Security Architecture

1. **Zero Client Answer Exposure**: Answer keys and `is_correct` flags are stored server-side. The JSON payloads sent to `questions.ejs` contain only `question_id`, `question_number`, `question_text`, and the shuffled display choices `[ { position: 'A', text: '...' }, ... ]`.
2. **CSRF Tokens**: All forms include `<input type="hidden" name="_csrf" value="<%= csrfToken %>">`. AJAX answer saves include header `X-CSRF-Token`.
3. **Session Cookies**: Session cookie configured with `httpOnly: true` and `sameSite: 'lax'`.
4. **Environment Isolation**: `.env` is excluded via `.gitignore`. `.env.example` provides the required keys (`PORT`, `NODE_ENV`, `SESSION_SECRET`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`).

---

## 9. Visual UI Architecture & Fixes Applied

### Design System Tokens (`public/css/style.css`)
* **Warm Ivory (`#FAF8F5`)**: Canvas background, cards, and light surfaces.
* **Deep Forest Ink (`#12221A`)**: Headers, navigation, editorial headings, dark cards.
* **Terracotta Ochre (`#C85A32`)**: Primary CTAs, active question selection states, progress bars.
* **Typography**:
  * `'Newsreader', serif`: Editorial headings and titles.
  * `'Plus Jakarta Sans', sans-serif`: Body text, buttons, form controls, navigation, tables.
  * `'JetBrains Mono', monospace`: Participant numbers, timers, scores, section tags.

### Root Cause Diagnosis of Rendered UI Issues & Fix
During browser QA, the login page previously rendered as unstyled raw HTML. 
* **Diagnostic Root Cause**: `server.js` had `app.set('view engine', 'ejs')` without registering `express-ejs-layouts`. Standard Express EJS ignored `{ layout: 'layouts/main' }` in `res.render()`, rendering only `views/auth/login.ejs` without `<head>`, Google Fonts, or `<link rel="stylesheet" href="/css/style.css">`.
* **Applied Fix**: Installed `express-ejs-layouts` package and added `app.use(expressLayouts)` and `app.set('layout', 'layouts/main')` in `server.js`.
* **SVG Safeguard**: Added explicit width/height attributes and CSS constraints (`max-width: 56px`, `max-height: 56px`, etc.) to prevent inline SVG elements from expanding to viewport width.

---

## 10. Screen-by-Screen Implementation Status

1. **Landing Page (`views/landing.ejs`)**: Redesigned into institutional entry portal with metric summary cards and primary CTA.
2. **Participant Login (`views/auth/login.ejs`)**: Split asymmetric layout (left: Deep Forest Ink identity card; right: credential verification form).
3. **Identity Confirmation (`views/assessment/confirm.ejs`)**: Officer confirmation card displaying participant number, full name, designation, and agency.
4. **Instructions Screen (`views/assessment/instructions.ejs`)**: Executive briefing screen with duration/question/marks badges and structure breakdown cards.
5. **Main Assessment Workspace (`views/assessment/questions.ejs`)**: 2-column layout with sticky sidebar navigator (Q01–Q20 progress dots) and center question canvas with stacked A/B/C/D option cards featuring Terracotta Ochre selection highlights.
6. **Review Screen & Modal (`views/assessment/review.ejs`)**: Stats summary strip, grid of Q01–Q20 answered/unanswered badges, and submission confirmation modal overlay.
7. **Participant Results Screen (`views/assessment/results.ejs`)**: Official diagnostic record card with score ring, percentage benchmark, Knowledge Level interpretation box, and completion CTA. (No correct answers revealed).
8. **Admin Login (`views/auth/admin-login.ejs`)**: Operational control login form in restrained Deep Forest Ink styling.
9. **Admin Dashboard (`views/admin/dashboard.ejs`)**: Executive monitoring dashboard with metric cards, Knowledge Level distribution progress bars, and quick action cards.
10. **Participant Roster (`views/admin/participants.ejs`)**: Data table with status badges, search input, status filter dropdown, and action links.
11. **Individual Result Detail (`views/admin/result-detail.ejs`)**: Detailed participant attempt report with administrator audit table of question responses and answer keys.
12. **Cohort Analytics (`views/admin/analytics.ejs`)**: Score distribution histogram, item-level difficulty table, and CSV dataset export CTA.

---

## 11. Server Lifecycle & Port Guidelines

* **Default Port**: 3000 (`http://localhost:3000`).
* **Handling EADDRINUSE**:
  * If `node server.js` fails with `EADDRINUSE: address already in use :::3000`, a Node process is already running.
  * **DO NOT** attempt to kill system processes or PID 0.
  * Identify the exact Node process running `server.js` using `tasklist` or PowerShell `Get-Process node`, and terminate only that Node process before restarting.

---

## 12. Automated Test Suite Verification

Run the test suite using:
```bash
npm test
```

### Verified Test Results (73/73 Passed)
```
PASS tests/security.test.js
PASS tests/randomization.test.js
PASS tests/scoring.test.js

Test Suites: 3 passed, 3 total
Tests:       73 passed, 73 total
Snapshots:   0 total
Time:        11.359 s
```

---

## 13. File-by-File Map

```
THE ATI APP/
├── .env.example                 # Environment variables template
├── .gitignore                    # Excluded files (node_modules, db, secrets)
├── package.json                 # Dependencies (express, ejs, express-ejs-layouts, helmet, csurf, sql.js)
├── server.js                     # Main Express application entry point & middleware configuration
├── database/
│   ├── schema.sql               # DDL for SQLite tables & indexes
│   ├── seed.js                  # Data seeding script for 20 questions, 80 options, 32 participants
│   └── ati-assessment.db        # Persistent SQLite database file
├── src/
│   ├── engines/
│   │   ├── randomization.js     # 24-permutation option shuffling algorithm
│   │   └── scoring.js           # Position-independent scoring & Knowledge Level mapping
│   ├── middleware/
│   │   ├── auth.js              # Participant & Admin authentication guards
│   │   ├── rateLimit.js         # Failed login attempt rate limiter
│   │   └── validation.js        # Input sanitization & CSRF locals middleware
│   ├── routes/
│   │   ├── admin.js             # Dashboard, roster, report detail, analytics, CSV export routes
│   │   ├── assessment.js        # Instructions, question canvas, save-answer AJAX, review, submit, results
│   │   └── auth.js              # Login & logout handling for participant and admin
│   └── utils/
│       ├── db.js                # sql.js SQLite initialization and file save helper
│       └── timer.js             # 10-minute deadline calculation and formatting helpers
├── views/
│   ├── layouts/
│   │   └── main.ejs             # Primary EJS layout (loads Google Fonts, style.css, header, footer)
│   ├── auth/
│   │   ├── login.ejs            # Participant split-card login view
│   │   └── admin-login.ejs      # Admin login view
│   ├── assessment/
│   │   ├── confirm.ejs          # Identity confirmation card
│   │   ├── instructions.ejs     # Executive briefing screen
│   │   ├── questions.ejs        # 2-column assessment workspace view
│   │   ├── review.ejs           # Review grid & submit confirmation modal
│   │   └── results.ejs          # Participant score & knowledge level results view
│   └── admin/
│       ├── dashboard.ejs        # Admin monitoring metrics dashboard
│       ├── participants.ejs     # Roster data table with filters
│       ├── result-detail.ejs    # Individual officer report view
│       └── analytics.ejs        # Cohort score histogram & item difficulty table
├── public/
│   ├── css/
│   │   └── style.css            # Complete ATI Design System stylesheet
│   └── js/
│       ├── assessment.js        # AJAX answer selection saver & option selection UI handler
│       └── timer.js             # Client countdown timer & auto-submit trigger
└── tests/
    ├── randomization.test.js    # Unit tests for permutation engine & option preservation
    ├── scoring.test.js          # Unit tests for answer key, knowledge levels, position independence
    └── security.test.js         # Unit tests for rate limiter & timer utility
```

---

## 14. Contracts That Must NOT Be Broken

The incoming developer **MUST NOT** alter:
1. **Route Endpoints & Field Names**:
   * POST `/login` (`participantNumber`, `lastName`, `accessPin`).
   * POST `/assessment/save-answer` (JSON `{ questionId, selectedPosition }`).
   * POST `/assessment/submit`.
   * POST `/admin/login` (`username`, `password`).
2. **Database Keys & Schemas**: Option IDs (`opt_q1_a`..`opt_q20_d`), participant IDs, question IDs.
3. **Scoring Logic & Randomization**: Position-independent mapping lookup via `randomized_mappings`.
4. **Answer Key Privacy**: Answer choices and correct indicators must never be sent to participant views or JS variables.

---

## 15. Quick-Start Command for Incoming Developer

To start the application locally:
```bash
# 1. Install dependencies
npm install

# 2. Configure environment file
copy .env.example .env
# Fill in SESSION_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD in .env

# 3. Seed database (if starting fresh)
npm run seed

# 4. Run automated test suite
npm test

# 5. Start development server
npm start
```
Then navigate to `http://localhost:3000` in Google Chrome or Edge.
