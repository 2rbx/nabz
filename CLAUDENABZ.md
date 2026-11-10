@AGENTS.md

# Nabz

Weekly demand indices for India's offline economy, built from short AI phone surveys (Bolna) of businesses.
Vehicles are the first sector. Build spec: `../Nabz MVP Spec.md` (authoritative). Product background: `../Nabz PRD.md`; page layout and content: `../Nabz Product Mockup.html`.

Visual style: modern minimal white + blue, light only, slate-50 page, white rounded-2xl cards with shadow-sm, one blue-600 accent, pill nav/buttons, pastel ring pills, Geist. The top bar has square full-height tabs and the wordmark logo everywhere; client pages also use bigger text in taller boxes (`BoxHeader`), while Ops keeps smaller text. Use the semantic tokens in `src/app/globals.css` (index values use the blue ↔ red `index-*` scale via `src/components/index/signal.tsx`) and the components in `src/components/ui.tsx`; never hard-code colours. No dark mode.

## Hard rules

- **`NABZ_MODE` decides who can be called** (`testing` by default, `src/lib/calling-policy.ts`). In testing, only `ALLOWED_NUMBERS` in `.env.local` can be added as dealers or called; any other number gets an error saying how to switch. In production, any valid number. That is the only difference between the modes. **The owner's copy stays in testing. Never set production, add to `ALLOWED_NUMBERS`, or call any other number without the owner's explicit permission for that specific use.** No real phone numbers in the repo: tests use made-up ones.
- **Don't spend Bolna credits casually.** `CALLING_ENABLED` is off by default; daily cap $10. Develop against the mocked-Bolna tests. Real calls are deliberate, one at a time, and confirmed with the owner first.
- **One real world.** Every dealer in the database is real and can be called, subject to the mode. There is no sample data and no `dataset` column. A new copy starts empty.
- **Before real dealers are called, the app must have opt-out, DND and calling hours** (the legal brief requires them; spec §10). They were removed for now, on the owner's decision. Production mode does not add them, and the README says so.
- **Only calls from a set change data.** A **test call** (Test call in the Edit dealer pop-up, `placeTestCall` in `src/lib/bolna/dialer.ts`) is a real, paid call that creates no set, recipient or call row and carries no `nabz_call_ref`, so it can never reach the index or a survey freeze. Its only trace is a `dialer_log` row, which counts its estimate toward the daily spend cap.
- **Client pages are live** (no release step yet): `/pulse` and `/heatmap` run the index engine (`src/lib/index/`) on every request over all usable calls. Loader: `src/lib/db/queries/index-data.ts`; page view: `src/lib/index/view.ts`.
- **No made-up numbers.** Every number on the client pages comes from an answered call.
- **Batches vs sets.** A **batch** is a saved list of dealers, normally one company × state cell ("Hero · Karnataka"); names are unique and a dealer is in **at most one batch** (both enforced by the database). A **set** (`sets` / `set_recipients`) is one run of a batch, its calls together; running it next week is another set. A batch with sets is archived, never deleted.
- **Calling a batch: sets** (`src/lib/bolna/set-dialer.ts`, rules in `planSet`, `src/lib/calls/set-plan.ts`). Rows are called one at a time, in order, each with the agent for the dealer's language; the live page `/ops/calls/sets?set=<id>` drives it (`advanceSet` every 5 s), so closing it pauses the set. Every run calls everyone again. A many-at-once version is archived in `../archive/many-at-once/`.
- **Newest good call wins.** If a dealer is called again in a survey week, the index uses their newest usable call, whole (`latestPerDealer`, `src/lib/index/engine.ts`; `previousWeekAnswers`). The old call stays in Ops → Calls, marked Replaced.
- **Clients never see a dealer.** No names or numbers on client pages or exports; brand × state cells below 3 dealers are suppressed, and so is **any single indicator** answered by fewer than 3 (engine v2: a cell of 5 where 1 answered loans hides loans). The audit log never stores personal data.
- **Only `src/lib/bolna/` talks to Bolna** (ESLint enforces it), so every call passes the dialer's guards.

## Architecture rules

- Pure modules (`src/lib/domain`, `reference`, `sectors`, `surveys`, `index`, `calls`, `batches`) import nothing from the database, env, Next.js or `server-only`. They're shared by the app, scripts and tests. ESLint enforces it. `src/lib/calling-policy.ts` is pure too, and reaches the browser, so the calling scope is always passed in (`callingScope()` in `env.ts` builds it).
- `process.env` is read only in `src/lib/env.ts` (validated with zod). Scripts load `.env.local` via `scripts/db/_env.ts`.
- Sector-generic: no brand or vehicle logic in generic code. "Dealer" (`dealers` table, `dealer_id`) is the generic word for any business Nabz calls, in every sector (owner's naming). Sectors, dealer attributes and survey definitions are configuration in `src/lib/sectors` and `src/lib/surveys/definitions`.
- **Answers are real answers only.** `calls.answers` (all the engine reads) never holds a placeholder; a missing answer is simply absent, never imputed. Why it's missing (didn't know / declined / not asked / unclear) lives in `extracted[key].status`; read it through `answerStatus()` (`src/lib/calls/answer-status.ts`), which also handles calls stored before reasons existed. "Didn't know" still makes a call completed; only "not asked" makes it partial (`surveyOutcome`).
- Survey definitions are versioned. Once a version is used it is frozen (DB trigger). Change = add `vehicle-pulse.v2.ts`, never edit v1. The v1 hash is pinned in `definitions.test.ts`.
- Immutability lives in the database (`drizzle/0001_guards.sql`): frozen surveys, answer overrides and audit log.
- Query helpers in `src/lib/db/queries/` run their queries one after another, never `Promise.all`: they may be given a transaction, which has a single connection (pg deprecates overlapping queries on one client).
- Migrations come from `pnpm db:generate`, except renames: drizzle-kit asks about those interactively, so write the SQL by hand (including Postgres 18's named NOT NULL constraints) and produce the snapshot by generating the schema into a scratch folder. `tests/db/migrations.test.ts` checks that the migrated database matches the latest snapshot, and `pnpm db:generate` must then report no changes.
- No Postgres enums: text + named CHECK constraints built from TS arrays. Every check and index has an explicit short name; foreign keys keep drizzle's default names.
- Survey weeks are ISO weeks in IST, stored as the Monday's date string (`week_start`). Use `src/lib/domain/week.ts`; never local-time Date maths.

## Areas and navigation

- Two areas: **client** (`/pulse`, `/heatmap`) and **ops** (`/ops/...`). Each area layout renders `<SiteHeader area=…>`, which shows that area's pills and the **Client | Ops** switch (`src/components/shell/`). Add new pages to `AREA_NAV` in `site-header.tsx` and to `areaOf` in `area.ts`.
- The switch resumes where you left each area **in this browser tab only** (sessionStorage): page, query and scroll. `AreaMemory` lives once, in the root layout. Area layouts stay mounted (hidden) between navigations, so never put a second copy inside them.
- Forms with controlled fields (selects driven by state): submit via `onSubmit` + `startTransition(() => dispatch(formData))`, not `<form action={…}>`. React resets a form after an action, which desyncs controlled selects from their state (the `Add dealer` bug).
- Next keeps recently visited pages' component state, but not reliably. Forms whose content matters (call review) save drafts to sessionStorage.

## Next.js 16 rules (Cache Components is on)

- Read `node_modules/next/dist/docs/` before using an unfamiliar API.
- Every component that reads the database calls `await io()` (from `next/cache`) first, or sits behind a request API (`cookies()`), and is inside a `<Suspense>` boundary. The build must never open a database connection.
- Every page renders its title/static parts directly and puts its data in its own `<Suspense>` with a skeleton (`LoadingCards`), so client navigation between pages is instant. A layout-level boundary does not cover navigations below that layout.
- Anything that must run per request and reads the clock or randomness calls `await connection()` first (dev-mode prerender validation flags `Date.now()` otherwise).
- `next build` does not catch dev-only validation (instant navigation, unstable values). After UI changes, also walk the pages on `next dev` and check the browser console and `.next/dev/logs/next-development.log`.
- `params`, `searchParams`, `cookies()` and `headers()` are async. Middleware would be `src/proxy.ts` (none today).
- **Ops has no login** (owner's decision): it's a tab like Client, opening on `/ops/dealers` (the old `/ops/respondents` redirects there); actions audit as actor `"ops"`. Ops pages are `noindex`/`no-store` via `next.config.ts`. **Before any public deploy, put access protection in front of the app** (e.g. hosting-level password protection): ops shows dealer details and can add dealers.
- Typed routes are on: use `Route` types or object hrefs.

## Commands

```
pnpm dev                      # app on http://localhost:3000
pnpm check                    # typecheck + lint + all tests + production build
pnpm test:unit | test:db      # db tests rebuild nabz_test from scratch; run one db test run at a time
pnpm db:generate              # after schema changes (src/lib/db/schema); never `drizzle-kit push`
pnpm db:migrate | db:sync | db:setup   # db:setup = migrate + sync
pnpm agents:create            # create the agents in this key's Bolna account (from agents/definitions/, exported by call-lab/export-agents.ts) and save their ids to agents.local.json; never calls
pnpm agents:sync              # after db:sync: snapshot the agents (src/lib/calls/agents.ts, or the ids in agents.local.json) into agent_versions; free GETs, never calls
pnpm calls:sync | calls:watch  # collect call results from Bolna (once / every 30 s while calls are open) + the extraction fallback; reads only, never dials
pnpm db:reset --yes [--setup] # local nabz_dev only
pnpm db:bootstrap             # one-time: role + databases + .env.local (needs .env.bootstrap.local)
```

## Environment notes

Windows + Git Bash/PowerShell. Postgres 18 runs locally as a Windows service (`psql` isn't on PATH; scripts use `pg`). Tests force `TZ=UTC`. Don't commit unless asked.
