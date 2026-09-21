# NOTES.md — measured facts for visum

Everything in this file was observed on this machine, not read from
documentation. Where it contradicts the original build brief or any Daml 2.x
material, **this file wins**. Dates are when the fact was measured.

Host: macOS arm64, 8 GB RAM, Zulu JDK 17.0.19, node v24.16.0.

## Toolchain (measured 2026-09-21)

| Thing | Value |
|---|---|
| `dpm version` | `3.5.11` (dpm binary `1.0.22`) |
| `sdk-version:` pinned in every `daml.yaml` | `3.5.11` |
| damlc | 3.5.2 |
| canton-open-source | 3.5.18 |
| JSON Ledger API reported version | 3.5.18 |

Install: `curl https://get.digitalasset.com/install/install.sh | sh`, which
lands in `~/.dpm/bin` and **does not** add itself to PATH. Then
`dpm install package`, then `dpm build`.

The Daml Assistant (`daml`) is deprecated from 3.4 and removed in 3.5. Use
`dpm`. Do not substitute anything from Daml 2.x docs; it is a different API.

### Sandbox resource cost — the reason LocalNet is not used

Measured with `ps` on the Canton JVM:

- **137 MB** RSS at idle after boot
- **62 MB** RSS after a DAR upload and three commits (post-GC)
- Boot to ready: **~22 s**

Splice LocalNet / CN Quickstart ask for canton 4g + postgres 2g + splice 3g.
The target Mac has 8 GB total and has OOM-crashed at 6 GB of Docker before;
the VPS has 3.8 GB. Neither can run it. `dpm sandbox` at ~140 MB can run on
either, so visum targets `dpm sandbox` only.

Run it:

    dpm sandbox --dar main/.daml/dist/visum-0.0.1.dar --json-api-port 7575

Note the path is `main/.daml/dist/...`, not `.daml/dist/...`: this is a
multi-package repo and the model package lives in `main/`.

`--canton-port-file <path>` writes a JSON file the moment the sandbox is
ready. **Use that as the readiness signal in `scripts/run-eval.sh`, never a
`sleep`.** Observed content:

    { "sandbox": { "ledgerApi": 6865, "adminApi": 6866, "jsonApi": 7575 } }

The JSON Ledger API is **off** unless `--json-api-port` is passed. The sandbox
is unauthenticated — no JWT.

## The four corrections that supersede the brief

These were measured against the live 3.5.18 OpenAPI document served at
`GET http://localhost:7575/docs/openapi` (8813 lines) and against real
responses.

### 1. Only `observers` is absent from the OpenAPI `required` list

The brief said `signatories`, `observers` and `witnessParties` were all
missing from `required`. In 3.5.18 that is wrong. `CreatedEvent.required` is:

    offset, nodeId, contractId, templateId, createdAt, packageName,
    representativePackageId, acsDelta, createArgument, witnessParties,
    signatories

`observers` is **not** in that list; its description reads
`Optional: can be empty`.

**So:** guard `observers` with `?? []`. Treat `createArgument`,
`witnessParties` and `signatories` as reliably present.

`observers` also carries this guarantee, which the participant enforces before
serving: *"This field never contains parties that are signatories."* So the
stakeholder set is `signatories ∪ observers` with no overlap to strip. The
Daml model mirrors this in `normalisedObservers`.

### 2. `createArguments` on write, `createArgument` on read. Both, at once

- **Write** — `CreateCommand.createArguments`, **plural**. Required.
- **Read** — `CreatedEvent.createArgument`, **singular**. Required.

Do not normalise these to one spelling. They are different fields on different
messages and both spellings are correct where they appear. `payload` and
`agreementText` are Daml 2.x and do not exist here.

### 3. ACS response envelope

    result[i].contractEntry.JsActiveContract.createdEvent

`POST /v2/state/active-contracts` returns a JSON **array**. Each element wraps
the event two levels deep. Verified against a live response.

### 4. Template references use `#visum:Module:Template`

Package-name reference format. For this repo the module is `Visum`, so:

    #visum:Visum:Settlement
    #visum:Visum:ScopeStatement
    #visum:Visum:PartyAttestation
    #visum:Visum:CoverageProof

The spec says of the package-id format: *"The package-id reference identifier
format is deprecated. We plan to end support for this format in version 3.4."*
Do not use package ids.

## Also measured, for when the CLI gets built

- **`/v2/state/active-contracts-page` exists.** That is the right call at
  `--n 100` across 20 seeds, not the unpaged `/v2/state/active-contracts`.
- `POST /v2/dars?vetAllPackages=true` with `Content-Type:
  application/octet-stream` uploads a DAR to a **running** sandbox. No restart
  needed between eval runs.
- `POST /v2/parties` with `{"partyIdHint":"operator"}` allocates. The returned
  party id is `operator::1220<fingerprint>` — the hint is a prefix, not the id.
  Always resolve hint → full id via `GET /v2/parties` before using it.
- ACS filtering is **by stakeholder**. The spec, on `filtersByParty`: *"For
  transaction and active-contract-set streams create and archive events are
  returned for all contracts whose stakeholders include at least one of the
  listed parties."* This is exactly visum's numerator, computed by the ledger.
- `TRANSACTION_SHAPE_ACS_DELTA` is the correct shape for the numerator.
  `TRANSACTION_SHAPE_LEDGER_EFFECTS` populates `witnessParties` with cumulative
  informees, which includes divulgence, and would overcount.
- Empirically confirmed on the update stream: a withheld commit is **absent**
  from the auditor's stream, not present-and-empty. Three commits, auditor
  disclosed on two: the auditor's `/v2/updates/flats` returned exactly two
  transactions, at offsets 22 and 28. The gap at the withheld offset is not
  evidence — offsets are participant-local and not contiguous by design.

## Daml facts hit while building the model

- **`Template t` does not imply `HasSignatory t` / `HasObserver t` in 3.5.**
  A helper over any template needs the accessor constraints spelled out:

      stakeholdersOf : (HasSignatory t, HasObserver t) => t -> [Party]

  Constraining on `Template t` fails to compile with
  `Could not deduce (HasSignatory t)`.
- A package that defines templates **and** depends on `daml-script` emits a
  warning, because uploading it uploads daml-script too and bloats the
  participant's package store. This is why the repo is split: `main/` holds
  the templates with no daml-script dependency, `test/` holds the scripts and
  takes `main` as a `data-dependencies` entry.
- `dpm build` from the repo root needs `--all` when a `multi-package.yaml` is
  present and no `daml.yaml` is.

## Settled design decisions — do not re-litigate

### PartyAttestation is observed by the operator, and that is safe

`PartyAttestation` is `signatory attestor, observer auditor, operator`. The
brief originally specified `observer auditor` only, under which the operator is
not a stakeholder, cannot read attestations at all, and therefore cannot
compute `attestedFloor` when proving. Widening the observer set is deliberate
and approved. It is safe for four independent reasons:

1. **Reading the floor cannot help a dishonest operator.** The denominator is
   `max(declaredTotal, attestedFloor)`. An operator that reads the attested
   floor can only respond by raising its own declared total, which raises the
   denominator and *lowers* its own ratio. There is no move that improves its
   score.
2. **The operator cannot shrink the floor.** It is not a signatory, so it can
   neither forge an attestation nor archive an existing one on its own
   authority. The floor is counterparty-controlled in both directions.
3. **It reveals nothing new.** A counterparty attesting a count to the operator
   discloses a number the operator already knows — it was the other side of
   every settlement in that count.
4. **Integrity does not rest on the operator's ignorance.** It rests on the
   prover being untrusted and every input to the proof being independently
   visible to the auditor, so the auditor can recompute the published proof
   without taking the prover's word for anything. `testHonestProof` asserts
   exactly that recomputation.

### CoverageProof.ensure binds ratio to its own numbers

`CoverageProof` carries
`ensure ... && ratio == coverageRatio declaredTotal attestedFloor auditorVisible`.
Also not in the original brief, also approved. A proof whose ratio does not
follow from the three integers in the same contract is rejected at commit time
rather than caught by a reader. `testForgedRatioRejected` proves the ledger
refuses `1.0`, `0.0` and `0.61` on a contract whose honest ratio is `0.6`, and
accepts only the derived value.

## Decimal, and the "no tolerances" acceptance test

`CoverageProof.ratio` is a Daml `Decimal`, which is `Numeric 10`. A
non-terminating ratio is **rounded to ten decimal places**. Measured: `7/13`
fails to invert exactly (`coverageRatio 13 0 7 * 13.0 /= 7.0` holds).

Consequences for `scripts/run-eval.sh`:

- Make the exactness claim on the **integers** — `auditorVisible`,
  `declaredTotal`, `attestedFloor`. Those are exact and are what ground truth
  actually pins down.
- Compare ratios only against a ratio produced by the same rounding. Do **not**
  recompute the expected ratio as an IEEE-754 double in TypeScript and expect
  `===` against the ledger's `Numeric 10`. That will produce spurious
  mismatches on most seeds and there are no tolerances to hide behind.
- `0/0` is defined as `0.0` by `coverageRatio`, not an error.

## Constraint the seeder must satisfy

The twenty-seed eval demands an exact match against ground truth. `attestedFloor`
only equals the true total when **every** settlement has a counterparty that
attests. If `visum seed` creates settlements whose counterparty never runs
`attest`, the floor is genuinely lower than the truth and the published ratio
will not match ground truth -- and it will be right not to, because the
information was never on the ledger. So: either every seeded counterparty
attests, or the eval's expected value must be computed from the attested
universe rather than from `n`. This is a property of the seeder, not a bug in
the prover.

## Repo conventions

- Commits are authored as **seekdaseek** only. No `Co-Authored-By`, no
  "Generated with" line, no AI attribution anywhere in commit messages, PR
  bodies, tags, or credits files. `.githooks/commit-msg` enforces this; it is
  wired up with `git config core.hooksPath .githooks`. **Never** bypass it
  with `--no-verify`.
- `.visum/` is gitignored. `ground-truth.json` lives there and the prover must
  never read it.
