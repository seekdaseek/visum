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

The file here is the **committed archive**. The accumulator appends to
`/opt/visum-data/accumulator.jsonl` on the host, outside the git working
tree, and `scripts/sync-accumulator.sh` copies new rows across and commits
them. Keeping the live target inside the repo made `git pull` on the host
collide with the file being written. The sync refuses unless the archive is
a byte-exact prefix of the live file, so append-only is enforced rather than
assumed.
