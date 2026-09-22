// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

// The prover.
//
// This module does not import ../groundtruth.ts and must never do so. Its
// entire claim is that these numbers came off the ledger.
// scripts/check-isolation.sh fails the build if that import appears.

import { createContracts, isStakeholder, ledgerEnd, T } from "../api.ts";
import {
  asInt,
  attestedFloorFrom,
  coverageRatio,
  damlInt,
  denominatorSourceOf,
} from "../model.ts";
import { readScope } from "../scope.ts";
import { readState } from "../state.ts";
import { short } from "./attest.ts";

export async function prove(): Promise<void> {
  const st = readState();
  const offset = await ledgerEnd();
  const { settlements, scopes, attestations } = await readScope(st.operator, st.scopeTag, offset);

  // The numerator: settlements on which the auditor was actually made a
  // stakeholder, read off each created event's own signatories and observers.
  const visibleToAuditor = settlements.filter(({ event }) => isStakeholder(st.auditor, event));
  const auditorVisible = visibleToAuditor.length;
  // The same stakeholder read, summed over value instead of counted.
  const auditorVisibleValue = visibleToAuditor.reduce((a, { payload }) => a + asInt(payload.amount), 0);

  // The operator's claim.
  const declaredTotal = scopes.reduce((m, s) => Math.max(m, asInt(s.payload.declaredTotal)), 0);
  const declaredValue = scopes.reduce((m, s) => Math.max(m, asInt(s.payload.declaredValue)), 0);
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
  const attestedValueFloor = attestedFloorFrom(
    attestations.map(({ payload }) => ({
      attestor: payload.attestor,
      seenCount: asInt(payload.seenValue),
    })),
  );
  const attestors = [...new Set(claims.map((c) => c.attestor))].sort();

  const ratio = coverageRatio(declaredTotal, attestedFloor, auditorVisible);
  const denominatorSource = denominatorSourceOf(declaredTotal, attestedFloor, auditorVisible);
  const valueRatio = coverageRatio(declaredValue, attestedValueFloor, auditorVisibleValue);
  const valueDenominatorSource = denominatorSourceOf(
    declaredValue,
    attestedValueFloor,
    auditorVisibleValue,
  );

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
        denominatorSource,
        auditorVisibleValue: damlInt(auditorVisibleValue),
        declaredValue: damlInt(declaredValue),
        attestedValueFloor: damlInt(attestedValueFloor),
        valueRatio,
        valueDenominatorSource,
        computedAt: new Date().toISOString(),
      },
    },
  ]);

  console.log(`proved scope "${st.scopeTag}"`);
  console.log(`  auditorVisible ${auditorVisible}`);
  console.log(`  declaredTotal  ${declaredTotal}`);
  console.log(`  attestedFloor  ${attestedFloor}`);
  console.log(`  ratio          ${ratio}`);
  console.log(`  denominator    ${denominatorSource}`);
  console.log(`  value ratio    ${valueRatio}  (${auditorVisibleValue} / ${Math.max(declaredValue, attestedValueFloor, auditorVisibleValue)} minor units)`);
  console.log(`  value denom    ${valueDenominatorSource}`);
  console.log(
    `  attested by    ${attestors.length} of ${expectedAttestors.length}` +
      (attestors.length > 0 ? ` (${attestors.map(short).join(", ")})` : ""),
  );
  if (denominatorSource === "AuditorVisible") {
    console.log("");
    console.log("  UNCORROBORATED DENOMINATOR: nothing bounded the population except");
    console.log("  what the auditor could already see, so this ratio is 1.0 by");
    console.log("  construction and is not evidence of coverage.");
  }
  if (attestedFloor > declaredTotal) {
    console.log(
      `  CONCEALMENT SIGNAL: counterparties signed for ${attestedFloor}, ` +
        `operator declared ${declaredTotal}`,
    );
  }
}
