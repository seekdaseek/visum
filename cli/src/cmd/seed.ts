// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

import { createContracts, ensureParties, T } from "../api.ts";
import { writeGroundTruth, type GroundTruth } from "../groundtruth.ts";
import { writeState } from "../state.ts";

/** Deterministic RNG so a seed number reproduces a run exactly. */
function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function seed(opts: {
  n: number;
  hide: "random" | number;
  seedNum: number;
  scopeTag: string;
  counterparties: number;
}): Promise<void> {
  const rnd = mulberry32(opts.seedNum);

  const cpHints = Array.from({ length: opts.counterparties }, (_, i) => `cp${i + 1}`);
  const parties = await ensureParties(["operator", "auditor", ...cpHints]);
  const operator = parties["operator"]!;
  const auditor = parties["auditor"]!;
  const counterparties = cpHints.map((h) => parties[h]!);

  // How many to withhold from the auditor.
  const hidden =
    opts.hide === "random" ? Math.floor(rnd() * (opts.n + 1)) : Math.min(opts.hide, opts.n);

  // Which indices are withheld: a shuffled prefix, so concealment is not
  // clustered at the start of the run.
  const idx = Array.from({ length: opts.n }, (_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j]!, idx[i]!];
  }
  const withheld = new Set(idx.slice(0, hidden));

  // Round-robin the settlements over the counterparties.
  const perCp = counterparties.map((party) => ({ party, total: 0, hidden: 0 }));
  const creates = Array.from({ length: opts.n }, (_, i) => {
    const slot = i % counterparties.length;
    const cp = counterparties[slot]!;
    const isHidden = withheld.has(i);
    perCp[slot]!.total += 1;
    if (isHidden) perCp[slot]!.hidden += 1;
    return {
      templateId: T.Settlement,
      createArguments: {
        operator,
        counterparty: cp,
        payload: `${opts.scopeTag}-settlement-${i + 1}`,
        scopeTag: opts.scopeTag,
        disclosed: isHidden ? [] : [auditor],
      },
    };
  });

  // Submit in batches: one command per transaction is slow at n=100, and one
  // transaction for all of them makes a single oversized command.
  const BATCH = 25;
  for (let i = 0; i < creates.length; i += BATCH) {
    await createContracts(operator, creates.slice(i, i + BATCH));
  }

  writeState({ scopeTag: opts.scopeTag, operator, auditor, counterparties });

  const gt: GroundTruth = {
    seed: opts.seedNum,
    scopeTag: opts.scopeTag,
    total: opts.n,
    hidden,
    visible: opts.n - hidden,
    counterparties: perCp,
  };
  writeGroundTruth(gt);

  console.log(
    `seeded ${opts.n} settlements in scope "${opts.scopeTag}" over ${counterparties.length} ` +
      `counterparties; ${hidden} withheld from the auditor`,
  );
}
