#!/usr/bin/env bash
# Runs every supabase/tests/*.test.sh (real multi-connection races) against a
# freshly migrated, throwaway local database (see db-common.sh).
#
# Each race runs CONCURRENCY_ITERATIONS times (default 1) because a timing bug
# may not show on the first try. A run fails on a non-zero exit or when the
# test leaves rows / app_config changes behind.
#
#   DB_CONTAINER=<container> CONCURRENCY_ITERATIONS=3 bash scripts/ci/run-concurrency-tests.sh
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
source scripts/ci/db-common.sh

assert_ephemeral_db

iterations="${CONCURRENCY_ITERATIONS:-1}"
if [[ $# -gt 0 ]]; then files=("$@"); else files=(supabase/tests/*.test.sh); fi
log_dir=$(mktemp -d)
failed=()
summary "### Concurrency tests ($iterations iteration(s) each)" "" "| Test | Run | Result | Seconds |" "|---|---|---|---|"

for file in "${files[@]}"; do
  name=$(basename "$file" .test.sh)
  for ((i = 1; i <= iterations; i++)); do
    log="$log_dir/$name.$i.log"
    before=$(db_snapshot)
    start=$SECONDS
    bash "$file" > "$log" 2>&1
    rc=$?
    took=$((SECONDS - start))
    after=$(db_snapshot)
    reason=""
    if [[ $rc -ne 0 ]]; then reason="exit $rc"
    elif [[ "$before" != "$after" ]]; then reason="left rows behind"
    fi
    if [[ -z "$reason" ]]; then
      echo "PASS  ${took}s  $name (run $i/$iterations)"
      summary "| $name | $i | pass | $took |"
    else
      echo "FAIL  ${took}s  $name (run $i/$iterations: $reason)"
      echo "::error file=$file::$name run $i failed: $reason"
      echo "::group::$name run $i output"
      cat "$log"
      if [[ "$reason" == "left rows behind" ]]; then
        diff <(echo "$before") <(echo "$after")
      fi
      echo "::endgroup::"
      summary "| $name | $i | **FAIL** ($reason) | $took |"
      failed+=("$name#$i")
    fi
  done
done

echo
echo "${#files[@]} concurrency tests x $iterations, ${#failed[@]} failed run(s)."
if [[ ${#failed[@]} -gt 0 ]]; then
  printf '  - %s\n' "${failed[@]}"
  exit 1
fi
