// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

// The acceptance run: twenty seeds, randomised hide counts, exact match or
// the whole run fails.
//
// Exactness is claimed on the INTEGERS. Ratios are compared as Numeric
// against Numeric computed the same way. No IEEE-754 double is parsed from
// either side at any point -- see NOTES.md.

import { join } from "node:path";
import { attest } from "./cmd/attest.ts";
import { declare } from "./cmd/declare.ts";
import { prove } from "./cmd/prove.ts";
import { seed } from "./cmd/seed.ts";
import { verify, type VerifyResult } from "./cmd/verify.ts";

/**
 * Settlement counts for the twenty runs.
 *
 * Deliberately awkward. At n=100 every ratio is x/100 and terminates in two
 * decimal places, which would exercise none of the Numeric 10 rounding the
 * ledger enforces through CoverageProof's ensure clause. Primes and other
 * non-terminating denominators are the point.
 */
const RUN_SIZES = [
  100, 7, 13, 30, 41, 97, 3, 60, 11, 23, 101, 17, 64, 29, 53, 19, 83, 37, 71, 100,
];

const COUNTERPARTIES = [3, 1, 2, 3, 4, 3, 1, 5, 2, 3, 4, 2, 3, 3, 5, 2, 4, 3, 2, 4];

type Row = VerifyResult & { run: number; n: number };

async function main(): Promise<number> {
  const base = process.env.VISUM_EVAL_DIR ?? ".visum/eval";
  const rows: Row[] = [];

  for (let i = 0; i < RUN_SIZES.length; i++) {
    const run = i + 1;
    const n = RUN_SIZES[i]!;
    const cps = Math.min(COUNTERPARTIES[i]!, n);
    const seedNum = 1000 + run;
    const scopeTag = `eval-${String(run).padStart(2, "0")}`;

    // Each run gets its own state and its own ground truth on disk.
    process.env.VISUM_DIR = join(base, `run-${String(run).padStart(2, "0")}`);

    // Hide count is randomised, derived deterministically from the seed so
    // the whole run reproduces.
    await seed({ n, hide: "random", seedNum, scopeTag, counterparties: cps });
    await declare({});
    await attest({});
    await prove();
    const r = await verify({ quiet: true });
    rows.push({ ...r, run, n });
  }

  printTable(rows);

  const failed = rows.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log("");
    for (const f of failed) {
      console.log(`run ${f.run} (seed ${f.seed}) FAILED:`);
      for (const msg of f.failures) console.log(`    - ${msg}`);
    }
    console.log("");
    console.log(`RESULT: ${failed.length} of ${rows.length} runs did not match ground truth.`);
    return 1;
  }

  console.log("");
  console.log(`RESULT: all ${rows.length} runs matched ground truth exactly, to the event.`);
  return 0;
}

function printTable(rows: Row[]): void {
  const head = [
    "run",
    "seed",
    "n",
    "hidden",
    "declared",
    "attested",
    "visible",
    "published ratio",
    "expected ratio",
    "denominator",
    "value ratio",
    "value denom",
    "match",
  ];
  const body = rows.map((r) => [
    String(r.run),
    String(r.seed),
    String(r.n),
    String(r.hidden),
    String(r.declared),
    String(r.attested),
    String(r.visible),
    r.publishedRatio,
    r.expectedRatio,
    r.denominatorSource,
    r.publishedValueRatio,
    r.valueDenominatorSource,
    r.ok ? "yes" : "NO",
  ]);

  const widths = head.map((h, i) =>
    Math.max(h.length, ...body.map((row) => row[i]!.length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();

  console.log("");
  console.log(line(head));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of body) console.log(line(row));
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`eval: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
