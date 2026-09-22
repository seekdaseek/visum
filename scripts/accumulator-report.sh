#!/bin/sh
# Summarise the append-only acceptance record.
#
#   ./scripts/accumulator-report.sh [file]
set -eu
FILE="${1:-eval/accumulator.jsonl}"
[ -f "$FILE" ] || { echo "no accumulator file at $FILE" >&2; exit 1; }

node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean);
if (lines.length === 0) { console.log("empty"); process.exit(0); }

let scopes = 0, settlements = 0, withheld = 0, visible = 0;
let matches = 0, mismatches = 0, value = 0, visValue = 0, ms = 0;
let first = null, last = null;
const srcCount = {}, vsrcCount = {};
const bad = [];

for (const l of lines) {
  let r; try { r = JSON.parse(l); } catch { continue; }
  scopes++;
  settlements += r.settlements;
  withheld += r.withheld;
  visible += r.visible;
  value += r.attestedValue ?? 0;
  visValue += r.visibleValue ?? 0;
  ms += r.elapsedMs ?? 0;
  if (r.verdict === "match") matches++; else { mismatches++; bad.push(r); }
  srcCount[r.denominatorSource] = (srcCount[r.denominatorSource] ?? 0) + 1;
  vsrcCount[r.valueDenominatorSource] = (vsrcCount[r.valueDenominatorSource] ?? 0) + 1;
  const t = Date.parse(r.ts);
  if (first === null || t < first) first = t;
  if (last === null || t > last) last = t;
}

const days = (last - first) / 86400000;
const fmt = (n) => n.toLocaleString("en-US");

console.log("visum acceptance accumulator");
console.log("============================");
console.log("");
console.log(`  scopes proved      : ${fmt(scopes)}`);
console.log(`  settlements        : ${fmt(settlements)}`);
console.log(`  withheld from auditor: ${fmt(withheld)}`);
console.log(`  auditor-visible    : ${fmt(visible)}`);
console.log(`  value attested     : ${fmt(value)} minor units`);
console.log(`  value auditor-visible: ${fmt(visValue)} minor units`);
console.log("");
console.log(`  MISMATCHES         : ${mismatches}`);
console.log(`  matches            : ${fmt(matches)}`);
console.log("");
console.log(`  first iteration    : ${new Date(first).toISOString()}`);
console.log(`  last iteration     : ${new Date(last).toISOString()}`);
console.log(`  span               : ${days.toFixed(2)} days`);
console.log(`  mean iteration     : ${(ms / scopes / 1000).toFixed(2)}s`);
console.log("");
console.log(`  count denominator  : ${Object.entries(srcCount).map(([k, v]) => k + "=" + v).join("  ")}`);
console.log(`  value denominator  : ${Object.entries(vsrcCount).map(([k, v]) => k + "=" + v).join("  ")}`);
if (bad.length) {
  console.log("");
  console.log("  MISMATCH DETAIL:");
  for (const r of bad.slice(0, 20)) console.log("    " + JSON.stringify(r));
}
' "$FILE"
