// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

// The answer key.
//
// `visum seed` writes this file. `visum verify` reads it. NOTHING ELSE MAY
// TOUCH IT -- above all not `visum prove`, whose whole claim is that it
// derived its numbers from the ledger.
//
// That rule is enforced mechanically, not by comment: scripts/check-isolation.sh
// fails the build if any module other than cmd/seed.ts and cmd/verify.ts
// imports this one, and scripts/run-eval.sh runs that check before the eval.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { visumDir } from "./state.ts";

function gtPath(): string {
  return join(visumDir(), "ground-truth.json");
}

export type GroundTruth = {
  seed: number;
  scopeTag: string;
  total: number;
  hidden: number;
  visible: number;
  counterparties: { party: string; total: number; hidden: number }[];
};

export function writeGroundTruth(gt: GroundTruth): void {
  const p = gtPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(gt, null, 2)}\n`);
}

export function readGroundTruth(): GroundTruth {
  return JSON.parse(readFileSync(gtPath(), "utf8")) as GroundTruth;
}

export function groundTruthPath(): string {
  return gtPath();
}
