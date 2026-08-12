# ATI ZMATF Executive Training Assessment System

**Africa Transformational Initiative (ATI)**  
*Zanzibar Multi-Agency Task Force (ZMATF) Executive Training Programme — Pre-Training Diagnostic Assessment*

---

## 📌 Developer Handoff Documentation

This project has been fully documented for developer transition:

* 📄 **[DEVELOPER_HANDOFF.md](DEVELOPER_HANDOFF.md)** — Primary technical handoff document covering backend architecture, database schema, randomization engine, position-independent scoring, security requirements, and server lifecycle.
* 🎨 **[UI_HANDOFF.md](UI_HANDOFF.md)** — Frontend developer implementation guide covering the ATI Design System tokens, typography, component specifications, responsive requirements, and visual QA checklist.

---

## 🚀 Quick Start Guide

```bash
# 1. Install dependencies
npm install

# 2. Configure environment file
copy .env.example .env
# Edit .env and supply SESSION_SECRET, ADMIN_USERNAME, and ADMIN_PASSWORD

# 3. Seed database (if starting fresh)
npm run seed

# 4. Run unit test suite
npm test

# 5. Start development server
npm start
```

Navigate to `http://localhost:3000` in your web browser.

---

## 🔒 Security & Official Content Directives

1. **Answer Key Protection**: Answer choices and correct option keys reside exclusively on the server.
2. **Official Assessment Content**: The 20 questions and 80 answer options are preserved verbatim from the official ATI source document and **must not be altered**.
3. **Secrets Management**: Never commit `.env` or sensitive participant credentials to version control.
