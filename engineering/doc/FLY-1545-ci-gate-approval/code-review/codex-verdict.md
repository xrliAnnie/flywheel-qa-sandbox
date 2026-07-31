# FLY-1545 cross-vendor code review — codex verdict

**Issue**: FLY-1545 [v2·P1] 二合一:ship 前等 CI 绿 / ship 审批门真机验证
**Executor vendor**: claude (claude-fable-5) · **Reviewer vendor**: codex (xhigh effort)
**Rounds**: 3 · **Final verdict**: APPROVED (Round 3, HEAD `e10b68ca`)

| Round | Verdict | Findings | Disposition |
|---|---|---|---|
| R1 | CHANGES REQUESTED | HIGH-1 post-green head drift consumes capability;MEDIUM-2 gh observation subprocess unbounded;LOW-3 mergeStateStatus denylist lets unknown values go green | 全部折入 `740ebf6c` |
| R2 | CHANGES REQUESTED | MEDIUM-2 残余:readPrHead/merge-poll 的 view() 仍无界(行为探针 100ms 配置实测 1516ms) | 折入 `e10b68ca`(view() 走 bounded structured runner) |
| R3 | APPROVED | 无 | — |

## Accepted residuals(评审知情)

- `ship-on-comment.yml` 侧互指注释未交付(runner push 凭据无 `workflow`
  scope,SSH 无钥)。dag-ports.ts 注释单向写明同改规则。注释级,无行为。
- 评审沙箱内 host-cli-e2e 3 个测试因 Unix socket `listen EPERM` 沙箱限制
  失败,与本 delta 无关(R2/R3 均记录);本机非沙箱运行 42/42 全绿。
- `packages/config` 7 个测试在干净 main@f5d894c7 上同样失败(本机
  pre-existing 环境问题,FLY-1456 里程碑已记录同类例外),与本 delta 无关。

## Round transcripts

### Round 1
```
VERDICT: CHANGES REQUESTED

1. HIGH — `packages/v2-dag/src/ship.ts:92`: the final green CI observation is not followed by a pre-intent head re-read, so a head drift can consume founder authority before it is refused. Concrete scenario: founder approves head A; `readCiState` returns green for A; the PR is force-pushed to B before line 120; the intent transaction still compares the captured `observedHead` A to the gate, consumes the one-shot capability, inserts the `github_merge` action, and increments `attempt_count`. Only afterward does `packages/v2-cli/src/dag-ports.ts:327` re-read the PR, see B, and throw. The catch path records a failed action, leaving the original capability consumed and the approved gate unable to retry without the manually invoked reconciler. The two-command implementation also has an earlier version of the same race: `readCiState` reads the head at `dag-ports.ts:205`, then runs un-SHA-bound `gh pr checks <PR>` at line 226, so the checks may already belong to a replacement head. Add a post-green, pre-intent head observation and a regression that flips the head as the green observation returns, asserting zero capability/action/attempt consumption.

2. MEDIUM — `packages/v2-cli/src/dag-ports.ts:52`: the new structured `gh` runner has no subprocess timeout. `CI_WAIT_MS` is therefore not a real 30-minute deadline: `executeShip` can inspect the deadline only after `readCiState` returns, but a wedged `gh pr view` or `gh pr checks` can block `execFileSync` indefinitely. A network hang, stuck credential helper, or misbehaving gh shim will leave the real `ship` CLI hung forever rather than returning a fail-closed red/deadline refusal. Bound each observation subprocess and map timeout/signal termination to red; cover it with a fake-gh process that does not exit.

3. LOW — `packages/v2-cli/src/dag-ports.ts:210`: `mergeStateStatus` is validated by a four-value denylist, not by an allowed domain. Any other string—including an unrecognized future enum or malformed shim value such as `"BOGUS"`—passes this check; with pass/skipping buckets the function returns green. A direct port probe on this HEAD returned `{"state":"green"}` for `mergeStateStatus:"BOGUS"`, contradicting the port contract that every ambiguous observation collapses to red. Validate the complete accepted decided-state domain and add an out-of-domain merge-state test.

Verification notes:

- The exit-code matrix is coherent in the current implementation: exit 8 plus valid pending JSON is pending; exit 8 without pending is red; exit 0 with a pending bucket is pending because JSON is authoritative.
- The static-fence retarget is sound for this delta: `ship.ts` performs a live port observation rather than an evidence-row predicate, and the new fence keeps `reconcile.ts` free of `readCiState`.
- The seven-step drill is substantive, not theater: the founder-facing direct verbs execute through real CLI subprocesses against a real live-authority database and real git repository, while the document accurately identifies GitHub as the sole fake. It proves the gate/ledger/CLI lifecycle claimed within that boundary.
- Targeted verification passed: v2-dag 21/21 tests; v2-cli CI matrix plus drill 16/16 tests; changed-file Biome and `git diff --check` passed. Broader v2-kernel (168/168), v2-engine (71/71), and v2-dag (95/95) passed. Broader host/CLI suites hit sandbox `listen EPERM` and process-probe restrictions in unchanged paths; those infrastructure failures are not review findings for this delta.
```

### Round 2
```
VERDICT: CHANGES REQUESTED

1. MEDIUM — `packages/v2-cli/src/dag-ports.ts:184`: R1 MEDIUM-2 is only partially resolved because the new timeout is confined to `runStructured()`, while every `readPrHead()` still calls `view()` → `output()` with no timeout (`dag-ports.ts:224-225`). `executeShip()` invokes that unbounded path before the first CI observation, after each pending sleep, and—new in this fold—after green immediately before the intent transaction (`packages/v2-dag/src/ship.ts:82`, `:102`, `:123`). Concrete failure scenario: `gh pr view` or its credential/network helper wedges during any head probe; the synchronous child never returns, the 30-minute CI deadline is never consulted, and ship hangs indefinitely with founder authority left in limbo. A direct operational-port probe configured with `observationTimeoutMs: 100` let a slow fake `gh pr view` run for 1516ms and return normally, proving that the seam does not cover this path. Bound the head-observation subprocess too, map timeout/signal failure fail-closed, and add a regression that exercises `readPrHead`/`executeShip` rather than only calling `readCiState` directly.

R1 disposition:

- HIGH-1 — RESOLVED. `executeShip` re-reads the head after green and before the intent transaction; the force-push regression asserts zero capability/action/attempt consumption.
- MEDIUM-2 — NOT RESOLVED. Both subprocesses inside `readCiState` are bounded, and Darwin/Node timeout classification is correct, but the surrounding head observations remain unbounded as described above.
- LOW-3 — RESOLVED. `mergeStateStatus` now uses the complete decided-state allowlist, and the `BOGUS` regression fails closed.

No additional fold-specific issue was found beyond the incomplete timeout coverage. The extra post-green head read is compatible with the drill and existing DAG fixtures; the seven-step drill remains substantive.

Verification:

- Reviewed current clean HEAD `740ebf6cada1a3d279168c839c36029253eb2584` against `main` `f5d894c774df37afcd67687a3aacb49dc9b9412c`; the supplied cumulative diff has the same stable patch-id as `git diff main...HEAD`.
- `flywheel-v2-dag`: 23 files, 96/96 tests passed.
- Exact CLI targets: `ci-observation.test.ts` + `ship-gate-drill.test.ts`, 18/18 passed.
- `flywheel-v2-host` TypeScript build passed; Biome on the four fold files and `git diff --check` passed.
- A broader CLI invocation also ran 38 passing tests and hit three unchanged `host-cli-e2e` `listen EPERM` sandbox failures; those infrastructure failures are not findings for this delta.
- On this Darwin host with Node v25.6.1, a timed `execFileSync` probe returned after 204ms with `code=ETIMEDOUT`, `signal=SIGTERM`, `status=null`; `runStructured` classifies that path fail-closed as intended.
```

### Round 3
```
VERDICT: APPROVED

No findings.

R2 disposition:

1. MEDIUM — RESOLVED. `packages/v2-cli/src/dag-ports.ts:189-208` now routes the shared `view()` helper through `runStructured()` with `observationTimeoutMs`; the production default remains the fixed `OBSERVATION_TIMEOUT_MS=30_000` and is not exposed by the CLI. Consequently all `readPrHead()` probes and both `merge()` view sites (pre-trigger and merge poll) are bounded. A timeout or non-zero exit throws from `view()`, preserving fail-closed `readPrHead()`/`merge()` behavior.

`readMergeState()` retains its `try/catch -> { state: "unknown" }` contract at `packages/v2-cli/src/dag-ports.ts:357-380`. Normal merge behavior is unchanged: `merge()` still verifies the expected head, emits exactly one `:cool:` comment, polls until it sees `MERGED` with a string merge SHA, and returns that SHA. The new real-subprocess regression at `packages/v2-cli/src/__tests__/ci-observation.test.ts:263-275` uses a genuinely hung fake `gh` and verifies that `readPrHead()` rejects within its 500ms test bound.

Verification:

- Reviewed clean current HEAD `e10b68ca86515a17d3bb20a9d1fa06107dc20022`; the R2 fold changes only `dag-ports.ts` and `ci-observation.test.ts` relative to `740ebf6c`.
- Exact CLI targets `ci-observation.test.ts` plus `ship-gate-drill.test.ts`: 19/19 passed. This includes the 500ms genuinely-hung head probe and the successful real-CLI seven-step gate/merge drill.
- Independent operational-port probe: a hung `readMergeState()` returned `unknown` after 202ms; a hung merge-poll threw the structured timeout after 341ms with a 200ms observation bound; non-zero `gh pr view` returned `unknown` through `readMergeState()` and threw through `merge()`.
- Full `flywheel-v2-dag` suite: 23 files, 96/96 tests passed.
- Full `flywheel-v2-cli` run: 39 tests passed; the three unchanged `host-cli-e2e` tests failed at host startup with sandbox `listen EPERM` on Unix sockets, the same infrastructure limitation recorded in R2 and unrelated to this delta.
- TypeScript builds for the exercised CLI/DAG packages passed. Biome on the two R2-fold files and `git diff --check 740ebf6c..HEAD` passed.
```
