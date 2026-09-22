// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

import { createContracts, ensureParties, T } from "../api.ts";
import { damlInt } from "../model.ts";
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

  // Amounts are deliberately uneven, in minor units. Flat amounts would make
  // value coverage a restatement of count coverage and prove nothing; a
  // heavy-tailed spread is also closer to a real settlement book.
  const amountFor = (i: number): number => {
    const tail = rnd();
    const base = tail > 0.92 ? 5_000_00 + Math.floor(rnd() * 9_500_000) : 50_00 + Math.floor(rnd() * 250_000);
    return base + i;
  };

  // Round-robin the settlements over the counterparties.
  const perCp = counterparties.map((party) => ({ party, total: 0, hidden: 0, value: 0, hiddenValue: 0 }));
  const creates = Array.from({ length: opts.n }, (_, i) => {
    const slot = i % counterparties.length;
    const cp = counterparties[slot]!;
    const isHidden = withheld.has(i);
    const amount = amountFor(i);
    perCp[slot]!.total += 1;
    perCp[slot]!.value += amount;
    if (isHidden) {
      perCp[slot]!.hidden += 1;
      perCp[slot]!.hiddenValue += amount;
    }
    return {
      templateId: T.Settlement,
      createArguments: {
        operator,
        counterparty: cp,
        payload: `${opts.scopeTag}-settlement-${i + 1}`,
        scopeTag: opts.scopeTag,
        amount: damlInt(amount),
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

  const totalValue = perCp.reduce((a, c) => a + c.value, 0);
  const hiddenValue = perCp.reduce((a, c) => a + c.hiddenValue, 0);
  const gt: GroundTruth = {
    seed: opts.seedNum,
    scopeTag: opts.scopeTag,
    total: opts.n,
    hidden,
    visible: opts.n - hidden,
    totalValue,
    hiddenValue,
    visibleValue: totalValue - hiddenValue,
    counterparties: perCp,
  };
  writeGroundTruth(gt);

  console.log(
    `seeded ${opts.n} settlements in scope "${opts.scopeTag}" over ${counterparties.length} ` +
      `counterparties; ${hidden} withheld from the auditor`,
  );
}
