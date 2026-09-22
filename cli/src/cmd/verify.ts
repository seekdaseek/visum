// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

// Compare the committed CoverageProof against ground truth.
//
// This is the only command besides `seed` that may touch ground-truth.json.
// Exactness is claimed on the INTEGERS. The ratio is compared as a Numeric
// against a Numeric computed the same way -- never by parsing either side
// into an IEEE-754 double. See NOTES.md.

import { ledgerEnd } from "../api.ts";
import { readGroundTruth } from "../groundtruth.ts";
import { asInt, coverageRatio, denominatorSourceOf, numericEquals } from "../model.ts";
import { readScope } from "../scope.ts";
import { readState } from "../state.ts";

export type VerifyResult = {
  ok: boolean;
  seed: number;
  hidden: number;
  declared: number;
  attested: number;
  visible: number;
  publishedRatio: string;
  expectedRatio: string;
  denominatorSource: string;
  visibleValue: number;
  attestedValue: number;
  publishedValueRatio: string;
  expectedValueRatio: string;
  valueDenominatorSource: string;
  attestorCount: number;
  expectedAttestorCount: number;
  failures: string[];
};

export async function verify(opts: { quiet?: boolean } = {}): Promise<VerifyResult> {
  const st = readState();
  const gt = readGroundTruth();
  const offset = await ledgerEnd();

  // Read the proof as the AUDITOR: if the auditor cannot see it, it is not
  // published in any sense that matters.
  const { proofs } = await readScope(st.auditor, st.scopeTag, offset);
  if (proofs.length === 0) throw new Error(`no CoverageProof visible to the auditor in scope "${st.scopeTag}"`);
  const p = proofs[proofs.length - 1]!.payload;

  const visible = asInt(p.auditorVisible);
  const declared = asInt(p.declaredTotal);
  const attested = asInt(p.attestedFloor);
  const failures: string[] = [];

  // --- exact integer checks, no tolerances --------------------------------
  if (visible !== gt.visible) {
    failures.push(`auditorVisible ${visible} != ground truth ${gt.visible}`);
  }
  if (attested !== gt.total) {
    failures.push(`attestedFloor ${attested} != true total ${gt.total}`);
  }
  if (gt.total - gt.hidden !== gt.visible) {
    failures.push(`ground truth is internally inconsistent: ${gt.total} - ${gt.hidden} != ${gt.visible}`);
  }

  // --- ratio, compared as Numeric against Numeric -------------------------
  const expectedRatio = coverageRatio(declared, attested, gt.visible);
  if (!numericEquals(p.ratio, expectedRatio)) {
    failures.push(`ratio ${p.ratio} != expected ${expectedRatio}`);
  }

  // --- the denominator source must match the numbers it sits beside ------
  const expectedSource = denominatorSourceOf(declared, attested, visible);
  if (p.denominatorSource !== expectedSource) {
    failures.push(`denominatorSource ${p.denominatorSource} != expected ${expectedSource}`);
  }
  // A run where every counterparty attests must rest on the attested floor.
  // If it does not, the attestation did not actually bound the population.
  if (p.denominatorSource !== "AttestedFloor") {
    failures.push(
      `denominator rests on ${p.denominatorSource}, not the counterparty-signed floor`,
    );
  }

  // --- value coverage, exact on the integers, ratio Numeric vs Numeric ----
  const visibleValue = asInt(p.auditorVisibleValue);
  const attestedValue = asInt(p.attestedValueFloor);
  const declaredValue = asInt(p.declaredValue);
  if (visibleValue !== gt.visibleValue) {
    failures.push(`auditorVisibleValue ${visibleValue} != ground truth ${gt.visibleValue}`);
  }
  if (attestedValue !== gt.totalValue) {
    failures.push(`attestedValueFloor ${attestedValue} != true total value ${gt.totalValue}`);
  }
  if (gt.totalValue - gt.hiddenValue !== gt.visibleValue) {
    failures.push(
      `ground truth value is inconsistent: ${gt.totalValue} - ${gt.hiddenValue} != ${gt.visibleValue}`,
    );
  }
  const expectedValueRatio = coverageRatio(declaredValue, attestedValue, gt.visibleValue);
  if (!numericEquals(p.valueRatio, expectedValueRatio)) {
    failures.push(`valueRatio ${p.valueRatio} != expected ${expectedValueRatio}`);
  }
  const expectedValueSource = denominatorSourceOf(declaredValue, attestedValue, visibleValue);
  if (p.valueDenominatorSource !== expectedValueSource) {
    failures.push(
      `valueDenominatorSource ${p.valueDenominatorSource} != expected ${expectedValueSource}`,
    );
  }

  // --- attestation coverage ----------------------------------------------
  const attestorCount = asInt(p.attestorCount);
  const expectedAttestorCount = asInt(p.expectedAttestorCount);
  if (attestorCount !== p.attestors.length) {
    failures.push(`attestorCount ${attestorCount} != attestors listed ${p.attestors.length}`);
  }
  if (expectedAttestorCount !== gt.counterparties.length) {
    failures.push(
      `expectedAttestorCount ${expectedAttestorCount} != seeded counterparties ${gt.counterparties.length}`,
    );
  }

  const result: VerifyResult = {
    ok: failures.length === 0,
    seed: gt.seed,
    hidden: gt.hidden,
    declared,
    attested,
    visible,
    publishedRatio: p.ratio,
    expectedRatio,
    denominatorSource: p.denominatorSource,
    visibleValue,
    attestedValue,
    publishedValueRatio: p.valueRatio,
    expectedValueRatio,
    valueDenominatorSource: p.valueDenominatorSource,
    attestorCount,
    expectedAttestorCount,
    failures,
  };

  if (!opts.quiet) {
    if (result.ok) {
      console.log(`VERIFIED scope "${st.scopeTag}": published proof matches ground truth exactly`);
      console.log(`  count: hidden ${gt.hidden}  declared ${declared}  attested ${attested}  visible ${visible}  ratio ${p.ratio}`);
      console.log(`  value: visible ${visibleValue}  attested ${attestedValue}  ratio ${p.valueRatio} (${p.valueDenominatorSource})`);
    } else {
      console.error(`FAILED scope "${st.scopeTag}":`);
      for (const f of failures) console.error(`  - ${f}`);
    }
  }
  return result;
}
