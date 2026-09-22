// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

// Typed client for the Canton JSON Ledger API v2.
//
// Types are generated from the live OpenAPI document served by the sandbox at
// GET /docs/openapi (`npm run regen-types` against a running sandbox). That
// matters: the two field-name traps in NOTES.md are enforced by the compiler
// here rather than remembered.

import createClient from "openapi-fetch";
import type { paths, components } from "./generated/ledger-api.ts";

export type CreatedEvent = components["schemas"]["CreatedEvent"];
type ActiveContractsPage = components["schemas"]["JsGetActiveContractsPageResponse"];

export const LEDGER_URL = process.env.VISUM_LEDGER ?? "http://localhost:7575";

const client = createClient<paths>({ baseUrl: LEDGER_URL });

class LedgerError extends Error {}

function unwrap<T>(res: { data?: T; error?: unknown; response: Response }, what: string): T {
  if (res.error !== undefined || res.data === undefined) {
    const detail = typeof res.error === "string" ? res.error : JSON.stringify(res.error);
    throw new LedgerError(`${what} failed: HTTP ${res.response.status} ${detail}`);
  }
  return res.data;
}

// --------------------------------------------------------------------------
// Parties
// --------------------------------------------------------------------------

/** Full party ids look like `operator::1220<fingerprint>`; the hint is only a prefix. */
export type PartyId = string;

export async function listParties(): Promise<PartyId[]> {
  const data = unwrap(await client.GET("/v2/parties", {}), "list parties");
  return (data.partyDetails ?? []).map((p) => p.party).filter((p): p is string => !!p);
}

export async function allocateParty(hint: string): Promise<PartyId> {
  const data = unwrap(
    await client.POST("/v2/parties", { body: { partyIdHint: hint } }),
    `allocate party ${hint}`,
  );
  const party = data.partyDetails?.party;
  if (!party) throw new LedgerError(`allocate party ${hint}: no party in response`);
  return party;
}

/**
 * Resolve party-id hints to full party ids, allocating any that do not exist.
 *
 * Always resolve through this. A hint is not a party id and submitting one
 * produces a confusing NOT_FOUND rather than an obvious error.
 */
export async function ensureParties(hints: string[]): Promise<Record<string, PartyId>> {
  const existing = await listParties();
  const out: Record<string, PartyId> = {};
  for (const hint of hints) {
    const found = existing.find((p) => p.startsWith(`${hint}::`));
    out[hint] = found ?? (await allocateParty(hint));
  }
  return out;
}

// --------------------------------------------------------------------------
// Packages
// --------------------------------------------------------------------------

export async function uploadDar(dar: Uint8Array): Promise<void> {
  // openapi-fetch cannot express an octet-stream body cleanly, so this one
  // call goes through fetch directly.
  const res = await fetch(`${LEDGER_URL}/v2/dars?vetAllPackages=true`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: dar,
  });
  if (!res.ok) throw new LedgerError(`upload DAR failed: HTTP ${res.status} ${await res.text()}`);
}

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------

export async function ledgerEnd(): Promise<number> {
  const data = unwrap(await client.GET("/v2/state/ledger-end", {}), "ledger end");
  if (typeof data.offset !== "number") {
    throw new LedgerError("ledger end: response carried no offset");
  }
  return data.offset;
}

/**
 * Every active contract visible to `party`, following pagination to the end.
 *
 * Uses POST /v2/state/active-contracts-page. The GET form of the same path is
 * marked deprecated in the 3.5.18 spec, and the unpaged
 * /v2/state/active-contracts is the wrong call once n gets large.
 */
export async function activeContracts(
  party: PartyId,
  activeAtOffset: number,
): Promise<CreatedEvent[]> {
  const events: CreatedEvent[] = [];
  let pageToken: string | undefined = undefined;

  for (;;) {
    const data: ActiveContractsPage = unwrap(
      await client.POST("/v2/state/active-contracts-page", {
        body: {
          activeAtOffset,
          maxPageSize: 100,
          ...(pageToken ? { pageToken } : {}),
          eventFormat: { filtersByParty: { [party]: {} }, verbose: false },
        },
      }),
      "active contracts page",
    );

    for (const entry of data.activeContracts ?? []) {
      // The envelope is two levels deep and contractEntry is a union: an
      // active contract, an incomplete (un)assignment, or JsEmpty. Only the
      // active-contract arm carries a created event. See NOTES.md correction 3.
      const ce = entry.contractEntry;
      if (ce && "JsActiveContract" in ce) {
        events.push(ce.JsActiveContract.createdEvent);
      }
    }

    const next: string | undefined = data.nextPageToken;
    if (!next) break;
    pageToken = next;
  }

  return events;
}

// --------------------------------------------------------------------------
// Commands
// --------------------------------------------------------------------------

let commandCounter = 0;

/**
 * Submit create commands as `actAs`.
 *
 * Note the field name: CreateCommand takes `createArguments`, PLURAL, on the
 * way in. CreatedEvent returns `createArgument`, SINGULAR, on the way out.
 * Both are correct where they appear. See NOTES.md correction 2.
 */
export async function createContracts(
  actAs: PartyId,
  creates: { templateId: string; createArguments: Record<string, unknown> }[],
): Promise<void> {
  if (creates.length === 0) return;
  unwrap(
    await client.POST("/v2/commands/submit-and-wait", {
      body: {
        commandId: `visum-${Date.now()}-${commandCounter++}`,
        actAs: [actAs],
        userId: "participant_admin",
        commands: creates.map((c) => ({
          CreateCommand: { templateId: c.templateId, createArguments: c.createArguments },
        })),
      },
    }),
    "submit commands",
  );
}

/**
 * Archive contracts, so a long-lived demo sandbox does not accumulate an
 * ever-growing active contract set.
 *
 * `actAs` must hold the authority of every signatory: the operator can
 * archive Settlements, ScopeStatements and CoverageProofs, but a
 * PartyAttestation is signed by its attestor and only the attestor can
 * archive it.
 */
export async function archiveContracts(
  actAs: PartyId,
  items: { templateId: string; contractId: string }[],
): Promise<void> {
  if (items.length === 0) return;
  unwrap(
    await client.POST("/v2/commands/submit-and-wait", {
      body: {
        commandId: `visum-archive-${Date.now()}-${commandCounter++}`,
        actAs: [actAs],
        userId: "participant_admin",
        commands: items.map((i) => ({
          ExerciseCommand: {
            templateId: i.templateId,
            contractId: i.contractId,
            choice: "Archive",
            choiceArgument: {},
          },
        })),
      },
    }),
    "archive contracts",
  );
}

// --------------------------------------------------------------------------
// Template references
//
// Package-name format. The package-id format is deprecated in 3.5.
// --------------------------------------------------------------------------

export const T = {
  Settlement: "#visum:Visum:Settlement",
  ScopeStatement: "#visum:Visum:ScopeStatement",
  PartyAttestation: "#visum:Visum:PartyAttestation",
  CoverageProof: "#visum:Visum:CoverageProof",
} as const;

/** The ledger's own stakeholder set for a created event. */
export function stakeholdersOf(e: CreatedEvent): string[] {
  // `observers` is the one field of the three that is genuinely optional in
  // the 3.5.18 schema, so it is the one that needs the guard. See NOTES.md
  // correction 1. The participant guarantees observers never repeats a
  // signatory, so a plain concatenation is already a set.
  return [...e.signatories, ...(e.observers ?? [])];
}

export function isStakeholder(party: PartyId, e: CreatedEvent): boolean {
  return stakeholdersOf(e).includes(party);
}

/** Narrow a created event to a template, by package-name reference. */
export function isTemplate(e: CreatedEvent, ref: string): boolean {
  // templateId comes back in package-id format (`<pkgid>:Visum:Settlement`),
  // so compare on the module and entity, which the two formats share.
  const want = ref.replace(/^#[^:]*:/, "");
  return e.templateId.endsWith(`:${want}`) || e.templateId === want;
}

export function payloadOf<T>(e: CreatedEvent): T {
  // Singular on the way out. See the note on createContracts above.
  return e.createArgument as T;
}
