#!/usr/bin/env bash
# Edge Function quality gate (Deno), used by the "Edge Function tests" CI job
# and runnable locally with the same arguments:
#
#   bash scripts/ci/edge-functions.sh cache   # the ONLY step that uses network
#   bash scripts/ci/edge-functions.sh check   # deno check, offline
#   bash scripts/ci/edge-functions.sh test    # deno test, offline, --deny-net
#
# Dependencies are pinned by supabase/functions/tests/deno.lock (--frozen: a
# version that is not in the lockfile fails instead of being resolved anew).
# Update the lockfile deliberately with:
#   bash scripts/ci/edge-functions.sh relock
#
# --no-config: the repo root package.json would otherwise switch Deno into
# node_modules mode (the app's npm tree, not the functions' dependencies).
# Each function's own deno.json only maps "@supabase/functions-js" and
# "@supabase/server", which no source file imports (all imports use explicit
# jsr: specifiers), so ignoring them changes no resolution.
#
# Deno version: CI pins Deno 2.9.7 (the version that wrote the lockfile, format
# v5). The functions themselves run on the Supabase Edge Runtime, which the
# pinned Supabase CLI 2.120.0 ships as supabase/edge-runtime v1.77.4, built on
# Deno 2.1.4 (supabase/config.toml: deno_version = 2). All code here uses only
# APIs available in both (Deno.serve, fetch, Web Crypto, TextEncoder); a
# second job on Deno 2.1.4 would need its own lockfile (2.1.4 predates the v5
# format; not verified locally).
set -euo pipefail
cd "$(dirname "$0")/../.."

LOCK=supabase/functions/tests/deno.lock
COMMON=(--no-config "--lock=$LOCK")

# Portable list collection (macOS ships bash 3.2 without mapfile).
ENTRYPOINTS=(); SHARED=(); TESTS=()
while IFS= read -r f; do ENTRYPOINTS+=("$f"); done < <(find supabase/functions -mindepth 2 -maxdepth 2 -name index.ts | LC_ALL=C sort)
while IFS= read -r f; do SHARED+=("$f"); done < <(find supabase/functions/_shared -name '*.ts' | LC_ALL=C sort)
while IFS= read -r f; do TESTS+=("$f"); done < <(find supabase/functions -name '*.test.ts' | LC_ALL=C sort)

if [[ ${#ENTRYPOINTS[@]} -eq 0 || ${#TESTS[@]} -eq 0 ]]; then
  echo "::error::No Edge Function entrypoints or tests found." >&2
  exit 1
fi

case "${1:-}" in
  cache)
    deno cache "${COMMON[@]}" --frozen "${ENTRYPOINTS[@]}" "${SHARED[@]}" "${TESTS[@]}"
    ;;
  check)
    printf 'deno check (%s files):\n' "$(( ${#ENTRYPOINTS[@]} + ${#SHARED[@]} + ${#TESTS[@]} ))"
    printf '  %s\n' "${ENTRYPOINTS[@]}" "${SHARED[@]}" "${TESTS[@]}"
    deno check "${COMMON[@]}" --frozen --cached-only "${ENTRYPOINTS[@]}" "${SHARED[@]}" "${TESTS[@]}"
    ;;
  test)
    # Least privilege: env (tests set fake Supabase URLs/keys), read only the
    # functions tree (QA-9 source guard); no net, write, run, ffi or sys.
    # Every Supabase/Expo call is answered by a mocked globalThis.fetch.
    deno test "${COMMON[@]}" --frozen --cached-only \
      --allow-env --allow-read=supabase/functions --deny-net \
      "${TESTS[@]}"
    ;;
  relock)
    rm -f "$LOCK"
    deno cache "${COMMON[@]}" "${ENTRYPOINTS[@]}" "${SHARED[@]}" "${TESTS[@]}"
    ;;
  *)
    echo "usage: $0 cache|check|test|relock" >&2
    exit 2
    ;;
esac
