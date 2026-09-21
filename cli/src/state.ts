// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

// Session state: which parties this run is using. Not ground truth.
// Every command may read this.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Resolved on every call rather than at import time, so the eval driver can
 * point successive runs at their own directories in one process.
 */
export function visumDir(): string {
  return process.env.VISUM_DIR ?? ".visum";
}

function statePath(): string {
  return join(visumDir(), "state.json");
}

export type VisumState = {
  scopeTag: string;
  operator: string;
  auditor: string;
  counterparties: string[];
};

export function writeState(s: VisumState): void {
  const p = statePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(s, null, 2)}\n`);
}

export function readState(): VisumState {
  const p = statePath();
  if (!existsSync(p)) {
    throw new Error(`no ${p}; run \`visum seed\` first`);
  }
  return JSON.parse(readFileSync(p, "utf8")) as VisumState;
}
