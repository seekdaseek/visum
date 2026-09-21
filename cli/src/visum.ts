#!/usr/bin/env node
// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

import { attest } from "./cmd/attest.ts";
import { audit } from "./cmd/audit.ts";
import { declare } from "./cmd/declare.ts";
import { prove } from "./cmd/prove.ts";
import { seed } from "./cmd/seed.ts";
import { verify } from "./cmd/verify.ts";

const USAGE = `visum -- measure what an auditor can actually see on a Canton ledger

  visum seed     [--n 100] [--hide random|<int>] [--seed <int>]
                 [--scope <tag>] [--counterparties <int>]
  visum declare  [--declared <int>]
  visum attest   [--as <counterparty>]
  visum prove
  visum audit
  visum verify

Ledger URL comes from VISUM_LEDGER (default http://localhost:7575).
State directory comes from VISUM_DIR (default .visum).
`;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function intFlag(argv: string[], name: string, dflt: number): number {
  const v = flag(argv, name);
  if (v === undefined) return dflt;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`--${name} expects an integer, got "${v}"`);
  return n;
}

async function main(): Promise<number> {
  const [, , cmd, ...argv] = process.argv;

  switch (cmd) {
    case "seed": {
      const hideRaw = flag(argv, "hide") ?? "random";
      await seed({
        n: intFlag(argv, "n", 100),
        hide: hideRaw === "random" ? "random" : Number.parseInt(hideRaw, 10),
        seedNum: intFlag(argv, "seed", 1),
        scopeTag: flag(argv, "scope") ?? "Q3",
        counterparties: intFlag(argv, "counterparties", 3),
      });
      return 0;
    }
    case "declare": {
      const d = flag(argv, "declared");
      await declare(d === undefined ? {} : { declared: Number.parseInt(d, 10) });
      return 0;
    }
    case "attest": {
      const as = flag(argv, "as");
      await attest(as === undefined ? {} : { as });
      return 0;
    }
    case "prove":
      await prove();
      return 0;
    case "audit":
      await audit();
      return 0;
    case "verify": {
      const r = await verify();
      return r.ok ? 0 : 1;
    }
    default:
      console.log(USAGE);
      return cmd === undefined || cmd === "--help" || cmd === "-h" ? 0 : 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(`visum: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
