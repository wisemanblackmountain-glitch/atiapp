# ATI ZMATF Assessment — UI Handoff

**Frontend Developer Implementation & Visual QA Guide**  
*Africa Transformational Initiative (ATI) — ZMATF Executive Training Programme*  
*Last Updated: August 2026*

---

## 1. Design Goal

Transform the ATI ZMATF Pre-Training Diagnostic Assessment into a **world-class, institutional executive e-learning and assessment platform**.

The application must project authority, institutional credibility, clarity, and executive refinement suitable for senior officials from the Revolutionary Government of Zanzibar and maritime enforcement agencies.

---

## 2. ATI Design System Tokens

### Official Brand Color Palette

```css
/* Warm Ivory Canvas */
--color-ivory: #FAF8F5;          /* Main page canvas background */
--color-ivory-pure: #FFFFFF;     /* Primary card & workspace background */
--color-ivory-card: #F4F0E9;     /* Secondary container & table header background */
--color-ivory-border: #E3DDD5;   /* Neutral border color */

/* Deep Forest Ink */
--color-forest: #12221A;         /* Primary brand headers, dark navigation, typography */
--color-forest-light: #1D3529;   /* Hover states for dark cards */
--color-forest-card: #172B21;    /* Dark surface cards & badges */
--color-forest-dark: #0B1510;    /* Footer and admin dark background */

/* Terracotta Ochre */
--color-terracotta: #C85A32;        /* Primary action CTAs, active answer selection, highlights */
--color-terracotta-hover: #AA4825;  /* Hover state for primary buttons */
--color-terracotta-light: #FAF0EC;  /* Active answer card background tint */
--color-terracotta-border: #E8B4A2; /* Active border accent */
```

### Official Typography Hierarchy

```css
/* Editorial & Major Headings */
font-family: 'Newsreader', Georgia, serif;

/* Interface, Body, Forms, Navigation, Tables & Buttons */
font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;

/* Technical Metadata, Participant IDs, Timers, Scores */
font-family: 'JetBrains Mono', monospace;
```

---

## 3. Core UX & Design Principles

1. **Quiet Authority**: Use restrained, high-contrast institutional typography rather than noisy SaaS embellishments.
2. **Focus & Space**: Generous card padding (`2.5rem`), clean grid layouts, and zero visual clutter during assessment taking.
3. **Instant Feedback**: Large, accessible answer cards (`A`, `B`, `C`, `D`) with distinct Terracotta Ochre selection highlights and clear check indicators.
4. **Zero Answer Key Exposure**: The participant results interface displays scores, percentages, and knowledge level benchmarks, but **never** exposes correct answer keys or question-level correct/incorrect badges.

---

## 4. Current UI Screen Status & Target Checklist

| Screen | Template Path | Visual Target & Component Checklist | Status |
|---|---|---|---|
| **1. Landing Portal** | `views/landing.ejs` | Metric cards, institutional seal, hero headline, primary CTA. | COMPLETE |
| **2. Participant Login** | `views/auth/login.ejs` | Asymmetric split layout (Deep Forest branding left, verification form right). | COMPLETE |
| **3. Identity Confirmation** | `views/assessment/confirm.ejs` | Officer detail grid card, security notice, action CTAs. | COMPLETE |
| **4. Executive Briefing** | `views/assessment/instructions.ejs` | Overview bar (10 mins, 20 questions), structure breakdown cards. | COMPLETE |
| **5. Question Canvas** | `views/assessment/questions.ejs` | 2-column layout, sticky progress navigator, stacked A/B/C/D option cards. | COMPLETE |
| **6. Review & Modal** | `views/assessment/review.ejs` | Stat strip, Q01–Q20 answer badges grid, styled confirmation modal overlay. | COMPLETE |
| **7. Participant Results** | `views/assessment/results.ejs` | Official diagnostic record, score ring, Knowledge Level badge, baseline disclaimer. | COMPLETE |
| **8. Admin Login** | `views/auth/admin-login.ejs` | Restrained operational control theme in Deep Forest Ink. | COMPLETE |
| **9. Admin Dashboard** | `views/admin/dashboard.ejs` | Executive metrics strip, Knowledge Level distribution bars, quick action tiles. | COMPLETE |
| **10. Participant Roster** | `views/admin/participants.ejs` | Data table with status badges, search input, status filter dropdown. | COMPLETE |
| **11. Individual Report** | `views/admin/result-detail.ejs` | Participant metadata, diagnostic benchmark card, administrator audit table. | COMPLETE |
| **12. Cohort Analytics** | `views/admin/analytics.ejs` | Score frequency histogram, item-level difficulty table, CSV export. | COMPLETE |

---

## 5. Known Frontend Issues & Fix Guidelines

### Issue 1: EJS Layout Wrapping
* **Fixed Root Cause**: `express-ejs-layouts` middleware has been registered in `server.js`.
* **Requirement**: Ensure all views remain rendered through `views/layouts/main.ejs` so Google Fonts and `public/css/style.css` are loaded on every page load.

### Issue 2: SVG Icon Dimensions
* **Fixed Safeguard**: All SVG tags across view files contain explicit `width` and `height` attributes (e.g. `width="32" height="32"`), and `public/css/style.css` enforces `.emblem-svg`, `.emblem-icon`, `.timer-svg`, `.btn-arrow` sizing.
* **Requirement**: Any newly added SVG icons must include explicit `width` and `height` attributes and class rules to prevent viewport expansion.

---

## 6. Component System Overview

### 1. Primary Buttons
```html
<button type="submit" class="btn btn-terracotta btn-lg" id="submit-id">
    <span>Action Text</span>
    <svg class="btn-arrow" width="18" height="18" viewBox="0 0 20 20" fill="currentColor">...</svg>
</button>
```

### 2. Form Input Controls
```html
<div class="form-group">
    <label for="input-id" class="form-label">
        <span>Field Label</span>
        <span class="form-hint">Hint text</span>
    </label>
    <input type="text" id="input-id" name="input-id" class="form-input font-mono" placeholder="...">
</div>
```

### 3. Answer Option Cards
```html
<button type="button" class="option-btn <%= isSelected ? 'selected' : '' %>" data-position="A" data-question-id="<%= q.id %>">
    <span class="option-letter-badge font-mono">A</span>
    <span class="option-text"><%= option.text %></span>
    <span class="option-radio-check">
        <span class="radio-inner"></span>
    </span>
</button>
```

---

## 7. Responsive Requirements

* **Desktop (`>1024px`)**: Full 2-column workspace for questions, 4-column metrics grid for admin dashboard.
* **Tablet (`768px - 1024px`)**: Stacked layout with sticky top status bar and collapsible question navigator.
* **Mobile (`<768px`)**: Single-column layout, touch-friendly option card heights (min `48px`), full-width action buttons.

---

## 8. Definition of Done for Frontend QA

The frontend developer can consider the UI complete when:
- [x] All 14 EJS views render through `views/layouts/main.ejs`.
- [x] Google Fonts (`Newsreader`, `Plus Jakarta Sans`, `JetBrains Mono`) render cleanly.
- [x] Warm Ivory canvas (`#FAF8F5`), Deep Forest Ink (`#12221A`), and Terracotta Ochre (`#C85A32`) are consistently applied.
- [x] SVG icons maintain controlled dimensions.
- [x] All 73 automated Jest unit tests pass without breakage (`npm test`).
- [x] Participant login, question navigation, answer saving AJAX, review modal, and auto-submission function cleanly.
- [x] Responsive layout functions seamlessly on desktop, tablet, and mobile viewports.
