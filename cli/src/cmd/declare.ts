// Copyright (c) 2026 seekdaseek
// SPDX-License-Identifier: MIT

import { createContracts, ledgerEnd, T } from "../api.ts";
import { damlInt } from "../model.ts";
import { readScope, scopeHash } from "../scope.ts";
import { readState } from "../state.ts";

/**
 * The operator signs a ScopeStatement.
 *
 * The declared total defaults to what the operator can count in its own
 * projection -- an honest declaration, derived from the ledger rather than
 * from the seeding parameters. `--declared` overrides it, which is how the
 * concealment case is demonstrated.
 */
export async function declare(opts: { declared?: number }): Promise<void> {
  const st = readState();
  const offset = await ledgerEnd();
  const { settlements } = await readScope(st.operator, st.scopeTag, offset);

  const declaredTotal = opts.declared ?? settlements.length;
  const now = new Date().toISOString();
  const templatesInScope = [T.Settlement];

  const hash = scopeHash({
    scopeTag: st.scopeTag,
    periodStart: now,
    periodEnd: now,
    templatesInScope,
    declaredTotal,
    expectedAttestors: st.counterparties,
  });

  await createContracts(st.operator, [
    {
      templateId: T.ScopeStatement,
      createArguments: {
        operator: st.operator,
        auditor: st.auditor,
        scopeTag: st.scopeTag,
        periodStart: now,
        periodEnd: now,
        templatesInScope,
        declaredTotal: damlInt(declaredTotal),
        expectedAttestors: st.counterparties,
        scopeHash: hash,
      },
    },
  ]);

  const note =
    opts.declared === undefined
      ? "counted from the operator's own projection"
      : `overridden with --declared (operator can actually see ${settlements.length})`;
  console.log(`declared ${declaredTotal} for scope "${st.scopeTag}" (${note})`);
  console.log(`expected attestors: ${st.counterparties.length}`);
}
