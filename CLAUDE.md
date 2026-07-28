# CLAUDE.md — working notes for this repo

Personal day-trading & options assistant — **decision-support and tracking**, not a
signal service, and it never places trades. Monorepo via npm workspaces:

- `server/` — Node/Express/TS + SQLite (better-sqlite3). Holds **all** market-data keys.
- `web/` — React/Vite/TS/Tailwind/Recharts. Browser-only; talks to same-origin `/api/*`.

User-facing docs live in `docs/`. The in-app **About** page
(`web/src/pages/AboutPage.tsx`) is the authoritative description of scoring/formulas.

---

## ✍️ Keep the docs in sync — standing rule

**Documentation is part of "done."** Whenever a change alters _what the app does_ or
_how it's used_, update the relevant docs **in the same PR as the code**:

| When you change… | Update… |
|---|---|
| A feature, page, or UI flow (new or changed) | `docs/USER_GUIDE.md` |
| A scoring component, formula, metric, or default weight | `web/src/pages/AboutPage.tsx` (authoritative) **and** the User Guide |
| A tool/metric that changes _how to trade_ (sizing, analytics, exits, edge, guardrails) | `docs/STRATEGY_PLAYBOOK.md` |
| Setup, run, config, provider, env var, or an npm script | `README.md` (and the User Guide's "Getting started" if user-visible) |

Guidelines:

- Keep cross-links intact: `README` → `docs/*`; the two guides link to each other and
  back to the README.
- Describe only what the code actually does — verify against the source, don't invent.
  If you can't document a change accurately, it isn't finished.
- Run `npm run format` after editing prose (markdown is formatted too).
- Same not-financial-advice framing everywhere (mirrors the About page).

---

## Dev workflow

- **Verify before every PR:**
  `npm run format && npm run typecheck && npm run lint && npm test && npm run build`
- One logical change per PR. Branch off `main`; squash-merge once the single
  `build-test` CI job is green.
- Tests: server Vitest (pure services) + web Vitest/jsdom (glob `src/**/*.test.{ts,tsx}`;
  jsdom render smokes need a `ResizeObserver` shim for Recharts).
- **`npm run typecheck` covers test files too — in BOTH workspaces.**
  `web/tsconfig.json` used to exclude them, which let mocks and fixtures drift from
  `api/types.ts` unnoticed — a fixture could omit required fields, so the test asserted
  against a shape the API never returns. The server had the same gap until 2026-07-28
  (its `test/` sat outside `tsconfig.json`'s include); its typecheck now also runs
  `tsconfig.test.json` (src + test, bundler resolution to match how vitest loads
  tests — the build config alone still owns src's stricter node16 rules). If you add a
  fixture, give it every field; reach for `as never` only when you genuinely mean
  "this call is not what's under test".
- Demo data: `npm run seed` (idempotent; `--force` to add anyway).
- Run locally: `npm run dev` → API `:3001` + web `:5173`.

## Invariants

- Market-data keys are **server-side only**; the browser never holds a key.
  `.env` is gitignored — `cp .env.example server/.env`. Never commit secrets.
- Scoring/formulas stay **explainable** and mirrored between the engine
  (`server/src/indicators/`) and the About page.
- The DB schema is created by `initDb()` at startup (and in `scripts/seed.ts`) — not on
  import; call it before using db functions in a standalone script.
