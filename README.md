# Prepbase Backend

Express + SQLite (`node:sqlite`) + JWT cookie auth for the Prepbase interview-prep app.

Requires **Node.js 22+**.

## Setup

```bash
cp .env.example .env
npm install
npm run dev
```

Content banks and the week plan are seeded into SQLite on boot from `content/`.

Companion UI: [Interview-prep-frontend](https://github.com/vishalkumar1007/Interview-prep-frontend).
