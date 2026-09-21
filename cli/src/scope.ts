// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { activeContracts, isTemplate, payloadOf, T, type CreatedEvent, type PartyId } from "./api.ts";
import type {
  CoverageProofPayload,
  PartyAttestationPayload,
  ScopeStatementPayload,
  SettlementPayload,
} from "./model.ts";

/** Contracts of one template, in one scope, as seen by one party. */
export function pick<P extends { scopeTag: string }>(
  events: CreatedEvent[],
  ref: string,
  scopeTag: string,
): { event: CreatedEvent; payload: P }[] {
  return events
    .filter((e) => isTemplate(e, ref))
    .map((e) => ({ event: e, payload: payloadOf<P>(e) }))
    .filter(({ payload }) => payload.scopeTag === scopeTag);
}

export async function readScope(party: PartyId, scopeTag: string, offset: number) {
  const events = await activeContracts(party, offset);
  return {
    settlements: pick<SettlementPayload>(events, T.Settlement, scopeTag),
    scopes: pick<ScopeStatementPayload>(events, T.ScopeStatement, scopeTag),
    attestations: pick<PartyAttestationPayload>(events, T.PartyAttestation, scopeTag),
    proofs: pick<CoverageProofPayload>(events, T.CoverageProof, scopeTag),
  };
}

/**
 * A hash over the scope's definition, so the declared scope is a signed
 * hashed object rather than a sentence in an engagement letter.
 */
export function scopeHash(parts: {
  scopeTag: string;
  periodStart: string;
  periodEnd: string;
  templatesInScope: string[];
  declaredTotal: number;
  expectedAttestors: string[];
}): string {
  const canonical = JSON.stringify({
    scopeTag: parts.scopeTag,
    periodStart: parts.periodStart,
    periodEnd: parts.periodEnd,
    templatesInScope: [...parts.templatesInScope].sort(),
    declaredTotal: parts.declaredTotal,
    expectedAttestors: [...parts.expectedAttestors].sort(),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}
