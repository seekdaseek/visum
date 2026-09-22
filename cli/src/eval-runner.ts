#!/usr/bin/env node
// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

// The long-running acceptance accumulator.
//
// It owns no sandbox. It drives visum-demo's loopback-only endpoint, which
// means it inherits every guard that process already has: the single
// cgrouped JVM with MemoryMax and oom_score_adj=1000, the strict run mutex,
// and the headroom pre-flight. It therefore cannot spawn a second JVM and
// cannot hurt the other services on the host.
//
// It runs in BURSTS rather than continuously. A continuous loop would keep
// the sandbox permanently resident at ~960 MB and undo the whole point of
// starting it on demand. A burst of iterations every half hour keeps the
// sandbox up for a couple of minutes at a time -- a duty cycle of a few
// percent -- while still accumulating thousands of scopes over the period.
//
// It yields to real visitors: the endpoint refuses while someone has used
// the live demo recently, and the runner simply backs off and tries later.

const BASE = process.env.VISUM_EVAL_TARGET ?? "http://127.0.0.1:3029";
const TOKEN = process.env.VISUM_EVAL_TOKEN ?? "";
const BURST = Number.parseInt(process.env.VISUM_EVAL_BURST ?? "20", 10);
const PERIOD_MS = Number.parseInt(process.env.VISUM_EVAL_PERIOD_MS ?? "1800000", 10);
const GAP_MS = Number.parseInt(process.env.VISUM_EVAL_GAP_MS ?? "1500", 10);
const BACKOFF_MS = Number.parseInt(process.env.VISUM_EVAL_BACKOFF_MS ?? "120000", 10);

if (TOKEN === "") {
  console.error("VISUM_EVAL_TOKEN is not set; refusing to run");
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let totalScopes = 0;
let totalSettlements = 0;
let mismatches = 0;
let errors = 0;
let stopping = false;

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    stopping = true;
    console.log(`${sig} received; finishing the current iteration then stopping`);
  });
}

type Rec = {
  settlements: number;
  withheld: number;
  ratio: string;
  valueRatio: string;
  verdict: string;
  failures?: string[];
};

async function oneIteration(): Promise<"done" | "yield" | "error"> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/internal/eval-iteration`, {
      method: "POST",
      headers: { "x-visum-eval": TOKEN },
      signal: AbortSignal.timeout(300_000),
    });
  } catch (e) {
    console.error(`  request failed: ${e instanceof Error ? e.message : String(e)}`);
    errors += 1;
    return "error";
  }

  const body = await res.text();
  if (res.status === 503) {
    // Yielding to a visitor, or the host is short on headroom. Neither is a
    // failure; back off and come back later.
    return "yield";
  }
  if (!res.ok) {
    console.error(`  HTTP ${res.status}: ${body.slice(0, 200)}`);
    errors += 1;
    return "error";
  }

  let rec: Rec;
  try {
    rec = JSON.parse(body) as Rec;
  } catch {
    console.error(`  non-JSON response: ${body.slice(0, 200)}`);
    errors += 1;
    return "error";
  }

  totalScopes += 1;
  totalSettlements += rec.settlements;
  if (rec.verdict !== "match") {
    mismatches += 1;
    console.error(`  *** MISMATCH *** scopes=${totalScopes} ${JSON.stringify(rec.failures ?? [])}`);
  }
  return "done";
}

async function burst(): Promise<void> {
  const started = Date.now();
  let did = 0;
  for (let i = 0; i < BURST && !stopping; i++) {
    const r = await oneIteration();
    if (r === "yield") {
      console.log(`  yielding after ${did} iterations; backing off`);
      await sleep(BACKOFF_MS);
      return;
    }
    if (r === "done") did += 1;
    if (r === "error") await sleep(5000);
    await sleep(GAP_MS);
  }
  console.log(
    `burst: +${did} scopes in ${Math.round((Date.now() - started) / 1000)}s | ` +
      `totals: ${totalScopes} scopes, ${totalSettlements} settlements, ` +
      `${mismatches} mismatches, ${errors} errors`,
  );
}

async function main(): Promise<void> {
  console.log(
    `accumulator starting: burst=${BURST} every ${Math.round(PERIOD_MS / 60000)} min, target ${BASE}`,
  );
  // A short delay so a supervisor bringing everything up at once cannot
  // stampede the demo process.
  await sleep(10_000);
  for (;;) {
    if (stopping) break;
    await burst();
    if (stopping) break;
    await sleep(PERIOD_MS);
  }
  console.log(
    `stopped. totals: ${totalScopes} scopes, ${totalSettlements} settlements, ` +
      `${mismatches} mismatches, ${errors} errors`,
  );
  process.exit(0);
}

void main();
