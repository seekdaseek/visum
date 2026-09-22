// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

// Archive everything a scope created, so a long-lived sandbox does not
// accumulate an ever-growing active contract set. Shared by the live demo and
// the accumulator.

import { activeContracts, archiveContracts, isTemplate, ledgerEnd, T } from "../api.ts";
import type { PartyAttestationPayload } from "../model.ts";
import type { VisumState } from "../state.ts";

export async function sweepScope(scopeTag: string, st: VisumState): Promise<void> {
  const offset = await ledgerEnd();
  const parties = [st.operator, ...st.counterparties];

  for (const party of parties) {
    const events = await activeContracts(party, offset);
    const mine = events.filter((e) => {
      const a = e.createArgument as { scopeTag?: string } | undefined;
      return a?.scopeTag === scopeTag;
    });

    // The operator archives what it signed; each attestor archives its own.
    const opOwned = mine.filter(
      (e) =>
        isTemplate(e, T.Settlement) ||
        isTemplate(e, T.ScopeStatement) ||
        isTemplate(e, T.CoverageProof),
    );
    const attested = mine.filter((e) => isTemplate(e, T.PartyAttestation));

    if (party === st.operator && opOwned.length > 0) {
      await archiveContracts(
        st.operator,
        opOwned.map((e) => ({ templateId: e.templateId, contractId: e.contractId })),
      );
    }
    for (const e of attested) {
      const a = e.createArgument as PartyAttestationPayload;
      if (a.attestor === party) {
        await archiveContracts(party, [{ templateId: e.templateId, contractId: e.contractId }]);
      }
    }
  }
}
