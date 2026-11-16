#!/usr/bin/env bash
# End-to-end authenticated smoke test against a running 5cycle server.
# Usage: ./scripts/smoke.sh [base-url] [email] [password]
set -uo pipefail
BASE="${1:-http://localhost:3000}"
EMAIL="${2:-qa@5cycle.app}"
PASS="${3:-qa-claremont5}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

code() { curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -c "$JAR" "$BASE$1"; }
follow() { curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -c "$JAR" -L "$BASE$1"; }

echo "== login $EMAIL at $BASE"
LOC=$(curl -s -D - -o /tmp/smoke-login.json -b "$JAR" -c "$JAR" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  "$BASE/api/auth/login" | tr -d '\r')
echo "$LOC" | grep -iE '^(HTTP/|location:|set-cookie:)' | sed 's/\(cycle_session=[^.;]\{12\}\).*/\1.../'
echo "body: $(cat /tmp/smoke-login.json)"

echo
echo "== authenticated routes (expect 200, not a 3xx to /login)"
for p in /planner /profile /requirements /catalog / /admin /professors; do
  printf '  %-14s %s\n' "$p" "$(code "$p")"
done

echo
echo "== unauthenticated browse check (fresh jar: guests can view the planner)"
RAW=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/planner")
echo "  /planner (no cookie) -> $RAW (expect 200: guest browsing)"
RAW2=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE/profile")
echo "  /profile (no cookie) -> $RAW2 (expect 3xx to /login: still private)"
