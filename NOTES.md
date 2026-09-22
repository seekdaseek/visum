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

## Correction 5 (found while building the CLI): Daml Int64 goes out as a STRING

Sending a Daml `Int` field as a bare JSON number is rejected:

    HTTP 500 LEDGER_API_INTERNAL_ERROR
    "cause": "Expected ujson.Str (data: 40)"

Int64 must be serialised as a **string** in `createArguments`. It comes back
as a **number** on reads. So the asymmetry is real in both directions and
`cli/src/model.ts` carries `damlInt()` for the write side and `asInt()` for
the read side.

This is easy to miss because a template with no Int fields works fine —
`Settlement` seeded 100 contracts without complaint, and only `declare` blew
up.

## The ledger is the oracle for the TypeScript arithmetic

`CoverageProof` carries
`ensure ratio == coverageRatio declaredTotal attestedFloor auditorVisible`,
evaluated in Daml at commit time. The CLI computes the ratio independently in
BigInt (`cli/src/model.ts`). If the two disagree by one unit in the last
place, **the create is rejected** — a rounding bug surfaces as a failed commit
rather than as a wrong number in a report.

Measured: Daml-LF numeric division rounds **half-even** to the scale of the
result type, and the BigInt implementation matching that passed all twenty
acceptance runs, including denominators 7, 13, 41, 97, 101, 83 and 71, which
all produce non-terminating ratios.

Do not "simplify" the ratio to `visible / denom` in floating point. It will
fail at the ledger, and only on some seeds.

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

## The denominator has three terms, and the winner is published

The denominator is `max(declaredTotal, attestedFloor, auditorVisible)`.

The third term was added deliberately, and it is **not** a clamp. Before it,
a scope with no declaration and incomplete attestation published a ratio above
1.0 — measured 1.5, from 20 settlements with 8 withheld and one of two
counterparties attesting.

Capping that silently would have been worse than the overflow. When
`auditorVisible` is the term that wins, every settlement the auditor was shown
is in the denominator and nothing else is, so the ratio is **1.0 by
construction**. A silent cap turns an empty denominator into a perfect score —
which is precisely the failure mode visum exists to detect. So the proof
records which term won:

    data DenominatorSource = AttestedFloor | DeclaredTotal | AuditorVisible

`CoverageProof.denominatorSource` carries it, and the `ensure` clause binds it:

    denominatorSource == denominatorSourceOf declaredTotal attestedFloor auditorVisible

A proof that labels an uncorroborated 1.0 as `AttestedFloor` or
`DeclaredTotal` is **rejected at commit time**, not caught by a reader.
`testCannotClaimIndependentDenominator` proves both mislabellings are refused
and the honest one commits.

### Tie-breaking

Ties resolve toward the strongest corroboration:

| condition | source |
|---|---|
| `attestedFloor` is the max, including ties | `AttestedFloor` |
| otherwise `declaredTotal >= auditorVisible` | `DeclaredTotal` |
| otherwise | `AuditorVisible` |

So `AuditorVisible` is reported only when the auditor's own count **strictly**
exceeds both other terms — exactly when nothing outside the auditor bounded
the population. A tie means something external did bound it, even if the
number coincides.

Consequence worth stating: whenever the source is `AuditorVisible`, the ratio
is always exactly `1.0`. `testDenominatorSourceTieBreaking` asserts that as a
table. Read `1.0 / AuditorVisible` as "no denominator", never as "full
coverage".

`verify` treats a run whose denominator does not rest on `AttestedFloor` as a
failure, because in the acceptance run every counterparty attests and the
floor must therefore be what bounds the population.

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

## The live demo on solwatch — measured

Deployed 2026-09-22. `visum.ochinimus.app` → dedicated cloudflared tunnel
`visum` (`80cef444-…`) → `localhost:3029`. No nginx: the other tunnel-backed
hosts on that box (cassum, overhang) do not use one either.

### Memory, measured ON the VPS under load

| | |
|---|---|
| Canton JVM peak RSS | **960 MB** |
| visum-demo peak RSS | 95 MB |
| cgroup `memory.current` peak | 1022 MB |
| cgroup `memory.peak` | 1024 MB — i.e. pinned at the cap |
| `oom_kill` during real runs | **0** |
| idle cost (sandbox stopped) | ~35–95 MB, node only |
| cold start / warm run | ~30 s / ~3 s |

The 62–137 MB figure from the first session was an **idle** sample and is
wrong for planning. Under load it is ~960 MB.

### Why the cgroup and not -Xmx

`-Xmx320m` still produced 914 MB RSS, because metaspace, code cache, thread
stacks and direct buffers are outside the heap. The control is the kernel:

    systemd-run --scope --collect --unit=visum-sandbox.scope \
      -p MemoryMax=1G -p MemorySwapMax=0

Proven to bite. With `MemoryMax=256M` the kernel logged:

    Memory cgroup out of memory: Killed process 3154282 (java) ...
      oom_score_adj:1000

That is a *cgroup* OOM, contained: PM2 stayed at 39 procs / 6 restarts and
every neighbour answered 200 throughout.

Canton reads its cgroup limit and warns when `-Xmx` exceeds half of it, so a
too-small cap shows up as a boot warning before the kill.

### Traps hit while deploying

- **`java` does not read `JAVA_OPTS`.** It is a wrapper-script convention.
  Use `_JAVA_OPTIONS`, which the JVM reads and echoes on startup
  (`Picked up _JAVA_OPTIONS: …`). Verify with `jcmd <pid> VM.flags`.
- **Metaspace below ~384m kills Canton on boot** with a Metaspace
  OutOfMemoryError from the pekko actor system.
- **`/tmp` on solwatch is a 1.9 GB tmpfs.** The dpm installer extracts ~2.5 GB
  there and fails with "No space left on device" while `df /` shows 47 GB
  free — and being tmpfs, it eats RAM on the way. Install with
  `TEMPDIR=/var/tmp/dpm-install`. The installer prints "Successfully installed
  Dpm" even when the extraction failed, so check `dpm version` afterwards.
- **`cloudflared tunnel route dns <name> <host>` can bind the CNAME to the
  wrong tunnel.** Passing the name `visum` wrote the record against
  `7de53b95…`, which is *solquest-api*. Always pass the **UUID**, and read the
  `tunnelID=` in the output back before believing it. Fix with
  `--overwrite-dns` and the UUID.
- systemd `OOMScoreAdjust` is an exec property and does **not** apply to
  scopes. Set `oom_score_adj` from an inner `sh -c` that writes
  `/proc/self/oom_score_adj` and then `exec`s; the value is inherited across
  fork and preserved across exec, so the JVM carries it.

## Repo conventions

- Commits are authored as **seekdaseek** only. No `Co-Authored-By`, no
  "Generated with" line, no AI attribution anywhere in commit messages, PR
  bodies, tags, or credits files. `.githooks/commit-msg` enforces this; it is
  wired up with `git config core.hooksPath .githooks`. **Never** bypass it
  with `--no-verify`.
- `.visum/` is gitignored. `ground-truth.json` lives there and the prover must
  never read it.
