# Paper Whisperer

Academic paper library manager with server-side filtering, sorting, pagination, keyword analysis, and AI-powered study classification.

## Tech stack

- **Frontend:** React + TypeScript + Vite + shadcn-ui + Tailwind CSS
- **Backend:** Supabase (Postgres, Auth, Edge Functions, PostgREST)
- **Region:** Supabase free tier, South Asia (Mumbai)

## Current status (April 2026)

The read-path performance track (PRs #56–#65) is **complete**. The app handles ~400 papers with sub-second dashboard loads. Deeper DB optimization is evidence-deferred until the library grows past ~2,000–5,000 papers. See [docs/decisions-and-triggers.md](docs/decisions-and-triggers.md) for the exact re-evaluation criteria.

## Documentation

| Doc | Purpose |
|---|---|
| [docs/start-here.md](docs/start-here.md) | Fresh-chat handoff for new assistants |
| [docs/architecture-read-path.md](docs/architecture-read-path.md) | Current read-path architecture |
| [docs/migration-history.md](docs/migration-history.md) | What changed, when, and why |
| [docs/decisions-and-triggers.md](docs/decisions-and-triggers.md) | Architectural decisions and re-evaluation triggers |

## Local development

```sh
git clone <repo-url>
cd paper-whisperer-62
npm install
npm run dev
```

Requires Node.js 18+. Supabase project config is in `supabase/config.toml`.

## Testing

```sh
npx playwright test          # E2E tests
npx playwright test --ui     # Interactive test runner
```

E2E auth credentials are in `.env.test`.
