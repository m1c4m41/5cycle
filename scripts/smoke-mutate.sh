#!/usr/bin/env bash
# Prove the HTTP write path works: POST a real Server Action (no-JS fallback
# form) and confirm the change lands in SQLite, then revert it.
set -uo pipefail
BASE="http://localhost:3000"
JAR=$(mktemp); trap 'rm -f "$JAR"' EXIT

curl -s -o /dev/null -c "$JAR" -H 'content-type: application/json' \
  -d '{"email":"qa@5cycle.app","password":"qa-claremont5"}' "$BASE/api/auth/login"

# A course the QA student actually has planned (ownership-checked by the server).
SEC=$(node scripts/probe.mjs "SELECT section_id FROM enrollments e WHERE e.term_id='SP2027' AND e.user_id=(SELECT id FROM users WHERE email='qa@5cycle.app') LIMIT 1" 2>/dev/null \
      | grep -o '"section_id": "[^"]*"' | head -1 | cut -d'"' -f4)
echo "target section: $SEC"
before=$(node scripts/probe.mjs "SELECT status FROM enrollments WHERE section_id='$SEC'" 2>/dev/null | grep -o '"status": "[^"]*"' | cut -d'"' -f4)
echo "status before : $before"

# Scrape the action id for the status-change form straight out of the rendered page.
curl -s -b "$JAR" "$BASE/planner?term=SP2027" -o /tmp/mut.html
AID=$(grep -oE 'ACTION_ID_[a-f0-9]+' /tmp/mut.html | sort -u | while read -r a; do
        # pick the action whose form carries a status <select>
        python3 - "$a" <<'PY'
import re,sys
h=open('/tmp/mut.html').read()
aid=sys.argv[1]
for m in re.finditer(r'<form[^>]*>(.*?)</form>', h, re.S):
    if aid in m.group(1) and 'name="status"' in m.group(1):
        print(aid); break
PY
      done | head -1)
echo "action id     : ${AID:-<not found>}"
[ -z "${AID:-}" ] && { echo "could not locate the status server action"; exit 1; }

echo
echo "== POST status -> waitlist"
curl -s -o /tmp/mut-out.html -w 'http=%{http_code}\n' -b "$JAR" -c "$JAR" \
  -F "\$${AID}=" -F "sectionId=$SEC" -F "status=waitlist" -F "next=/planner" \
  "$BASE/planner"

after=$(node scripts/probe.mjs "SELECT status FROM enrollments WHERE section_id='$SEC'" 2>/dev/null | grep -o '"status": "[^"]*"' | cut -d'"' -f4)
echo "status after  : $after"
if [ "$after" = "waitlist" ]; then echo "  PASS  server-action write persisted to SQLite"; else echo "  FAIL  write did not land"; fi

echo
echo "== revert -> $before"
curl -s -o /dev/null -b "$JAR" -c "$JAR" \
  -F "\$${AID}=" -F "sectionId=$SEC" -F "status=$before" -F "next=/planner" "$BASE/planner"
done_=$(node scripts/probe.mjs "SELECT status FROM enrollments WHERE section_id='$SEC'" 2>/dev/null | grep -o '"status": "[^"]*"' | cut -d'"' -f4)
echo "status now    : $done_"
[ "$done_" = "$before" ] && echo "  PASS  reverted" || echo "  WARN  revert left it at $done_"

echo
echo "== guard: mutation without a session cookie must not write"
code=$(curl -s -o /dev/null -w '%{http_code}' -F "\$${AID}=" -F "sectionId=$SEC" -F "status=waitlist" -F "next=/planner" "$BASE/planner")
echo "  anonymous POST -> http $code (expect 3xx redirect to /login)"
still=$(node scripts/probe.mjs "SELECT status FROM enrollments WHERE section_id='$SEC'" 2>/dev/null | grep -o '"status": "[^"]*"' | cut -d'"' -f4)
echo "  status unchanged: $still"
[ "$still" = "$before" ] && echo "  PASS  anonymous mutation rejected" || echo "  FAIL  anonymous mutation applied!"

echo
echo "== guest add flow: catalog Add -> login?add= -> signup completes the add"
JAR2=$(mktemp); trap 'rm -f "$JAR" "$JAR2"' EXIT
curl -s -o /tmp/guest-catalog.html -c "$JAR2" "$BASE/catalog?term=SP2027"
# EnrollButton is a client component: its no-JS form carries the server action
# as $ACTION_REF/$ACTION_N hidden inputs (not an ACTION_ID in the form tag).
# Replay the first such form, swapping in the target section.
python3 - /tmp/guest-catalog.html /tmp/guest-add-fields.tsv <<'PY'
import re, html, sys
h = open(sys.argv[1]).read()
for m in re.finditer(r'<form[^>]*>(.*?)</form>', h, re.S):
    if 'name="sectionId"' in m.group(1):
        fields = re.findall(r'<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?', m.group(1))
        with open(sys.argv[2], "w") as out:
            for name, val in fields:
                out.write(f"{name}\t{html.unescape(val or '')}\n")
        break
else:
    sys.exit(1)
PY
echo "  catalog add action: $(grep -c 'ACTION_REF' /tmp/guest-add-fields.tsv 2>/dev/null || echo 0) action ref(s) in rendered form"
if [ -s /tmp/guest-add-fields.tsv ]; then
  CURL_FIELDS=()
  while IFS=$'\t' read -r fname fval; do
    [ "$fname" = "sectionId" ] && fval="$SEC"
    CURL_FIELDS+=(-F "$fname=$fval")
  done < /tmp/guest-add-fields.tsv
  GLOC=$(curl -s -D - -o /dev/null -b "$JAR2" -c "$JAR2" \
    "${CURL_FIELDS[@]}" \
    "$BASE/catalog?term=SP2027" | tr -d '\r' | grep -i '^location:' | sed 's/^[Ll]ocation: //')
  echo "  guest add redirected -> $GLOC"
  case "$GLOC" in
    /login*add=$SEC*) echo "  PASS  guest add bounced to /login carrying the pending course" ;;
    *) echo "  FAIL  pending add not carried to /login" ;;
  esac

  PEMAIL="probe-guest-$(date +%s)@5cycle.app"
  curl -s -o /tmp/guest-signup.html -c "$JAR2" "$BASE/signup?add=$SEC&next=/planner"
  echo "  signup page shows pending notice: $(grep -c "$SEC" /tmp/guest-signup.html)"
  SAID=$(grep -oE 'ACTION_ID_[a-f0-9]+' /tmp/guest-signup.html | sort -u | while read -r a; do
          python3 - "$a" /tmp/guest-signup.html <<'PY'
import re,sys
h=open(sys.argv[2]).read()
aid=sys.argv[1]
for m in re.finditer(r'<form[^>]*>(.*?)</form>', h, re.S):
    if aid in m.group(1) and 'name="email"' in m.group(1):
        print(aid); break
PY
        done | head -1)
  SLOC=$(curl -s -D - -o /dev/null -b "$JAR2" -c "$JAR2" \
    -F "\$${SAID}=" -F "name=Guest Flow Probe" -F "email=$PEMAIL" -F "password=probe-claremont5" \
    -F "school=CM" -F "gradYear=2028" -F "add=$SEC" -F "next=/planner" \
    "$BASE/signup" | tr -d '\r' | grep -i '^location:' | sed 's/^[Ll]ocation: //')
  echo "  signup redirected -> $SLOC"
  case "$SLOC" in
    *welcome=1*ok=*) echo "  PASS  signup carried the pending add through" ;;
    *welcome=1*) echo "  WARN  signed up but no add notice: $SLOC" ;;
    *) echo "  FAIL  unexpected signup destination: $SLOC" ;;
  esac
  added=$(node scripts/probe.mjs "SELECT COUNT(*) n FROM enrollments e JOIN users u ON u.id=e.user_id WHERE u.email='$PEMAIL' AND e.section_id='$SEC'" 2>/dev/null | grep -o '"n": [0-9]*' | grep -o '[0-9]*')
  echo "  enrollments in new account: ${added:-0}"
  [ "$added" = "1" ] && echo "  PASS  pending course landed in the freshly created account" || echo "  FAIL  course missing from new account"
  node scripts/cleanup-probe.mjs >/dev/null 2>&1 || true

  echo
  echo "== login path: returning guest's pending add completes on login"
  PEMAIL2="probe-login-$(date +%s)@5cycle.app"
  curl -s -o /dev/null -w '  probe2 signup -> http %{http_code}\n' -H 'content-type: application/json' \
    -d "{\"name\":\"Login Path Probe\",\"email\":\"$PEMAIL2\",\"password\":\"probe-claremont5\",\"school\":\"CM\",\"gradYear\":2028}" \
    "$BASE/api/auth/signup"
  curl -s -o /tmp/guest-login.html -c "$JAR2" "$BASE/login?next=/catalog%3Fterm%3DSP2027&add=$SEC"
  echo "  login page shows pending notice: $(grep -c "$SEC" /tmp/guest-login.html)"
  LAID=$(grep -oE 'ACTION_ID_[a-f0-9]+' /tmp/guest-login.html | sort -u | while read -r a; do
          python3 - "$a" /tmp/guest-login.html <<'PY'
import re,sys
h=open(sys.argv[2]).read()
aid=sys.argv[1]
for m in re.finditer(r'<form[^>]*>(.*?)</form>', h, re.S):
    if aid in m.group(1) and 'name="email"' in m.group(1):
        print(aid); break
PY
        done | head -1)
  LLOC=$(curl -s -D - -o /dev/null -b "$JAR2" -c "$JAR2" \
    -F "\$${LAID}=" -F "email=$PEMAIL2" -F "password=probe-claremont5" \
    -F "add=$SEC" -F "next=/catalog?term=SP2027" \
    "$BASE/login" | tr -d '\r' | grep -i '^location:' | sed 's/^[Ll]ocation: //')
  echo "  login redirected -> $LLOC"
  case "$LLOC" in
    /catalog*ok=*) echo "  PASS  login carried the pending add through to the catalog notice" ;;
    *) echo "  FAIL  pending add not applied on login: $LLOC" ;;
  esac
  added2=$(node scripts/probe.mjs "SELECT COUNT(*) n FROM enrollments e JOIN users u ON u.id=e.user_id WHERE u.email='$PEMAIL2' AND e.section_id='$SEC'" 2>/dev/null | grep -o '"n": [0-9]*' | grep -o '[0-9]*')
  echo "  enrollments in login account: ${added2:-0}"
  [ "$added2" = "1" ] && echo "  PASS  pending course landed via the login path" || echo "  FAIL  course missing after login"
  node scripts/cleanup-probe.mjs >/dev/null 2>&1 || true
else
  echo "  FAIL  could not locate the guest add action on /catalog"
fi
