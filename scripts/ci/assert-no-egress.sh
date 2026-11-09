#!/usr/bin/env bash
# Fails if any outbound HTTP request made by the CI database (pg_net) got an
# HTTP response, i.e. reached a server. With the runner's egress block every
# request must end with a connection error and no status code.
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/ci/db-common.sh

if ! docker inspect "$DB_CONTAINER" > /dev/null 2>&1; then
  echo "No database container; nothing to check."
  exit 0
fi
db_psql -At -c "select coalesce(status_code::text, 'no-status') || ' x' || count(*) from net._http_response group by status_code"
reached=$(db_psql -Atc "select count(*) from net._http_response where status_code is not null")
if [[ "$reached" != "0" ]]; then
  echo "::error::$reached outbound HTTP request(s) from the CI database reached a server." >&2
  db_psql -Atc "select id, status_code, created from net._http_response where status_code is not null order by id"
  exit 1
fi
echo "OK: no outbound request from the CI database reached any server."
