#!/usr/bin/env bash
# Static guard for the CI quality gate:
#   1. No credential files are tracked by git.
#   2. CI definitions (.github/, scripts/ci/) never use repository secrets,
#      never link/push to a hosted Supabase project and never contain a
#      hosted database or project URL. CI must stay isolated from Staging
#      and Production.
set -euo pipefail
cd "$(dirname "$0")/../.."
status=0

tracked=$(git ls-files | grep -iE '(^|/)\.env($|\.)|\.(p8|p12|jks|keystore|mobileprovision|pem)$|(^|/)google-services\.json$|(^|/)GoogleService-Info\.plist$|service[-_]account.*\.json$' \
  | grep -vE '(^|/)\.env\.example$' || true)
if [[ -n "$tracked" ]]; then
  echo "::error::Credential-like files are tracked by git:" >&2
  echo "$tracked" >&2
  status=1
fi

# Comment lines are ignored so the files may explain what they avoid.
ci_files=$(git ls-files .github scripts/ci | grep -v '^scripts/ci/check-ci-isolation.sh$')
pattern='secrets\.|supabase +(link|db +push|db +remote|functions +deploy|secrets +set)|--db-url|--linked|\.supabase\.co|\.pooler\.supabase\.com|SERVICE_ROLE|SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD|PGPASSWORD|postgres(ql)?://'
hits=$(for f in $ci_files; do grep -nEH "$pattern" "$f" | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true; done)
if [[ -n "$hits" ]]; then
  echo "::error::CI definitions reference secrets or a hosted environment:" >&2
  echo "$hits" >&2
  status=1
fi

if [[ $status -eq 0 ]]; then
  echo "OK: no tracked credential files; CI uses no secrets and no hosted environment."
fi
exit $status
