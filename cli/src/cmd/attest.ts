// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

import { createContracts, ledgerEnd, T } from "../api.ts";
import { damlInt } from "../model.ts";
import { readScope } from "../scope.ts";
import { readState } from "../state.ts";

/**
 * A counterparty counts its own settlements and signs for them.
 *
 * The count comes from the counterparty's own ACS. The operator does not
 * supply it and cannot suppress the result, because the counterparty is the
 * signatory on the attestation.
 */
export async function attest(opts: { as?: string }): Promise<void> {
  const st = readState();
  const targets = opts.as ? [resolve(st.counterparties, opts.as)] : st.counterparties;

  const offset = await ledgerEnd();
  for (const cp of targets) {
    const { settlements } = await readScope(cp, st.scopeTag, offset);
    await createContracts(cp, [
      {
        templateId: T.PartyAttestation,
        createArguments: {
          attestor: cp,
          operator: st.operator,
          auditor: st.auditor,
          scopeTag: st.scopeTag,
          seenCount: damlInt(settlements.length),
        },
      },
    ]);
    console.log(`${short(cp)} attested ${settlements.length} settlements`);
  }
}

function resolve(counterparties: string[], hintOrId: string): string {
  const hit = counterparties.find((p) => p === hintOrId || p.startsWith(`${hintOrId}::`));
  if (!hit) {
    throw new Error(
      `no counterparty matching "${hintOrId}"; known: ${counterparties.map(short).join(", ")}`,
    );
  }
  return hit;
}

export function short(p: string): string {
  return p.split("::")[0] ?? p;
}
