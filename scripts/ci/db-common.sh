#!/usr/bin/env bash
# Shared helpers for the database CI runners (run-sql-tests.sh,
# run-concurrency-tests.sh). Sourced, not executed.
#
# Safety model: every command goes through `docker exec` into a LOCAL
# container. There is no connection string, host or password anywhere, so
# these runners cannot reach Staging or Production even if such secrets were
# present in the environment.

DB_CONTAINER="${DB_CONTAINER:-supabase_db_cleaning-employee-app-2}"
export DB_CONTAINER

db_psql() {
  docker exec -i "$DB_CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"
}

# Refuses to run unless the target is a local container holding a freshly
# migrated database (no companies, no auth users). Protects a developer's
# local database that contains real or hand-made data. Override only on
# purpose: TASKOPS_ALLOW_NONEMPTY_DB=1.
assert_ephemeral_db() {
  if ! docker inspect "$DB_CONTAINER" > /dev/null 2>&1; then
    echo "::error::Local database container '$DB_CONTAINER' not found." >&2
    exit 1
  fi
  local rows
  rows=$(db_psql -Atc "select (select count(*) from public.companies) + (select count(*) from auth.users)")
  if [[ "$rows" != "0" && "${TASKOPS_ALLOW_NONEMPTY_DB:-}" != "1" ]]; then
    echo "::error::Database in '$DB_CONTAINER' is not empty ($rows company/auth rows)." >&2
    echo "These runners only target a freshly migrated, throwaway database." >&2
    echo "Set TASKOPS_ALLOW_NONEMPTY_DB=1 to override on purpose." >&2
    exit 1
  fi
}

# Fingerprint of every row count in public/auth/storage plus the full
# app_config content. Equal before/after a test = the test left nothing behind.
db_snapshot() {
  db_psql -Atq <<'SQL'
do $$
declare r record; n bigint; acc text := '';
begin
  for r in
    select ns.nspname as s, c.relname as t
    from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname in ('public', 'auth', 'storage') and c.relkind in ('r', 'p')
    order by 1, 2
  loop
    execute format('select count(*) from %I.%I', r.s, r.t) into n;
    if n > 0 then acc := acc || r.s || '.' || r.t || '=' || n || E'\n'; end if;
  end loop;
  perform set_config('ci.snapshot', acc, false);
end $$;
select current_setting('ci.snapshot')
  || 'app_config=' || coalesce((select md5(string_agg(key || '=' || value::text, ',' order by key)) from public.app_config), '-');
SQL
}

summary() {
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"; fi
}
