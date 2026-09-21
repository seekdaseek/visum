// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

// The control case.
//
// This command queries the ledger as the AUDITOR PARTY ONLY. It never reads
// the operator's projection and never reads ground truth. What it prints is
// the whole of what an auditor can determine on its own.

import { ledgerEnd } from "../api.ts";
import { asInt, attestedFloorFrom, coverageRatio, fullyAttested, missingAttestors } from "../model.ts";
import { readScope } from "../scope.ts";
import { readState } from "../state.ts";
import { short } from "./attest.ts";

export async function audit(): Promise<void> {
  const st = readState();
  const offset = await ledgerEnd();

  // The only party this command is allowed to query as.
  const { settlements, scopes, attestations, proofs } = await readScope(
    st.auditor,
    st.scopeTag,
    offset,
  );

  console.log(`audit of scope "${st.scopeTag}", queried as the auditor party only`);
  console.log("");
  console.log(`  settlements the auditor can see : ${settlements.length}`);

  if (scopes.length === 0 && attestations.length === 0) {
    console.log("");
    console.log("  THE AUDITOR CANNOT COMPUTE ITS OWN COVERAGE.");
    console.log("");
    console.log("  It holds a numerator and no denominator. Every settlement it cannot");
    console.log("  see is absent from its projection rather than present and empty, so");
    console.log("  a ledger where nothing happened and a ledger where everything was");
    console.log("  withheld look exactly the same from here. Offsets are");
    console.log("  participant-local and non-contiguous by design, so the numbering");
    console.log("  carries no signal either.");
    console.log("");
    console.log("  Nothing the auditor can do alone closes this gap. It needs the");
    console.log("  operator to declare a scope, or counterparties to attest, or both.");
    return;
  }

  const declaredTotal = scopes.reduce((m, s) => Math.max(m, asInt(s.payload.declaredTotal)), 0);
  const expectedAttestors = [...new Set(scopes.flatMap((s) => s.payload.expectedAttestors))].sort();
  const claims = attestations.map(({ payload }) => ({
    attestor: payload.attestor,
    seenCount: asInt(payload.seenCount),
  }));
  const attestedFloor = attestedFloorFrom(claims);
  const attestors = [...new Set(claims.map((c) => c.attestor))].sort();

  if (scopes.length > 0) {
    console.log(`  operator declares               : ${declaredTotal}`);
    console.log(`  expected attestors              : ${expectedAttestors.length}`);
  } else {
    console.log("  operator declares               : nothing (no ScopeStatement)");
  }

  if (attestations.length > 0) {
    console.log(`  counterparties signed for       : ${attestedFloor}`);
    console.log(
      `  attested by                     : ${attestors.length} of ${expectedAttestors.length}` +
        ` (${attestors.map(short).join(", ")})`,
    );
    const missing = missingAttestors(expectedAttestors, attestors);
    if (missing.length > 0) {
      console.log(`  SILENT counterparties           : ${missing.map(short).join(", ")}`);
    }
  } else {
    console.log("  counterparties signed for       : nothing (no attestations)");
  }

  // The auditor recomputes the coverage from what it holds. It does not need
  // the prover for this, which is the point: the published proof is checkable.
  const own = coverageRatio(declaredTotal, attestedFloor, settlements.length);
  console.log("");
  console.log(`  coverage the auditor computes   : ${own}`);

  if (proofs.length > 0) {
    const p = proofs[proofs.length - 1]!.payload;
    console.log("");
    console.log(`  published proof ratio           : ${p.ratio}`);
    console.log(
      `  published attestation coverage  : ${asInt(p.attestorCount)} of ${asInt(p.expectedAttestorCount)}`,
    );
    const agrees = p.ratio === own;
    console.log(`  auditor's own recomputation     : ${agrees ? "AGREES" : "DISAGREES"}`);
    if (!fullyAttested(p.expectedAttestors, p.attestors)) {
      console.log("");
      console.log("  WEIGHT: this ratio is not backed by the full counterparty set.");
      console.log("  The denominator is a floor built from whoever bothered to sign.");
    }
  }

  console.log("");
  console.log("  Note: the auditor still cannot rule out settlements withheld from");
  console.log("  every party that attested. Coverage is measured against a declared");
  console.log("  scope, not against the universe.");
}
