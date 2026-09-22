# eval/

**`eval-output.txt`** — the fixed twenty-seed acceptance run
(`scripts/run-eval.sh`). Deterministic, reproducible from a clean checkout.

**`accumulator.jsonl`** — the long-running acceptance record. One JSON object
per line, **append-only**: never rewritten, never reordered, never compacted,
so both the count and the date span are provable from git history and from
the timestamps in the rows themselves.

Each line is one full iteration — fresh seed, scope, attestations,
`CoverageProof`, then the published numerator verified against a ground truth
the prover never reads (`scripts/check-isolation.sh` fails the build if it
ever could). Fields:

| field | meaning |
|---|---|
| `ts` | UTC timestamp of the iteration |
| `seed` | the seed that reproduces it |
| `settlements` / `withheld` / `visible` | count ground truth and the published numerator |
| `declaredTotal` / `attestedFloor` | the operator's claim and the counterparty-signed floor |
| `ratio` / `denominatorSource` | count coverage and which floor held its denominator up |
| `attestors` / `expectedAttestors` | attestation coverage |
| `visibleValue` / `attestedValue` | the same in minor units |
| `valueRatio` / `valueDenominatorSource` | value coverage and its own denominator source |
| `verdict` | `match` or `mismatch` |
| `elapsedMs` | wall clock |

Summarise with `scripts/accumulator-report.sh`.
