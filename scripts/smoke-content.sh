#!/usr/bin/env bash
# Content-level smoke test: login, then assert the important UI actually
# renders real data on each authenticated page.
#   ./scripts/smoke-content.sh [base] [email] [pass]
set -uo pipefail
BASE="${1:-http://localhost:3000}"
EMAIL="${2:-qa@5cycle.app}"
PASS="${3:-qa-claremont5}"
JAR=$(mktemp); BODY=$(mktemp);trap 'rm -f "$JAR" "$BODY"' EXIT

curl -s -o /dev/null -b "$JAR" -c "$JAR" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" "$BASE/api/auth/login"

fail=0
check() { # path needle...
  local p="$1"; shift
  local code; code=$(curl -s -o "$BODY" -w '%{http_code}' -b "$JAR" -c "$JAR" "$BASE$p")
  local miss=""
  for n in "$@"; do grep -qi -- "$n" "$BODY" || miss="$miss [$n]"; done
  if [ "$code" = "200" ] && [ -z "$miss" ]; then
    printf '  PASS  %-46s %s\n' "$p" "$(wc -c <"$BODY" | tr -d ' ') bytes"
  else
    printf '  FAIL  %-46s %s %s\n' "$p" "http=$code" "$miss"
    fail=$((fail+1))
  fi
}

echo "== authenticated pages (200 + expected content)"
check "/planner"                     "Timetable" "Saved courses\|Your plan" "perm"
check "/planner?term=SP2027"         "FWS-010\|SP2027"
check "/requirements"                "CMC General Education\|General Education" "satisfied\|not met"
check "/profile"                     "QA Test Student\|Account" "Economics\|major"
check "/professors"                  "professor"
check "/catalog?term=SP2027&school=CM" "cred"

echo
echo "== public pages"
curl -s -o "$BODY" -w '  %{http_code}  / (%{size_download} bytes)\n' "$BASE/"
curl -s -o "$BODY" -w '  %{http_code}  /login (%{size_download} bytes)\n' "$BASE/login"
curl -s -o "$BODY" -w '  %{http_code}  /signup (%{size_download} bytes)\n' "$BASE/signup"

echo
echo "== authenticated section detail (real SP2027 section)"
SID=$(node scripts/probe.mjs "SELECT id FROM sections WHERE term_id='SP2027' AND school='CM' LIMIT 1" 2>/dev/null | grep -o '"id": "[^"]*"' | head -1 | cut -d'"' -f4)
echo "  section: ${SID:-<none>}"
if [ -n "${SID:-}" ]; then
  check "/section/$SID" "Description\|No description" "Credits\|cred" "perm\|Perm"
fi

echo
echo "== a course that needs a cross-registration perm (non-CMC taug in CMC plan context)"
PSID=$(node scripts/probe.mjs "SELECT id FROM sections WHERE term_id='SP2027' AND perm_count>0 LIMIT 1" 2>/dev/null | grep -o '"id": "[^"]*"' | head -1 | cut -d'"' -f4)
echo "  section: ${PSID:-<none>}"
[ -n "${PSID:-}" ] && check "/section/$PSID" "perm"

echo
echo "== professor detail"
PID=$(node scripts/probe.mjs "SELECT id FROM instructor_ratings WHERE section_count>0 LIMIT 1" 2>/dev/null | grep -o '"id": "[^"]*"' | head -1 | cut -d'"' -f4)
echo "  instructor: ${PID:-<none>}"
[ -n "${PID:-}" ] && check "/professors/$PID" "rate\|Rate"

echo
[ $fail -eq 0 ] && echo "ALL CONTENT CHECKS PASSED" || echo "$fail CONTENT CHECK(S) FAILED"
exit $fail
