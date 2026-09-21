// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

// The coverage arithmetic, mirroring main/daml/Visum.daml exactly.
//
// This is not a convenience reimplementation. CoverageProof carries
//
//     ensure ratio == coverageRatio declaredTotal attestedFloor auditorVisible
//
// so the ledger recomputes the ratio in Daml and rejects the create if this
// module disagrees by one unit in the last place. The template is the oracle
// for everything here: a rounding mistake surfaces as a rejected commit, not
// as a wrong number in a report.

/** Daml `Decimal` is `Numeric 10`: a fixed-point number with 10 decimal places. */
const SCALE = 10n;
const POW = 10n ** SCALE;

/** The denominator visum scores against. Mirrors `coverageDenominator`. */
export function coverageDenominator(declaredTotal: number, attestedFloor: number): number {
  return Math.max(declaredTotal, attestedFloor);
}

/** Mirrors `concealmentSignal`. */
export function concealmentSignal(declaredTotal: number, attestedFloor: number): boolean {
  return attestedFloor > declaredTotal;
}

/**
 * auditorVisible over max(declaredTotal, attestedFloor), as a Numeric 10
 * decimal string.
 *
 * Computed in BigInt throughout. No IEEE-754 double is involved at any point,
 * because a double cannot represent most of these ratios and the acceptance
 * test allows no tolerances.
 *
 * Rounding is half-even, which is what Daml-LF numeric division uses. All
 * inputs here are non-negative, so no sign handling is needed.
 */
export function coverageRatio(
  declaredTotal: number,
  attestedFloor: number,
  auditorVisible: number,
): string {
  const d = coverageDenominator(declaredTotal, attestedFloor);
  if (d <= 0) return formatNumeric(0n);

  const n = BigInt(auditorVisible) * POW;
  const den = BigInt(d);
  let q = n / den;
  const r = n % den;

  const twice = r * 2n;
  if (twice > den || (twice === den && q % 2n === 1n)) q += 1n;

  return formatNumeric(q);
}

/** Render a scaled integer as a fixed-point decimal with 10 places. */
function formatNumeric(scaled: bigint): string {
  const s = scaled.toString().padStart(Number(SCALE) + 1, "0");
  const whole = s.slice(0, s.length - Number(SCALE));
  const frac = s.slice(s.length - Number(SCALE));
  return `${whole}.${frac}`;
}

/**
 * Compare two Numeric 10 values for exact equality.
 *
 * The ledger may return a ratio in a different but equivalent spelling
 * ("0.6" vs "0.6000000000"), so compare on the scaled integer rather than on
 * the string, and never by parsing to a double.
 */
export function numericEquals(a: string, b: string): boolean {
  return toScaled(a) === toScaled(b);
}

/** Parse a Numeric 10 decimal string to its scaled BigInt. Exact. */
export function toScaled(v: string): bigint {
  const s = v.trim();
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [whole = "0", frac = ""] = body.split(".");
  if (frac.length > Number(SCALE)) {
    throw new Error(`numeric ${v} has more than ${SCALE} decimal places`);
  }
  const padded = frac.padEnd(Number(SCALE), "0");
  const scaled = BigInt(whole) * POW + BigInt(padded === "" ? "0" : padded);
  return neg ? -scaled : scaled;
}

/** Sum attested counts, taking the highest per attestor. Mirrors `attestedFloorFrom`. */
export function attestedFloorFrom(claims: { attestor: string; seenCount: number }[]): number {
  const best = new Map<string, number>();
  for (const c of claims) {
    const prev = best.get(c.attestor) ?? 0;
    if (c.seenCount > prev) best.set(c.attestor, c.seenCount);
  }
  let total = 0;
  for (const v of best.values()) total += v;
  return total;
}

/** Mirrors `fullyAttested`. */
export function fullyAttested(expectedAttestors: string[], attestors: string[]): boolean {
  return [...new Set(expectedAttestors)].every((p) => attestors.includes(p));
}

/** Mirrors `missingAttestors`. */
export function missingAttestors(expectedAttestors: string[], attestors: string[]): string[] {
  return [...new Set(expectedAttestors)].filter((p) => !attestors.includes(p));
}

// --------------------------------------------------------------------------
// Contract payloads, as they appear in CreatedEvent.createArgument
// --------------------------------------------------------------------------

export type SettlementPayload = {
  operator: string;
  counterparty: string;
  payload: string;
  scopeTag: string;
  disclosed: string[];
};

export type ScopeStatementPayload = {
  operator: string;
  auditor: string;
  scopeTag: string;
  periodStart: string;
  periodEnd: string;
  templatesInScope: string[];
  declaredTotal: string | number;
  expectedAttestors: string[];
  scopeHash: string;
};

export type PartyAttestationPayload = {
  attestor: string;
  operator: string;
  auditor: string;
  scopeTag: string;
  seenCount: string | number;
};

export type CoverageProofPayload = {
  prover: string;
  operator: string;
  auditor: string;
  scopeTag: string;
  scopeHash: string;
  declaredTotal: string | number;
  attestedFloor: string | number;
  auditorVisible: string | number;
  ratio: string;
  attestors: string[];
  expectedAttestors: string[];
  attestorCount: string | number;
  expectedAttestorCount: string | number;
  computedAt: string;
};

/** Daml Int arrives as a JSON number or a string depending on the endpoint. Normalise. */
export function asInt(v: string | number): number {
  return typeof v === "number" ? v : Number.parseInt(v, 10);
}

/**
 * Render a Daml `Int` for a CreateCommand payload.
 *
 * MEASURED: the JSON Ledger API rejects a bare JSON number for an Int64
 * field with `LEDGER_API_INTERNAL_ERROR / Expected ujson.Str (data: 40)`.
 * Int64 must go out as a STRING. It comes back as a number on reads, which
 * is why `asInt` accepts both.
 */
export function damlInt(n: number): string {
  return String(n);
}
