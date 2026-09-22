#!/bin/sh
# Pull new accumulator rows from the VPS into the repo and commit them.
#
# Run from the Mac. Deliberately NOT automated on the VPS: that would mean
# putting push credentials on a box that runs 40 other services, and the
# record's integrity does not need them -- the rows carry their own
# timestamps and the commits carry the dates.
#
# APPEND-ONLY IS ENFORCED, not assumed. The local file must be a byte-exact
# prefix of the remote one. If it is not, something rewrote history and this
# refuses rather than papering over it.
set -eu

HOST="${VISUM_HOST:-solwatch}"
REMOTE="${VISUM_REMOTE_FILE:-/opt/visum/eval/accumulator.jsonl}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOCAL="$ROOT/eval/accumulator.jsonl"
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

scp -q "$HOST:$REMOTE" "$TMP"
REMOTE_N=$(wc -l < "$TMP" | tr -d ' ')
LOCAL_N=0
[ -f "$LOCAL" ] && LOCAL_N=$(wc -l < "$LOCAL" | tr -d ' ')

echo "  local $LOCAL_N rows, remote $REMOTE_N rows"

if [ "$REMOTE_N" -lt "$LOCAL_N" ]; then
  echo "REFUSING: the remote has FEWER rows than the local copy. The record is" >&2
  echo "append-only; this means it was truncated or rewritten." >&2
  exit 1
fi

if [ "$LOCAL_N" -gt 0 ]; then
  if ! head -n "$LOCAL_N" "$TMP" | cmp -s - "$LOCAL"; then
    echo "REFUSING: the local file is not a byte-exact prefix of the remote." >&2
    echo "Existing rows were altered. Investigate before committing anything." >&2
    exit 1
  fi
fi

NEW=$((REMOTE_N - LOCAL_N))
if [ "$NEW" -eq 0 ]; then echo "  no new rows"; exit 0; fi

mkdir -p "$ROOT/eval"
tail -n "$NEW" "$TMP" >> "$LOCAL"
echo "  appended $NEW rows -> $REMOTE_N total"

"$ROOT/scripts/accumulator-report.sh" "$LOCAL" | sed 's/^/  /'

cd "$ROOT"
git add eval/accumulator.jsonl
SPAN=$(node -e '
const fs=require("fs");
const L=fs.readFileSync("eval/accumulator.jsonl","utf8").trim().split("\n");
const r=L.map(x=>JSON.parse(x));
const s=r.reduce((a,x)=>a+x.settlements,0);
const bad=r.filter(x=>x.verdict!=="match").length;
console.log(`${r.length} scopes, ${s} settlements, ${bad} mismatches`);
')
git commit -q -m "Accumulator: $SPAN

Appended $NEW iterations. The file is append-only and this commit was
refused unless the existing rows were a byte-exact prefix of the source."
echo "  committed: $SPAN"
