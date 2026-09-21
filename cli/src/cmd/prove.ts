// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

// The prover.
//
// This module does not import ../groundtruth.ts and must never do so. Its
// entire claim is that these numbers came off the ledger.
// scripts/check-isolation.sh fails the build if that import appears.

import { createContracts, isStakeholder, ledgerEnd, T } from "../api.ts";
import { asInt, attestedFloorFrom, coverageRatio, damlInt } from "../model.ts";
import { readScope } from "../scope.ts";
import { readState } from "../state.ts";
import { short } from "./attest.ts";

export async function prove(): Promise<void> {
  const st = readState();
  const offset = await ledgerEnd();
  const { settlements, scopes, attestations } = await readScope(st.operator, st.scopeTag, offset);

  // The numerator: settlements on which the auditor was actually made a
  // stakeholder, read off each created event's own signatories and observers.
  const auditorVisible = settlements.filter(({ event }) => isStakeholder(st.auditor, event)).length;

  // The operator's claim.
  const declaredTotal = scopes.reduce((m, s) => Math.max(m, asInt(s.payload.declaredTotal)), 0);
  const scopeHash = scopes[0]?.payload.scopeHash ?? "";
  const expectedAttestors = [
    ...new Set(scopes.flatMap((s) => s.payload.expectedAttestors)),
  ].sort();

  // What the counterparties signed for.
  const claims = attestations.map(({ payload }) => ({
    attestor: payload.attestor,
    seenCount: asInt(payload.seenCount),
  }));
  const attestedFloor = attestedFloorFrom(claims);
  const attestors = [...new Set(claims.map((c) => c.attestor))].sort();

  const ratio = coverageRatio(declaredTotal, attestedFloor, auditorVisible);

  await createContracts(st.operator, [
    {
      templateId: T.CoverageProof,
      createArguments: {
        prover: st.operator,
        operator: st.operator,
        auditor: st.auditor,
        scopeTag: st.scopeTag,
        scopeHash,
        declaredTotal: damlInt(declaredTotal),
        attestedFloor: damlInt(attestedFloor),
        auditorVisible: damlInt(auditorVisible),
        ratio,
        attestors,
        expectedAttestors,
        attestorCount: damlInt(attestors.length),
        expectedAttestorCount: damlInt(expectedAttestors.length),
        computedAt: new Date().toISOString(),
      },
    },
  ]);

  console.log(`proved scope "${st.scopeTag}"`);
  console.log(`  auditorVisible ${auditorVisible}`);
  console.log(`  declaredTotal  ${declaredTotal}`);
  console.log(`  attestedFloor  ${attestedFloor}`);
  console.log(`  ratio          ${ratio}`);
  console.log(
    `  attested by    ${attestors.length} of ${expectedAttestors.length}` +
      (attestors.length > 0 ? ` (${attestors.map(short).join(", ")})` : ""),
  );
  if (attestedFloor > declaredTotal) {
    console.log(
      `  CONCEALMENT SIGNAL: counterparties signed for ${attestedFloor}, ` +
        `operator declared ${declaredTotal}`,
    );
  }
}
