#!/bin/sh
# Acceptance test for the live demo.
#
# curl alone is NOT an acceptance test for a page: curl does not enforce CSP,
# so a `default-src 'none'` with no connect-src looks perfectly healthy to
# curl while every real browser refuses the page's own fetch. That exact bug
# shipped once. Hence two checks: the header, and a real browser that clicks
# the button and reads the rendered ratio out of the DOM.
#
#   ./scripts/check-live.sh [url]
set -eu

URL="${1:-https://visum.ochinimus.app}"
FAIL=0

say() { printf '%s\n' "$*"; }
ok()   { say "  PASS  $*"; }
bad()  { say "  FAIL  $*"; FAIL=1; }

say "== 1. headers =="
HDRS=$(curl -sS -D - -o /dev/null --max-time 20 "$URL/")
CSP=$(printf '%s' "$HDRS" | tr -d '\r' | sed -n 's/^[Cc]ontent-[Ss]ecurity-[Pp]olicy: //p')

if [ -z "$CSP" ]; then
  bad "no Content-Security-Policy header at all"
else
  say "  CSP: $CSP"
  # The bug: connect-src absent means it inherits default-src 'none' and the
  # page cannot call its own API.
  if printf '%s' "$CSP" | grep -q "connect-src 'self'"; then
    ok "connect-src 'self' present"
  else
    bad "connect-src 'self' MISSING -- the button will be dead in every browser"
  fi
  printf '%s' "$CSP" | grep -q "frame-ancestors 'none'" && ok "frame-ancestors 'none'" || bad "frame-ancestors missing"
  printf '%s' "$CSP" | grep -q "base-uri 'none'" && ok "base-uri 'none'" || bad "base-uri missing"
fi

say "== 2. the ledger API must not be reachable through the hostname =="
for p in /v2/version /v2/parties /v2/dars; do
  C=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$URL$p")
  [ "$C" = "404" ] && ok "$p -> 404" || bad "$p -> $C (expected 404)"
done

say "== 3. real browser: click the button, read the rendered ratio =="
if [ -f "$(dirname "$0")/../cli/node_modules/playwright/package.json" ]; then
  ( cd "$(dirname "$0")/.." && node cli/src/demo/browser-check.ts "$URL" ) || FAIL=1
else
  bad "playwright not installed (cd cli && npm i -D playwright && npx playwright install chromium)"
fi

say ""
if [ "$FAIL" -eq 0 ]; then say "LIVE CHECK PASSED"; else say "LIVE CHECK FAILED"; fi
exit "$FAIL"
