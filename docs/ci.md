# CI quality gate

`.github/workflows/ci.yml` runs on every pull request (any base branch) and on
manual dispatch. All jobs run in parallel.

| Check name | What it proves |
|---|---|
| `Typecheck & Lint` | `tsc --noEmit` and `expo lint` (unchanged original job) |
| `Node regression tests` | every `scripts/check-*` / `scripts/verify-*` file via `node --test` (Node 22) |
| `Database - clean migration from zero` | all `supabase/migrations/*.sql` apply to an empty Supabase Postgres, every file is recorded as applied, schema security invariants hold |
| `Database - SQL regression tests` | every `supabase/tests/*.test.sql` |
| `Database - concurrency tests` | every `supabase/tests/*.test.sh` (real two-connection races), 3 runs each |
| `Security - secrets and CI isolation` | gitleaks over the full git history, no tracked credential files, CI uses no secrets or hosted URLs |

`scripts/check-legal-urls.mjs` is not part of CI: it fetches the public legal
pages over the internet. Run it before every store build (`npm run check:legal-urls`).

## Database jobs

Each database job builds its own throwaway database with
`.github/actions/ephemeral-supabase-db`:

1. Containers on the runner get no internet route (iptables `DOCKER-USER`).
   Migration `20260717000003` schedules a pg_cron job that posts to a
   hard-coded hosted Edge Function URL every minute; in CI that call fails
   with a connection error. Each job ends by asserting that no pg_net request
   got an HTTP response (`scripts/ci/assert-no-egress.sh`).
2. Supabase CLI `2.120.0` with the hosted service versions pinned through
   `supabase/.temp/*-version` (Postgres `17.6.1.147`, GoTrue `v2.197.0`,
   Storage `v1.73.1`). CI never runs `supabase link`.
3. `supabase start` with all service containers excluded except the
   database. Auth and storage schema migrations still run, so `auth.users`,
   `storage.objects` and the Supabase roles exist as on a hosted project.
4. Background pg_cron jobs are paused, except the dispatch sweeper that the
   health-check tests expect to be active.

The workflow references no secrets. The runners only talk to the database
through `docker exec` into the local container, so they have no connection
string that could point anywhere else.

### How a SQL test fails

`scripts/ci/run-sql-tests.sh` marks a test as failed when

- psql exits non-zero (`RAISE EXCEPTION`, any SQL error), or
- the output has a `FAIL` verdict cell. Most tests print an
  expected / actual / verdict table and still exit 0 when a row says `FAIL`,
  or
- row counts in `public` / `auth` / `storage` or the `app_config` contents
  differ after the test (fixtures left behind).

## Running the database checks locally

The runners refuse a database that holds companies or auth users, so they
never touch a local database with real or hand-made data (override on
purpose with `TASKOPS_ALLOW_NONEMPTY_DB=1`).

With a fresh local stack (`supabase start`, which applies all migrations):

```bash
bash scripts/ci/run-sql-tests.sh
CONCURRENCY_ITERATIONS=3 bash scripts/ci/run-concurrency-tests.sh
```

With another local container: `DB_CONTAINER=<name> bash scripts/ci/run-sql-tests.sh`.

## Adding tests

- New `supabase/tests/*.test.sql` and `*.test.sh` files and new
  `scripts/check-*` / `scripts/verify-*` files run in CI automatically.
- A new SECURITY DEFINER function that `authenticated` may execute fails
  `schema_security_invariants.test.sql` until its name is added to the
  reviewed list there.
- A reviewed gitleaks false positive goes into `.gitleaksignore` with a reason.
