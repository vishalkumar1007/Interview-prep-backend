# Prepbase Backend

Express API for Prepbase. Runs locally with SQLite file storage, and on **Vercel** with a free [Turso](https://turso.tech) database (SQLite-compatible).

Requires **Node.js 22+** locally.

## Local setup

```bash
cp .env.example .env
npm install
npm run dev
```

Without Turso env vars, data is stored in `data/prepbase.sqlite`.

## Free deploy on Vercel

1. Create a free DB at [Turso](https://turso.tech) and copy `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN`.
2. Import this repo in [Vercel](https://vercel.com) (Hobby / free).
3. Set environment variables:
   - `JWT_SECRET` — long random string
   - `FRONTEND_ORIGIN` — your frontend URL (e.g. `https://your-app.vercel.app`)
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
   - `NODE_ENV=production`
4. Deploy. API will be at `https://your-backend.vercel.app/api/...`

Companion UI: [Interview-prep-frontend](https://github.com/vishalkumar1007/Interview-prep-frontend).

On the frontend Vercel project, set `VITE_API_URL` to this backend URL.
