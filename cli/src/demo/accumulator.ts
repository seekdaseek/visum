// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

// One acceptance iteration, appended to a file that is never rewritten.
//
// The claim this file exists to support is "N scopes over D days, zero
// mismatches". That is only worth anything if the record is append-only and
// the prover never reads the answer key -- both of which hold here: the
// iteration calls the same seed / declare / attest / prove / verify functions
// the twenty-seed acceptance run uses, and check-isolation.sh fails the build
// if the prover ever imports the ground-truth module.

import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { attest } from "../cmd/attest.ts";
import { declare } from "../cmd/declare.ts";
import { prove } from "../cmd/prove.ts";
import { seed } from "../cmd/seed.ts";
import { verify } from "../cmd/verify.ts";
import { readState } from "../state.ts";
import { sweepScope } from "./sweep.ts";

const LEDGER_FILE =
  process.env.VISUM_ACCUMULATOR_FILE ?? "/opt/visum/eval/accumulator.jsonl";

export type Iteration = {
  ts: string;
  seed: number;
  settlements: number;
  withheld: number;
  visible: number;
  declaredTotal: number;
  attestedFloor: number;
  ratio: string;
  denominatorSource: string;
  attestors: number;
  expectedAttestors: number;
  visibleValue: number;
  attestedValue: number;
  valueRatio: string;
  valueDenominatorSource: string;
  verdict: "match" | "mismatch";
  failures?: string[];
  elapsedMs: number;
};

/** Sizes chosen so most denominators do not terminate in base 10. */
const SIZES = [8, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71, 73, 79, 40, 60, 80];

export async function runIteration(rand: () => number, seedNum: number): Promise<Iteration> {
  const started = Date.now();
  const n = SIZES[Math.floor(rand() * SIZES.length)]!;
  const withheld = 1 + Math.floor(rand() * (n - 1));
  const counterparties = 1 + Math.floor(rand() * 4);
  const scopeTag = `acc-${seedNum}`;

  const dir = mkdtempSync(join(tmpdir(), "visum-acc-"));
  const prevDir = process.env.VISUM_DIR;
  process.env.VISUM_DIR = dir;

  try {
    await quiet(() => seed({ n, hide: withheld, seedNum, scopeTag, counterparties }));
    await quiet(() => declare({}));
    await quiet(() => attest({}));
    await quiet(() => prove());
    const v = await verify({ quiet: true });

    const rec: Iteration = {
      ts: new Date().toISOString(),
      seed: seedNum,
      settlements: n,
      withheld,
      visible: v.visible,
      declaredTotal: v.declared,
      attestedFloor: v.attested,
      ratio: v.publishedRatio,
      denominatorSource: v.denominatorSource,
      attestors: v.attestorCount,
      expectedAttestors: v.expectedAttestorCount,
      visibleValue: v.visibleValue,
      attestedValue: v.attestedValue,
      valueRatio: v.publishedValueRatio,
      valueDenominatorSource: v.valueDenominatorSource,
      verdict: v.ok ? "match" : "mismatch",
      ...(v.ok ? {} : { failures: v.failures }),
      elapsedMs: Date.now() - started,
    };

    // Keep the active contract set flat so a long run does not grow the heap.
    const st = readState();
    await sweepScope(scopeTag, st).catch(() => undefined);

    append(rec);
    return rec;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.VISUM_DIR;
    else process.env.VISUM_DIR = prevDir;
  }
}

/** Append one line. Never rewrite, never reorder, never compact. */
function append(rec: Iteration): void {
  mkdirSync(dirname(LEDGER_FILE), { recursive: true });
  appendFileSync(LEDGER_FILE, `${JSON.stringify(rec)}\n`);
}

export function accumulatorFile(): string {
  return LEDGER_FILE;
}

/** The CLI commands print; the accumulator should not flood the pm2 log. */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const real = console.log;
  console.log = () => undefined;
  try {
    return await fn();
  } finally {
    console.log = real;
  }
}
