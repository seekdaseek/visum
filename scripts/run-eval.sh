#!/bin/sh
# The acceptance run.
#
# Twenty seeds with randomised hide counts, through seed / declare / attest /
# prove / verify. All twenty must match ground truth exactly, to the event.
# Any mismatch fails the whole run with a non-zero exit. No tolerances.
#
#   ./scripts/run-eval.sh            run it
#   ./scripts/run-eval.sh --keep     leave the sandbox up afterwards
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DAR="$ROOT/main/.daml/dist/visum-0.0.1.dar"
PORTFILE="$ROOT/.visum/eval-ports.json"
LOGFILE="$ROOT/.visum/eval-sandbox.log"
JSON_PORT=${VISUM_JSON_PORT:-7575}
LEDGER_PORT=${VISUM_LEDGER_PORT:-6865}
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

if ! command -v dpm >/dev/null 2>&1; then
  echo "dpm not on PATH. Install it, then: export PATH=\"\$HOME/.dpm/bin:\$PATH\"" >&2
  exit 127
fi

echo "== isolation check =="
"$ROOT/scripts/check-isolation.sh"

echo "== typecheck =="
( cd "$ROOT/cli" && npx --no-install tsc --noEmit )
echo "typecheck OK"

echo "== build DAR =="
( cd "$ROOT" && dpm build --all >/dev/null )
[ -f "$DAR" ] || { echo "no DAR at $DAR" >&2; exit 1; }
echo "built $(basename "$DAR")"

# --- ports must be free before we claim them ------------------------------
for p in "$LEDGER_PORT" "$JSON_PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $p is already in use; stop whatever holds it and retry" >&2
    exit 1
  fi
done

mkdir -p "$ROOT/.visum"
rm -f "$PORTFILE" "$LOGFILE"

SANDBOX_PID=""
cleanup() {
  [ "$KEEP" -eq 1 ] && { echo "sandbox left running on :$JSON_PORT (pid $SANDBOX_PID)"; return; }
  [ -n "$SANDBOX_PID" ] || return
  pkill -TERM -P "$SANDBOX_PID" 2>/dev/null || true
  kill -TERM "$SANDBOX_PID" 2>/dev/null || true
  # A backgrounded JVM can outlive the launcher; make sure it is gone.
  i=0
  while [ $i -lt 10 ]; do
    lsof -nP -iTCP:"$JSON_PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
    sleep 1
    i=$((i + 1))
  done
  if lsof -nP -iTCP:"$JSON_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    pkill -9 -f "canton" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "== start sandbox =="
dpm sandbox --dar "$DAR" --json-api-port "$JSON_PORT" --canton-port-file "$PORTFILE" \
  >"$LOGFILE" 2>&1 &
SANDBOX_PID=$!

# --canton-port-file appears exactly when the sandbox is ready. Never sleep.
i=0
while [ $i -lt 90 ]; do
  [ -f "$PORTFILE" ] && break
  kill -0 "$SANDBOX_PID" 2>/dev/null || { echo "sandbox died during startup:" >&2; tail -20 "$LOGFILE" >&2; exit 1; }
  sleep 1
  i=$((i + 1))
done
[ -f "$PORTFILE" ] || { echo "sandbox did not become ready in ${i}s" >&2; tail -20 "$LOGFILE" >&2; exit 1; }
echo "sandbox ready after ${i}s on :$JSON_PORT"

echo "== twenty runs =="
VISUM_LEDGER="http://localhost:$JSON_PORT" \
VISUM_EVAL_DIR="$ROOT/.visum/eval" \
  node "$ROOT/cli/src/eval.ts"
STATUS=$?

exit "$STATUS"
