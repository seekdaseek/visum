# visum

Measures how much of a Canton ledger an auditor can actually see, and publishes
the answer on the ledger as a signed coverage ratio.

Built for HackCanton League Season 3, track Real-World Assets (RWA) & Business
Workflows. MIT licensed.

## The problem

On Canton a party sees only contracts where it is a stakeholder. Excluded
actions are dropped from its projection and empty transactions are removed
entirely. An auditor therefore cannot distinguish **"no event existed"** from
**"an event existed and I was not made a stakeholder"**.

There is no gap to notice. The withheld contract is not present-and-empty; it
is absent. Offsets are participant-local and non-contiguous by design, so even
the numbering proves nothing.

visum measures that gap and publishes it.

## How it works

Four templates, in [`main/daml/Visum.daml`](main/daml/Visum.daml):

| Template | Signatory | Purpose |
|---|---|---|
| `Settlement` | operator | The business event. `disclosed : [Party]` is the only field the operator manipulates; auditor present means disclosed, auditor absent means withheld, and nothing else about the contract differs. |
| `ScopeStatement` | operator | The operator's declaration of what the period contains, including the counterparty set it says should attest. visum treats it as a **claim**, never as truth. |
| `PartyAttestation` | counterparty | The strong denominator. A counterparty is a stakeholder on its own settlements and can count them without the operator's help. The operator cannot forge it and cannot archive it alone. |
| `CoverageProof` | prover | The published result: `auditorVisible` over `max(declaredTotal, attestedFloor)`, plus which counterparties actually attested and how many were expected. |

Where `attestedFloor` exceeds `declaredTotal`, the proof records **both**
numbers rather than picking one. That divergence is the concealment signal.

The proof also records **who actually attested** against **who was expected
to**. A ratio carries very different weight depending on how much of the
counterparty set stood behind it: *"0.60, attested by 4 of 4"* and *"0.60,
attested by 1 of 4"* are the same number and not the same claim. The
`ensure` clause binds the recorded counts to the recorded party lists, so a
proof cannot overstate its own attestation coverage.

Two properties make the proof worth reading:

- **The prover is untrusted.** Every input is independently visible to the
  auditor — its own projection gives `auditorVisible`, the `ScopeStatement`
  gives `declaredTotal`, the attestations give `attestedFloor` — so the auditor
  can recompute the published proof without taking the prover's word for
  anything.
- **A forged ratio cannot reach the ledger.** `CoverageProof` carries an
  `ensure` clause binding `ratio` to the three integers in the same contract,
  so a proof whose ratio does not follow from its own numbers is rejected at
  commit time.

## Status

Built and proven:

- The four templates, and the coverage arithmetic as pure functions.
- A Daml Script suite of 16 tests that **asserts** rather than prints, run
  against a real in-process ledger. See [Tests](#tests).

Not built yet: the TypeScript CLI (`seed` / `declare` / `attest` / `prove` /
`audit` / `verify`) and the twenty-seed acceptance run. No TypeScript was
written until the arithmetic was proven.

## Running it

Requires `dpm` (the Daml Assistant is removed in 3.5):

```
curl https://get.digitalasset.com/install/install.sh | sh
export PATH="$HOME/.dpm/bin:$PATH"
```

Build and test:

```
dpm build --all
cd test && dpm test
```

Start a sandbox with the JSON Ledger API on:

```
dpm sandbox --dar main/.daml/dist/visum-0.0.1.dar --json-api-port 7575
```

Measured cost of that sandbox: ~140 MB resident, ~22 s to ready. Details and
every other measured platform fact are in [NOTES.md](NOTES.md).

## Tests

`cd test && dpm test`. Sixteen tests, all asserting:

| Script | What it pins down |
|---|---|
| `testProjection` | operator sees all n, counterparty sees all n, auditor sees exactly n − k |
| `testStakeholders` | stakeholders equal signatories ∪ observers, observers never repeat a signatory, and stakeholder analysis predicts the auditor's real projection contract for contract |
| `testHonestProof` | the ratio is derived from ledger state and the auditor can recompute the published proof unaided |
| `testConcealment` | operator under-declares, the attested floor wins, both numbers are recorded, and the ratio reads 0.6 where declaration-only scoring would have read 100% |
| `testProverCannotPeek` | the prover follows the ledger rather than a supplied ground-truth value, with a guard against the test going vacuous |
| `testForgedRatioRejected` | three flattering ratios are rejected by the ledger; the honest one commits |
| `testAuditorAloneCannotComputeCoverage` | with no scope statement and no attestation the auditor holds a numerator and no denominator |
| `testAuditorCannotDistinguishWithheldFromAbsent` | a 25-settlement world with 9 withheld and an honest 16-settlement world produce an **identical** auditor view |
| `testAttestedFloorAcrossCounterparties` | the floor sums across distinct counterparties and a repeat attestation does not inflate it |
| `testDuplicateAttestationDoesNotInflate` | the per-attestor maximum, as a table |
| `testEmptyScope` | a zero denominator is defined as 0.0, not undefined |
| `testRatioIsRoundedNotExact` | `ratio` is `Numeric 10` and rounds, so exactness claims belong on the integers |
| `testAttestationCoverageIsRecorded` | two scopes with an identical 0.60 ratio, one attested 4 of 4 and one 1 of 4, are distinguishable from the proof alone |
| `testProofCannotOverstateAttestation` | the proof does not report full attestation it did not have, and the silent counterparties are identifiable |
| `testUndeclaredAttestorIsRecorded` | a counterparty attesting outside the declared set is recorded rather than rejected |
| `testRatioCanExceedOneUnderPartialAttestation` | pins the known edge where an incomplete denominator publishes a ratio above 1.0 |

The prover's signature is
`deriveCoverage : Party -> Party -> Text -> Script Derived`. It takes no `Int`,
so there is no parameter through which it could be handed the answer it is
supposed to derive. The shortcut is excluded by the type rather than by
discipline.

The suite has been mutation-tested. Nine mutations were introduced on throwaway
copies — breaking `max` to `min` in the denominator, hard-coding the visible
count, weakening the `ensure` clause, summing attestations naively, ignoring the
attested floor, claiming every expected counterparty attested, and inflating the
attestor count — and every one caused the suite to fail. Inflating the attestor
count was rejected by the ledger at commit time rather than by a test
assertion.

## Limitations

Stated plainly, because they bound what the number means.

1. **Coverage is measured against a declared scope.** A dishonestly declared
   scope can read one hundred percent over an incomplete universe. Two things
   mitigate it and neither eliminates it: `PartyAttestation`, which lets
   counterparties bound the true total from below over their own signatures,
   and making the scope a signed, hashed object rather than a sentence in an
   engagement letter.
2. **Explicit disclosure moves contract payloads off-ledger.** A party may
   legitimately hold data that visum scores as undisclosed, because visum reads
   ledger stakeholder sets and cannot see what was handed over by other means.
3. **Divulgence.** A party can witness contracts on `LEDGER_EFFECTS` streams
   that stakeholder analysis would not predict. visum counts on `ACS_DELTA`
   precisely to avoid this, which means it measures stakeholder visibility and
   not everything a party might have learned.

No MainNet deployment. No Decentralized Party. No integration with audit firm
tooling.
