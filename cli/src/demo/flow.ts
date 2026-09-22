// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

// The live demo's server-side run.
//
// This calls the SAME command functions the CLI and the acceptance eval use.
// It is not a reimplementation: if the eval is green, this is the code that
// was green. Each run gets its own scope tag and its own temporary state
// directory, and archives everything it created on the way out so a
// long-lived sandbox does not accumulate contracts.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { activeContracts, archiveContracts, isTemplate, ledgerEnd, T } from "../api.ts";
import { attest } from "../cmd/attest.ts";
import { audit } from "../cmd/audit.ts";
import { declare } from "../cmd/declare.ts";
import { prove } from "../cmd/prove.ts";
import { seed } from "../cmd/seed.ts";
import { verify } from "../cmd/verify.ts";
import {
  asInt,
  attestedFloorFrom,
  coverageRatio,
  denominatorSourceOf,
  missingAttestors,
  type CoverageProofPayload,
  type PartyAttestationPayload,
  type ScopeStatementPayload,
  type SettlementPayload,
} from "../model.ts";
import { readScope } from "../scope.ts";
import { readState } from "../state.ts";
import { sweepScope } from "./sweep.ts";

export type AuditorView = {
  visible: number;
  hasDeclaration: boolean;
  hasAttestation: boolean;
  canComputeCoverage: boolean;
};

export type RunResult = {
  scopeTag: string;
  n: number;
  hidden: number;
  visible: number;
  counterparties: number;
  // the control, taken BEFORE anything is declared or attested
  control: AuditorView;
  // the indistinguishability pair
  worldA: { n: number; hidden: number; auditorSees: number };
  worldB: { n: number; hidden: number; auditorSees: number };
  indistinguishable: boolean;
  // after declare + attest + prove
  declaredTotal: number;
  attestedFloor: number;
  attestors: number;
  expectedAttestors: number;
  missing: string[];
  ratio: string;
  denominatorSource: string;
  concealment: boolean;
  verified: boolean;
  verifyFailures: string[];
  groundTruth: { total: number; hidden: number; visible: number };
  elapsedMs: number;
  log: string[];
};

/** Capture console output from the CLI commands so the page can show it. */
function capture<T>(sink: string[], fn: () => Promise<T>): Promise<T> {
  const real = console.log;
  console.log = (...a: unknown[]) => void sink.push(a.map(String).join(" "));
  return fn().finally(() => {
    console.log = real;
  });
}

function short(p: string): string {
  return p.split("::")[0] ?? p;
}

async function auditorViewOf(auditor: string, scopeTag: string): Promise<AuditorView> {
  const offset = await ledgerEnd();
  const { settlements, scopes, attestations } = await readScope(auditor, scopeTag, offset);
  return {
    visible: settlements.length,
    hasDeclaration: scopes.length > 0,
    hasAttestation: attestations.length > 0,
    canComputeCoverage: scopes.length > 0 || attestations.length > 0,
  };
}

export async function runDemo(rand: () => number): Promise<RunResult> {
  const started = Date.now();
  const log: string[] = [];

  const stamp = `${Date.now().toString(36)}${Math.floor(rand() * 1e6).toString(36)}`;
  const scopeA = `live-${stamp}-a`;
  const scopeB = `live-${stamp}-b`;

  // Server-chosen. Nothing here comes from the visitor.
  const n = 12 + Math.floor(rand() * 24); // 12..35
  const hidden = 1 + Math.floor(rand() * (n - 2)); // at least one of each
  const visible = n - hidden;
  const counterparties = 2 + Math.floor(rand() * 2); // 2..3

  const dir = mkdtempSync(join(tmpdir(), "visum-demo-"));
  process.env.VISUM_DIR = dir;

  try {
    // --- World A: n settlements, `hidden` of them withheld ---------------
    await capture(log, () =>
      seed({ n, hide: hidden, seedNum: Math.floor(rand() * 1e9), scopeTag: scopeA, counterparties }),
    );
    const st = readState();

    // --- THE CONTROL, taken before anything is declared or attested ------
    const control = await auditorViewOf(st.auditor, scopeA);
    await capture(log, () => audit());

    // --- World B: an honest, smaller ledger with nothing withheld --------
    // Seeded under the same parties, so the auditor's projection of B is
    // indistinguishable from its projection of A.
    const dirB = mkdtempSync(join(tmpdir(), "visum-demo-b-"));
    process.env.VISUM_DIR = dirB;
    await capture(log, () =>
      seed({
        n: visible,
        hide: 0,
        seedNum: Math.floor(rand() * 1e9),
        scopeTag: scopeB,
        counterparties,
      }),
    );
    const aView = await auditorViewOf(st.auditor, scopeA);
    const bView = await auditorViewOf(st.auditor, scopeB);

    // --- back to world A: declare, attest, prove, verify -----------------
    process.env.VISUM_DIR = dir;
    await capture(log, () => declare({}));
    await capture(log, () => attest({}));
    await capture(log, () => prove());
    await capture(log, () => audit());
    const v = await capture(log, () => verify({ quiet: true }));

    const offset = await ledgerEnd();
    const { scopes, attestations, proofs } = await readScope(st.operator, scopeA, offset);
    const proof = proofs[proofs.length - 1]?.payload as CoverageProofPayload;
    const scope = scopes[0]?.payload as ScopeStatementPayload | undefined;

    const claims = attestations.map(({ payload }) => ({
      attestor: payload.attestor,
      seenCount: asInt(payload.seenCount),
    }));
    const expected = scope?.expectedAttestors ?? [];
    const actual = [...new Set(claims.map((c) => c.attestor))];

    const result: RunResult = {
      scopeTag: scopeA,
      n,
      hidden,
      visible,
      counterparties,
      control,
      worldA: { n, hidden, auditorSees: aView.visible },
      worldB: { n: visible, hidden: 0, auditorSees: bView.visible },
      indistinguishable: aView.visible === bView.visible,
      declaredTotal: asInt(proof.declaredTotal),
      attestedFloor: asInt(proof.attestedFloor),
      attestors: asInt(proof.attestorCount),
      expectedAttestors: asInt(proof.expectedAttestorCount),
      missing: missingAttestors(expected, actual).map(short),
      ratio: proof.ratio,
      denominatorSource: proof.denominatorSource,
      concealment: asInt(proof.attestedFloor) > asInt(proof.declaredTotal),
      verified: v.ok,
      verifyFailures: v.failures,
      groundTruth: { total: n, hidden, visible },
      elapsedMs: Date.now() - started,
      log,
    };

    // housekeeping
    await sweepScope(scopeA, st).catch(() => undefined);
    process.env.VISUM_DIR = dirB;
    await sweepScope(scopeB, st).catch(() => undefined);
    rmSync(dirB, { recursive: true, force: true });

    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.VISUM_DIR;
  }
}

// re-exported for the server's health check
export { attestedFloorFrom, coverageRatio, denominatorSourceOf };
export type { SettlementPayload };
