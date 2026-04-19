# Paper Whisperer

Academic paper library manager with server-side filtering, sorting, pagination, keyword analysis, and AI-powered study classification.

## Tech stack

- **Frontend:** React + TypeScript + Vite + shadcn-ui + Tailwind CSS
- **Backend:** Supabase (Postgres, Auth, Edge Functions, PostgREST)
- **Region:** Supabase free tier, South Asia (Mumbai)

## Current status (April 2026)

The app is **stable, hardened, and feature-complete at current scale**. Five major work phases are complete:

1. **Read-path performance track** (PRs #56–#65) — server-side filtering, sorting, pagination, lazy loading, abstract on-demand fetch. Handles ~400+ papers with sub-second dashboard loads.
2. **Security & schema integrity hardening** (PRs #67–#76) — edge function logging redaction, PubMed API key server-side migration, RLS restoration on all user-scoped tables, per-user uniqueness constraints, FK cascade fixes, and import UX improvements.
3. **Correctness & hygiene fixes** (PRs #78–#82) — normalization worker error-handling fix, ghost query field removal, client-side code deduplication, Gemini API key transport hardening, and further log sanitization.
4. **Paper notes feature wave** (PRs #84–#87) — `notes` column on `papers` with an Edit-dialog textarea, a list-cell sticky-note indicator with popover preview, a tri-state "Has Notes" filter, and inclusion of notes in full-text search (weight D) and the short-query ILIKE path.
5. **Search-behavior upgrade** (PR #88) — `search_papers` rewritten as prefix-aware FTS so partial inputs match while typing (`guideli` finds "guideline"). Uses a Unicode-preserving blacklist of tsquery operator characters; the existing `search_vector`, GIN index, and short-search RPC are unchanged. Migration applied on Supabase and manually verified.

Deeper DB optimization is evidence-deferred until the library grows past ~2,000–5,000 papers. See [docs/decisions-and-triggers.md](docs/decisions-and-triggers.md) for the exact re-evaluation criteria.

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
npx vitest run               # Unit tests (185 tests)
npx playwright test          # E2E tests
npx playwright test --ui     # Interactive test runner
```

E2E auth credentials are in `.env.test`.
