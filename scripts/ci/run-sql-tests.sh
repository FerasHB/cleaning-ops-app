#!/usr/bin/env bash
# Runs every supabase/tests/*.test.sql against a freshly migrated, throwaway
# local database (see db-common.sh for the safety guard).
#
# A test fails when
#   * psql exits non-zero (RAISE EXCEPTION, SQL error; ON_ERROR_STOP=1), or
#   * its result table contains a FAIL verdict cell. Most tests report
#     expected/actual/verdict rows and still exit 0 when a row says FAIL,
#     so the exit code alone would miss real failures, or
#   * it leaves rows behind (row counts or app_config differ afterwards).
#
#   DB_CONTAINER=<container> bash scripts/ci/run-sql-tests.sh [file ...]
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
source scripts/ci/db-common.sh

assert_ephemeral_db

if [[ $# -gt 0 ]]; then files=("$@"); else files=(supabase/tests/*.test.sql); fi
log_dir=$(mktemp -d)
failed=()
summary "### SQL regression tests" "" "| Test | Result | Seconds |" "|---|---|---|"

for file in "${files[@]}"; do
  name=$(basename "$file" .test.sql)
  log="$log_dir/$name.log"
  before=$(db_snapshot)
  start=$SECONDS
  db_psql < "$file" > "$log" 2>&1
  rc=$?
  took=$((SECONDS - start))
  after=$(db_snapshot)
  fail_cells=$(grep -cE '(^|\|) *FAIL *(\||$)' "$log")
  reason=""
  if [[ $rc -ne 0 ]]; then reason="psql exit $rc"
  elif [[ $fail_cells -ne 0 ]]; then reason="$fail_cells FAIL verdict row(s)"
  elif [[ "$before" != "$after" ]]; then reason="left rows behind"
  fi
  if [[ -z "$reason" ]]; then
    echo "PASS  ${took}s  $name"
    summary "| $name | pass | $took |"
  else
    echo "FAIL  ${took}s  $name ($reason)"
    echo "::error file=$file::$name failed: $reason"
    echo "::group::$name output"
    cat "$log"
    if [[ "$reason" == "left rows behind" ]]; then
      diff <(echo "$before") <(echo "$after")
    fi
    echo "::endgroup::"
    summary "| $name | **FAIL** ($reason) | $took |"
    failed+=("$name")
  fi
done

echo
echo "${#files[@]} SQL test files, ${#failed[@]} failed."
if [[ ${#failed[@]} -gt 0 ]]; then
  printf '  - %s\n' "${failed[@]}"
  exit 1
fi
