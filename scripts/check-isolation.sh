#!/bin/sh
# The prover must not read the answer key.
#
# `visum prove` claims its numbers came off the ledger. This check makes that
# claim mechanical: only cmd/seed.ts (which writes ground truth) and
# cmd/verify.ts (which compares against it) may reference the groundtruth
# module. Anything else importing it fails the build.
set -eu

CLI_SRC="$(dirname "$0")/../cli/src"
STATUS=0

OFFENDERS=$(
  grep -rlE "from \"[^\"]*groundtruth\.ts\"|require\(['\"][^'\"]*groundtruth" "$CLI_SRC" 2>/dev/null \
    | grep -vE "/(groundtruth|eval)\.ts$" \
    | grep -vE "/cmd/(seed|verify)\.ts$" \
    || true
)

if [ -n "$OFFENDERS" ]; then
  echo "ISOLATION VIOLATION: these modules import the ground-truth answer key:" >&2
  echo "$OFFENDERS" | sed 's/^/  /' >&2
  STATUS=1
fi

# Belt and braces: the prover must not read the file by path either.
PATHREF=$(grep -rlE "ground-truth" "$CLI_SRC/cmd/prove.ts" "$CLI_SRC/api.ts" "$CLI_SRC/model.ts" "$CLI_SRC/scope.ts" 2>/dev/null || true)
if [ -n "$PATHREF" ]; then
  echo "ISOLATION VIOLATION: prover-side modules mention the ground-truth file:" >&2
  echo "$PATHREF" | sed 's/^/  /' >&2
  STATUS=1
fi

if [ "$STATUS" -eq 0 ]; then
  echo "isolation OK: the prover does not reach the answer key"
fi
exit "$STATUS"
