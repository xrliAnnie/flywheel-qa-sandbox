# FLY-2460 准入蒸馏通道 — 实施证据
Issue: FLY-2460 (https://linear.app/geoforge3d/issue/FLY-2460/2355b3-codex-自蒸馏从不触发runner-家里模型拿不到原生-memory-工具memory-stage1-后台任务从不跑)
日期: 2026-09-09
基于: plan.md

## 2026-09-09 implementation start

TURN: implement epoch=2, run=b611ce55-1ce4-46aa-a008-780efad435bd, execution=d60cff23-cf25-4dbf-b920-a278a4583e70. Clean inherited design HEAD e4ae13b8f. Approved plan v4 and round4.md unchanged.

- C7: added better-sqlite3 ^12.8.0 and types ^7.6.13 matching flywheel-comm. Offline install failed for absent dotenv tarball; normal pnpm install --no-frozen-lockfile succeeded. Lockfile only adds the two claude-runner dependency entries. Native SQLite fixture works.
- C1 RED: new protocol test failed because thread/start omitted config (74 passed, 1 expected failure). Added config and timeoutMs forwarding; GREEN: 75/75 client tests. Commit 4b0b2f93a.
- C2 partial: candidate upper-bound query implemented only. First behavioral RED returned [] instead of four allowed sources; GREEN after read-only query. Second RED missing state DB threw SQLITE_CANTOPEN; GREEN after ENOENT-specific absence handling. Three tests also cover inclusive 1h/10d edges, eight newest cap, committed WAL visibility, archived/blank/disabled/exec exclusions, two successful watermark exclusions, missing memory DB and corruption. Final focused command: `pnpm --filter flywheel-claude-runner exec vitest run test/codex-memory-distill.test.ts test/codex-daemon-client.test.ts` — 78/78 pass. Biome on changed files and git diff --check pass.

## Next work / incomplete requirements

C2 is NOT done: add deadline-aware DB calls/stat errors, worker-bound jobs/output observation, all §3.5 state/phase2 selection guards, turn-completed listener, RPC/abort/absolute-deadline waits, tokens and secure atomic receipt. Existing candidate function throws corruption for the forthcoming orchestration layer to classify as skipped:db_unreadable. Add remaining negative guards via strict TDD.

Then C3 runtime seam, C5 adapter, C6 run-infra, C8 QA runbook; full mandated gates; request-driven code review; last-commit milestone + PR + needs_review completion. No full repo gates or live 529 experiment run yet. No production home writes, no FLY-2359 edits. Legacy E7 remains the plan's explicit no-natural-population boundary. Never run tmux-viewer.macos.test.ts.

## 2026-09-09 C2–C5 implementation and verification

- C2 commit 5f9ca6400: native worker-bound output and selection observation; bounded RPC/turn/claim/phase2 waits; deadline-aware DB busy budgets and candidate iteration; best-effort token observation including no-claim outcomes; private atomic 0600 receipts with identity/size/O_NOFOLLOW checks. Behavioral RED→GREEN recorded for output classification, receipt persistence, trigger path, no-claim token accounting, and scan time budget. 40 module tests green before precision follow-up.
- Independent spec audit found native whole-second watermark mismatch for millisecond thread updates. Reproduced RED: a completed thread at `...00.123` remained a hint. Fixed both exclusion paths to `Math.floor(updated_at_ms / 1000)` in 491f10208; module now 41 tests green. This follows native `item.updated_at.timestamp()` semantics; the pinned plan's division notation remains unchanged.
- C3 commit 54c322a8d: first-thread admission hook, abort on stop, fail-open hook errors, goal start shifted by admission elapsed time only once. 33 runtime tests green, including near-5-minute budget preservation and restart anchor reuse.
- C5 commit 491f10208: enabled adapter passes C2 through runtime hook using the session-returned home. No injection when disabled. Full focused run before the timestamp follow-up: 265/265 across client (75), module (40), runtime (33), adapter (117). Timestamp regression adds one module test.
- `pnpm lint` exited 0 with 14 existing warnings, no fixes; `pnpm -r build` exited 0 (logs /tmp/fly2460-lint.log and /tmp/fly2460-build.log). These were pre-final-registry checks, not final-head verification.
- First `pnpm test:packages:run` exited 1: config 780 passed/2 failed because the planned env-only switch violated feature-flag drift/governance. No claim of a green full gate. Only forbidden `**/tmux-viewer.macos.test.ts` was temporarily excluded in core Vitest config, then original bytes restored (SHA256 273154bb2bdb89456385d68aa895ce53452d4253d0d196be0af4024bbcf4cb51).
- Lead response f20ffd87-3a7a-412d-a9b1-b3048f2af57e approved that explicit GUI-only exclusion and required subsequent Vitest calls to use `--pool=forks --poolOptions.forks.maxForks=1` (minForks=1 is also pinned to avoid a pool min/max conflict) and sequential package execution. No production DB copies or home writes.
- Lead response d2b3af31-0299-4cfb-a916-be8486d51509 approved replacing the raw env switch with governed SQLite `codex_memory_distill`, default ON, global default plus project override, read for each new adapter. See implementation-addendum.md; pinned plan unchanged. C6 registry/wrapper/route tests and updated C8 off instructions are in progress.

Remaining: finish C6/C8, repeat final gates with the approved execution settings, codex:rescue plus request-driven code review, last-commit milestone, PR, needs_review completion. No live 529 acceptance executed by implement.

## 2026-09-09 final verification in progress

- C6/C8 committed in 293916916. Agent verified registry/store/drift 89 tests and runtime/management routes 62 tests (all single-fork); root verified new-adapter callback wiring 2 tests. Default ON, * default/project overrides, set/clear precedence, reasons/scope rejection are tested. No direct env read or exemption introduced.
- Committed verification head before documentation-only updates: 5d8fc2c0b9ea1b10e80ab9123766beb0fab7cdb4. `pnpm lint` exit 0 (14 existing warnings); `pnpm -r build` exit 0; `pnpm -r typecheck` exit 0. Logs: /tmp/fly2460-final-lint.log, /tmp/fly2460-final-build.log, /tmp/fly2460-typecheck.log.
- Full package gate is RUNNING, not passed: root exec session 51461, launched by `python3 /tmp/fly2460-package-gate-serial.py`. Output /tmp/fly2460-final-packages.log. It invokes exact `pnpm test:packages:run` entry with temporary execution-only script settings: `--workspace-concurrency=1 --no-bail`, each Vitest script `--pool=forks --poolOptions.forks.maxForks=1 --poolOptions.forks.minForks=1`, and only core GUI file excluded. Finally restores every original manifest/config byte. Restore backup /tmp/fly2460-gate-restore.json exists solely for crash recovery; never commit the transient package/config changes. Poll same session; do not restart on observation timeout.
- Required codex:rescue attempted as read-only `codex-companion.mjs task --cwd <this worktree> --prompt-file /tmp/fly2460-code-review-request.txt`. Failed before session creation with sandbox helper status 71 (`sandbox_apply: Operation not permitted`). NO review verdict. Reported to Lead via report 40c34b69-aee8-4709-bd3b-a41ee7225d23. Do not retry through raw codex exec. Formal request-driven cross-family code review still required after gate/restoration.
- Fresh fetch: HEAD includes origin/main (22 commits ahead/0 behind at fetch); remote task branch e4ae13b8f is ancestor, no force push needed. `gh pr list --head flywheel-FLY-2460 --state all` returned []. No new scripts/__tests__/*.test.sh added.

Next: poll full gate 51461 and inspect failures by package; verify transient files restored; address failures without weakening gates. Then formal review gate + request-review, final evidence/progress, milestone as literal last commit before PR, push/PR/needs_review. No live 529 pass claimed. Goal remains active.

## Review rework and completed full gate

- Full gate session 51461 exited 1. Summary: 14 package passes, 2 failures. claude-runner: 46 files / 1153 assertions passed, 2 skipped, one package-final `onTaskUpdate` RPC timeout. TeamLead: 890 files / 12066 assertions passed, 6 skipped, the same single RPC timeout. No assertion failures. This is NOT a green full gate. All 17 temporary files restored; core SHA256 matches `273154bb2bdb89456385d68aa895ce53452d4253d0d196be0af4024bbcf4cb51`; git status was clean immediately after restoration.
- Review request a71d0cd7-b2a9-4f26-b3ca-f8867d2c2e5c on c91c217817d9bb474d3cb25d4bff0c0ece020b89 returned CHANGES_REQUESTED (question 17bd8e97-1997-4d6d-936c-85b9a40d3ce9). One HIGH: `admission-claims-eight-rollout-backlog-per-task`; three correctness MEDIUMs and three LOWs. Raw receipt: /tmp/fly2460-code-review-round2.json.
- Lead response 633d9903-4650-4a6f-8507-7874df6a4b63 approves cap 2 for hints and native startup, backlog>8 regression and QA backlog-cost case, all three correctness advisories plus documentation/predicate LOWs in the same bounded rework. Default ON and 300s ceiling unchanged; pinned plan untouched. ONE push and ONE final review after rework; new HIGH means stop/report.
- Lead response ec2684c3-ea52-40d4-98d9-ddcc71154cc9 requests ONE serial single-fork whole claude-runner rerun after this full gate; if the same package-final RPC artifact recurs with all files passing, record it and do not loop. Lead cites identical FLY-2445 artifact (1105 pass/2 skip). This is Lead-provided precedent, not independently verified here. Rerun not yet started.
- First rework RED→GREEN: new 12-rollout backlog test failed with 8 hints (`/tmp/fly2460-cap-red.log`); cap 2 in both query admission and native RPC made that focused test pass (`/tmp/fly2460-cap-green.log`). Code/test edits are uncommitted. Existing tests still need adjustment for the approved cap, and all other rework findings remain pending. No package/full green claimed for rework.

### Bounded rework completed (verification continuing)

All approved behavior fixes have a witnessed RED then GREEN: backlog cap (`cap-red/green.log`); token deadline preserving readable_ready (`token-red/green.log`); missing/denied rollout stat (`stat-red/green.log`); synchronous busy timeout 300000→≤5000 (`busy-red/green.log`); unrelated agents path mislabel (`homekind-red/green.log`). Logs share `/tmp/fly2460-` prefix. Latest complete module suite: 51/51 passed in homekind-green. File-size availability is independent of eligibility, and the total value is the known-files subtotal when marked unavailable. QA addendum covers natural >8 backlog on an isolated 529 home; no production reads/writes were used for this rework.

Rework `pnpm lint` exit0 with14 existing warnings. `pnpm -r build` session76356 remains running; next run typecheck, then the ONE authorized whole claude-runner rerun, all sequential. No final push/review yet.

## Final rework verification and freeze

- Rework commit `8a22b0da9`: all approved findings addressed; no code changes after verification. `pnpm lint` exit0 (14 existing warnings), `pnpm -r build` exit0, `pnpm -r typecheck` exit0. Logs: `/tmp/fly2460-rework-{lint,build,typecheck}.log`.
- ONE authorized whole claude-runner rerun (session59496) finished: 46 files passed, 1163 assertions passed, 2 skipped, one package-final `[vitest-worker]: Timeout calling "onTaskUpdate"`, exit1, duration500.38s. Log `/tmp/fly2460-rework-claude-runner-once.log`. This matches the failure class covered by Lead response ec2684c3; record as the accepted harness artifact, do not loop. It is not a green package result and does not change the full gate exit1 recorded above.
- Latest full gate remains the completed pre-rework full run, all assertions passing, with claude-runner and TeamLead RPC errors; post-rework evidence is the whole changed package plus lint/build/typecheck and the targeted RED/GREEN tests, not a second full gate. No new shell tests added. No transient test configuration remains in git status.
- Fresh main ancestry verified before freeze: HEAD ahead33/behind0 after fetch. Final milestone will be the literal last commit, followed by one normal push and one request-driven final review; HEAD will not move during review, including progress docs. A new HIGH means stop/report per Lead633d9903. Medium/low-only outcome uses the effective structured verdict; gate prose is not a review ruling.
- PR creation and needs_review handoff remain pending final review. Live529 E1–E6 plus backlog-cost case remain QA-owned and unexecuted here. E7 remains unproved per the pinned Lead ruling.

## Attempt 2 单变量返工（2026-09-09）

按 Lead instruction b93365bf-6ccc-4a96-b4ec-fdcefa4387c6 和 QA A/B 裁定，仅删除 codex-memory-distill.ts 触发 thread/start 的 baseInstructions 覆盖。phase2 克隆父 config 会继承该字段，原来的 exactly-ok 指令使 Memory Writing Agent 无工具调用并 failed_invalid_artifacts；此因果来自 QA 的真实 A/B，不将本地 mock 测试冒充真机复现。pinned plan 未修改。

先改真实通道 RPC 参数断言，旧实现因多出 baseInstructions 字段预期失败（/tmp/fly2460-attempt2-red.log，1 failed / 50 skipped，Vitest exit1）；删除生产覆盖后同模块 51/51 PASS（/tmp/fly2460-attempt2-green.log，exit0）。runbook §3 已取消 debug prompt-input 命中作为 E4 必要条件，补上 canonical 账号及三条历史限制。E4 仍由 attempt 2 QA 验证，不宣称完成。

本轮 lint/build/full gate、一次推送、一轮冻结 exact-head review 和 CI 14/14 尚待验证。不得重复推送或在 review 期间修改冻结 HEAD。

### Attempt 2 同步 main 与验证（进行中）

- 产品修复提交：`903ef568f`；一行删除，原 RPC 参数回归断言先 RED、后完整蒸馏模块 51/51 GREEN。
- 同步授权：Lead question `62288f33-c287-4f61-b48b-81c5250bcdc6` 明确要求 merge、不 rebase，保留原修复，只处理 run-infra.ts 冲突；已用 merge commit `9b2a6a5bd` 合入 `origin/main@04ff8800a`。保留双方 helper，main 的 seed loader 参数位置不变，distill 开关回调追加其后，调用点一致。没有修改 FLY-2359 运输逻辑。
- 合并前全仓 gate（session 74273）已完整退出1：14包通过；claude-runner 46文件/1163通过/2跳过、TeamLead 890文件/12066通过/6跳过，二者各有末尾 `[vitest-worker]: Timeout calling "onTaskUpdate"` 错误，没有断言失败。日志 `/tmp/fly2460-attempt2-packages.log`。脚本确认17个执行配置恢复，工作树恢复干净。此结果不称全仓绿色。
- 合并后 `pnpm lint`、`pnpm -r build` 均 exit0；日志 `/tmp/fly2460-postmerge-lint.log`、`/tmp/fly2460-postmerge-build.log`。
- 合并后新一轮完整 `pnpm test:packages:run` 正在运行（session40549，`/tmp/fly2460-postmerge-packages.log`），仍使用已授权串行单fork和GUI文件排除，退出前不下最终结论。恢复备份 `/tmp/fly2460-postmerge-gate-restore.json`。
- 本地同步授权已执行并报告（report `3c0a727a-f4eb-46e6-9c4f-f81f79db684b`）；PR landing 没有授权，`verify-approval` 返回 `approved:false / review_question_unbound`。未执行PR合并或部署。只允许一次普通push、一轮冻结exact-head review；尚未push。

### Attempt 2 最终本地验证

合并后完整gate40549退出1，17个临时执行配置全部恢复。claude-runner47文件、1196通过/2跳过；TeamLead898文件、12232通过/6跳过；这两个包各有末尾onTaskUpdate RPC超时，无断言失败。config包新增的FLY-2368固定数量断言遗漏本分支flag：expected25/actual26；预期文案映射已正确含本flag，只更新计数为26。该RED在完整gate日志124–147行；修正后的同一registry文件54/54 GREEN，exit0，日志/tmp/fly2460-postmerge-registry-green.log。其他13包通过。聚焦重跑不改写完整gate退出1的事实，不循环整仓重跑。

没有新增scripts/__tests__/*.test.sh。最新fetch main227058c73；git merge-tree --write-tree HEAD origin/main成功无冲突（tree be7f7da29361f8f0e0e7405c9f8640d3267bc797）。本分支保留9b2a6a5bd合入的main04ff8800a；后续main新增提交未重复合入。lint/build已在合并后通过，之后只有上述测试计数和证据文档变更。

本轮教训按允许的memory更新路径写入extensions/ad_hoc/notes/20260909T180655Z-codex-trigger-instruction-inheritance.md；未直接改共享role索引。最终head还需一次普通push、一轮冻结评审和exact-head CI14/14后needs_review。E4仍由QA canonical账号验证；不宣称已通过。
