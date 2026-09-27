# FLY-2911 评审作废止损 — 验证记录
Issue: FLY-2911 (https://linear.app/geoforge3d/issue/FLY-2911)
日期: 2026-09-25
基于: plan.md

本机相关验证已通过；本文件不代表代码评审通过、QA、full CI 或交接完成。

## 2026-09-26 resume

- 从重派头 `fdb3f63ed` 恢复，复用已批准计划；未重做设计。实际包名为 `flywheel-teamlead`，计划示例中的 `--filter teamlead` 不匹配包。
- 锁定依赖恢复：离线缓存缺 `@linear/sdk@60.0.0`，随后 `pnpm install --frozen-lockfile` 成功。
- 原有 runner / StateStore / coordinator 三文件重新验证：288/288 通过（`/tmp/fly2911-baseline-tests.log`）；CommDB 6/6 通过。
- 受影响包及依赖构建通过；依赖方 typecheck 首次因 voice-bridge 编译产物缺失失败，补建后重跑。
- C7 红测确认 `superseded_by_request` 仍进入巡检，最小修复为排除名单追加该原因；没有改变其他巡检规则。
- 补充启用新开关的恢复测试：运行中重启不改绑、移动 head 的复用方静默、迁移前 NULL/0 序号、释放中被新请求取代、在线回滚。

### Lead 批准的登记补充

Lead 在问题 `3b7a74e3-eb0e-4580-aeba-5c6a1c42605f` 明确批准修复配置 drift gate 所需的 registry/truth 及 store 读取接线。

- `review_early_stop` 按现有全局 store flag 规则登记；默认开，`0/off/false` 关闭。生产入口传命名 wrapper 回调，后续检查读取当前 store 值。环境变量只用于现有首次 seed，不作为已登记 store 行的第二权限源。
- 两个毫秒参数继续使用批准计划的构造时读取及边界校验，truth 中登记为数值配置。默认静默 120000ms、看门狗 30000ms。
- 回滚通过既有管理路由关闭 `review_early_stop`，静默仍独立使用 `FLYWHEEL_REVIEW_QUIET_WINDOW_MS=0`；已经永久作废的请求不会复活。这替代计划中直接修改已 seed 的 early-stop 环境变量的操作说明。
- 新 wrapper 的 3 条测试先失败（缺函数），接线后通过；现有管理路由逐个 flag 的 stage/apply/read 测试覆盖新增项。

### 更新后的消费者选择

本轮重新按全部变更生产文件的完整路径、文件名、父目录执行 `git grep -lF`；4719 个唯一匹配逐项登记保留/排除理由。原始证据 `/tmp/fly2911-resume-consumers.json`（SHA-256 `e297fc7e75235f9ec90799066260e7928f91ef6828a552a7f4555540cc428abb`），23 个保留测试见 `/tmp/fly2911-resume-retained-tests.txt`。`vitest related` 使用限定 include 配置，防止共享 StateStore/plugin 把无关整包测试带入。


## TDD 证据

- C1 runner：10 条新增测试先失败，随后 41/41 通过；提交 `0ed09c2d7`。主代理复核日志 `/tmp/fly2911-runner-green.log`。
- C2 StateStore：新增 28 条用例红测 `/tmp/fly2911-store-red-focused.log`；StateStore 77/77 通过。
- C2 CommDB：缺失 `getQuestionOrder` 的红测后，`db.fly1314.test.ts` 6/6 通过（`/tmp/fly2911-comm-green.log`）。
- C3–C6：首批 7 条协调器测试均确认红测（`/tmp/fly2911-coordinator-red.log`）；比较器真值表通过（`/tmp/fly2911-order-green.log`）。集成StateStore 77/77 通过。
- C7：恢复编译产物后确认缺少排除项的红测，最小脚本修改后 415 项断言全部通过。

## 本机测试选择

按每个变更源文件的完整路径、文件名、父目录执行 `git grep -lF`。此外按改动的评审方法名发现实际调用方，保留直接 API 消费者。父目录词（特别是 `scripts` / `packages/teamlead/src`）命中大量无关文档和其他模块；逐文件处置在本机审计产物中，未把这些宽命中转换成整包测试。

- 原始匹配：`/tmp/fly2911-consumer-sweep.json`，合计 4453 个唯一文件。
- 每个排除匹配的路径、查询词和理由：`/tmp/fly2911-consumer-dispositions.json`。SHA-256 `275c2446e2e291936885f3e94493c1efa07b71482c318334b88559d7899adeee`。
- 保留测试：
  - `packages/config/src/__tests__/feature-flags-drift.test.ts`
  - `packages/flywheel-comm/src/__tests__/db.fly1314.test.ts`
  - `packages/teamlead/src/__tests__/StateStore.codex-review.test.ts`
  - `packages/teamlead/src/__tests__/StateStore.design-review-approval-proof.test.ts`
  - `packages/teamlead/src/__tests__/StateStore.fly1314.test.ts`
  - `packages/teamlead/src/__tests__/StateStore.review-rulings.test.ts`
  - `packages/teamlead/src/__tests__/account-switch-e2e.test.ts`
  - `packages/teamlead/src/bridge/__tests__/claude-review-runner.test.ts`
  - `packages/teamlead/src/bridge/__tests__/review-request-coordinator.test.ts`
  - `packages/teamlead/src/ship-judgment/__tests__/plan-source.test.ts`
  - `packages/teamlead/src/ship-judgment/__tests__/runtime-collect.test.ts`
  - `packages/teamlead/src/ship-judgment/__tests__/ship-judgment-auto-approval.integration.test.ts`
  - `scripts/__tests__/lead-patrol-snapshot.test.sh`

对改动 TypeScript 的 `vitest related --run` 将使用同一保留文件集限定 include，以避免共享 StateStore 使整个 package 套件被选中。完整相关测试、lint、affected build/dependent typecheck 结果在完成后更新。

## 9-25 序列回放预期

| 请求 | 改后处理 |
|---|---|
| `fc72a8e4` | `1ae856df` 受理事务内作废，清除 04:01 重试；写入被取代 request 和原因审计。 |
| `b94193db` | `gate_mismatch` 登记拒绝，accept_seq 为 NULL，不是合法取代者。 |
| `1ae856df` | 同 head 静默两分钟后评审，接替旧 gate 的任务。 |
| `73ea086f` | 新 head 静默后照常评审。 |
| `49b16a5c` | QA 只读核对：真实 gate `308c69c7` 在 06:51:54 关闭，该任务于 06:52:36 因 `gate_answered_externally` 退役；改后仍不重跑，并写作废审计。单测使用同前缀但刻意保持 gate 开，验证的是隔离负向条件，不是历史实际结果。 |

历史依据为本目录 exploration.md §4。原事件在 04:01 已被旧代码的 gate 检查拦住，未真的重跑；这次提前消除的是挂到到点才退役的旧重试计划。新增回放测试使用该真实顺序和请求前缀构造隔离夹具，不操作生产数据库。

## 最终本机结果

- teamlead 限定 14 个文件的 `vitest related ... --run --config /tmp/fly2911-final-teamlead-related.config.mts`：410 passed / 1 failed；唯一失败为固定关闭开关时不应创建定时器的旧断言。修复固定 false 不建看门狗后，只重跑受影响的 coordinator 文件，179/179 通过（`/tmp/fly2911-final-coordinator-recheck.log`）。其余 13 个文件已通过且未再变更。合计覆盖 411 条 teamlead 测试。
- config 6 个相关文件：167/167（`/tmp/fly2911-final-config-related.log`）；独立保留的 feature-flags-scan 24/24（`/tmp/fly2911-flag-config-recheck.log`）。
- CommDB `vitest related src/db.ts ... --run`：6/6（`/tmp/fly2911-final-comm-related.log`）。上述合计 608 条不同测试。
- `bash scripts/__tests__/lead-patrol-snapshot.test.sh`：415 passed / 0 failed（`/tmp/fly2911-resume-patrol-green.log`）。红测另外出现过两条无关 founder-wait 计时断言失败；同一脚本绿测两条均通过，没有修改那些行为或断言。
- `pnpm --filter "flywheel-teamlead..." build` 通过；最后的固定-false 修复后 `pnpm --filter flywheel-teamlead build` 再次通过（`/tmp/fly2911-final-build-recheck.log`）。
- `pnpm --filter "...flywheel-config" --filter "...flywheel-teamlead" --filter "...flywheel-comm" typecheck` 全部通过（`/tmp/fly2911-final-typecheck.log`）；首次缺失 voice-bridge dist 导致的下游错误已由构建依赖消除。
- `pnpm lint` 退出 0，25 条警告；StateStore 超过 Biome 文件大小限制，被现有配置跳过，不能据此声称 StateStore 全量 lint 通过。`git diff --check` 通过。
- 额外红绿：在线关闭发生在异步 head 读取中、启动时关闭后再开启两条回归先失败，增加 await 后复查和可变策略定时器后通过。固定 false 的测试注入不启动定时器。
- 与 `origin/main` 的 `git merge-tree --write-tree` 预检无冲突；未执行合并、部署或服务重启。

没有本机整包测试、full CI 或生产数据库试验。所有生命周期/迁移/真实序列回放用隔离夹具完成；生产停止延迟仍是批准计划的默认 30 秒检查、连续两次 head 不符确认（约 60 秒），并非 Git push 同步钩子。


## QA attempt 1 返工（2026-09-26）

QA verdict `3709cd62-4154-4b50-a55c-9fa3a9a37da4` 绑定 `2941507fd`、full CI run `36228724487`。四个失败套件均在本机定向复现；不把原先 scoped CI 当作 full CI。

1. `StateStore.ts` 的 accept_seq 回填直接引用 `frozen_head_sha/target_path`，lane 索引直接引用 `project_name/issue_id/review_type`。FLY-663 保留的三列历史表没有这些字段，启动报 `no such column: target_path`。现在按实际列存在性分别守卫回填和索引；完整历史 schema 仍按原条件回填，稀疏 schema 保留 NULL（未知）。补充持久行、新增列、索引缺席和第二次打开断言。
2. 保留 FLY-1560 禁词守卫原样，改本功能命名：`freshnessCheckIntervalMs` / `startFreshnessCheck`、审计 trigger `freshness_check`、环境变量 `FLYWHEEL_REVIEW_FRESHNESS_INTERVAL_MS`。这是尚未上线的新配置名称修正；不保留禁词别名，默认 30000ms、边界 5000–600000ms 和两次 head 不符规则不变。静默仍为 120000ms。
3. 复核 CommDB 分支差异仅新增只读参数化 `getQuestionOrder`；没有改变 `getPendingQuestions`、ON/OFF bootstrap、分页或负载。仅刷新 compatibility.json 对应 db.ts hash，并补两态兼容理由，独立 legacy generator 保持原样。
4. kill-path 清单仅追加评审测试里的 signal-0 探针和 SIGKILL 清理两条 `qa-only`；不改扫描器、分类逻辑或生产进程边界。

红测：`/tmp/fly2911-rework-red-teamlead.log`（3 文件 7 failed / 28 passed）、`/tmp/fly2911-rework-red-kill.log`（1 failed / 4 passed）；增强迁移断言后再次红测 `/tmp/fly2911-rework-migration-red.log`。

相关消费者按本次每个变更文件完整路径、文件名、父目录重新执行 `git grep -lF`，逐条保留/排除理由见 `/tmp/fly2911-rework-consumers.json`；保留列表 `/tmp/fly2911-rework-retained-tests.txt`。共享 StateStore 的宽目录命中不转换为整包测试；相关测试使用限定 include 的 `vitest related --run`。

返工绿测与边界：
- 四个失败套件及核心/独立 bootstrap oracle：teamlead 6 文件 293/293；claude-runner inventory 5/5。
- teamlead `vitest related src/StateStore.ts src/bridge/review-request-coordinator.ts src/__tests__/StateStore.codex-review.test.ts src/__tests__/StateStore.fly663-migration.test.ts src/bridge/__tests__/review-request-coordinator.test.ts --run --config /tmp/fly2911-rework-teamlead.config.mts`：16 个相关文件 414/414，日志 `/tmp/fly2911-rework-teamlead-related.log`。未被 related 选中的 guard/drift/oracle 已在前一批单独通过。
- config `vitest related src/feature-flags/truth.ts --run --config /tmp/fly2911-rework-config.config.mts`：113/113；其余保留的 direct-toggle/resolve/scan/store-policy 四文件：78/78。
- 消费者审计 1914 个唯一匹配、27 个保留测试文件；JSON SHA-256 `2de0ca5d207bccc7c4530b8b0ec832425253c47a4fb9f00d2d05a60cf8fe8645`。
- `pnpm --filter "flywheel-teamlead..." build`、`pnpm --filter "...flywheel-config" --filter "...flywheel-teamlead" typecheck`、`pnpm lint`、`git diff --check` 均退出 0。lint 仍有 25 个警告，现有 oversized StateStore 跳过限制未变。
- 构建/typecheck/lint 日志依次为 `/tmp/fly2911-rework-build.log`、`/tmp/fly2911-rework-typecheck.log`、`/tmp/fly2911-rework-lint.log`。

旧 head 的 full CI 失败不被这些本机结果改写。新 head 需要新代码评审和 QA retest；本实现节点未请求本次返工 head 的 full CI，该请求由 QA 接手后负责。

补跑保留但未被 related 选中的 `claude-review-runner.test.ts`：41/41，通过真实子进程树中止测试，日志 `/tmp/fly2911-rework-runner-retained.log`。本次返工去重后共 27 文件、675 条测试全部通过。

## Main conflict rework (2026-09-26, QA claim 1654)

Scope: merge `origin/main` at `d52df7841cb7f7844ee83e37159987840a4c50ac` into the existing `270e0fdb549111756e313030348bd8f3f3fbc93e` branch without rebase or force push. The only manual merge resolution is `packages/teamlead/src/__tests__/fixtures/fly2567/compatibility.json`: preserve both FLY-2911 and FLY-2373 rationales and recalculate merged `packages/flywheel-comm/src/db.ts` SHA-256 as `bf0307b239feab26209e31845136394a8de276829a7226d4dd86c3636b694a65`. No additional product changes.

Consumer selection: `git grep -lF` with the full fixture path, `compatibility.json`, and `fixtures/fly2567` retained `lead-token-savings-drift.test.ts`, `lead-token-savings-generator-oracle.test.ts`, and `lead-token-savings-launch.test.ts`. Excluded the fixture itself (data) and the FLY-2910/FLY-2916 recorded consumer inventories (historical evidence, not executable tests). Also retained the explicitly requested coordinator/Claude runner tests plus StateStore codex review, review rulings, design review approval proof/manifest, and sparse migration regressions. The sole manual change is JSON; no TypeScript implementation was edited, so no new TypeScript-related discovery pass was substituted for this Lead-prescribed test selection. No local full package suite.

Commands:

```sh
pnpm --filter 'flywheel-teamlead...' build
pnpm --filter '...flywheel-teamlead' typecheck
pnpm lint
pnpm --filter flywheel-teamlead exec vitest run \
  src/__tests__/lead-token-savings-drift.test.ts \
  src/__tests__/lead-token-savings-generator-oracle.test.ts \
  src/__tests__/lead-token-savings-launch.test.ts \
  src/bridge/__tests__/review-request-coordinator.test.ts \
  src/bridge/__tests__/claude-review-runner.test.ts \
  src/__tests__/StateStore.codex-review.test.ts \
  src/__tests__/StateStore.review-rulings.test.ts \
  src/__tests__/StateStore.design-review-approval-proof.test.ts \
  src/__tests__/StateStore.design-review-manifest.test.ts \
  src/__tests__/StateStore.fly663-migration.test.ts
```

Build, dependent typecheck, and lint pass (25 existing lint warnings). Full-merge whitespace inspection reports pre-existing whitespace in imported main artifacts; the resolved compatibility manifest passes its scoped diff check. Existing locked dependencies were present; the offline install invocation ended at a noninteractive reinstall prompt, so this run does not claim a new install.

QA@3 original evidence was checked at `~/.flywheel/qa-evidence/FLY-2911/r3/verdict-summary.txt`: the old head passed code and 529 criteria, and conflict was the sole blocker. This does not prove the merged head's QA/full-CI/529 outcome. QA owns the next frozen-head full CI and live revalidation. Non-blocking alert notice observation is recorded in PR Follow-ups.

Result: 10 targeted files / 351 tests passed (coordinator 180, StateStore codex review 77, Claude runner 42, remaining seven files 52); exit 0. Merge commit `406165aeb` has exactly one manual resolution per `git show --remerge-diff --name-only`: the compatibility manifest. Logs: `/tmp/fly2911-targeted.log`, `/tmp/fly2911-build.log`, `/tmp/fly2911-typecheck.log`, `/tmp/fly2911-lint.log`.


## QA@4 main-sync rework (2026-09-26)

Request `rework:222896461fd9f8f22332d9cfae4b829b9f4933efd3e3b45675c7a3215c351fc9`, base `3df5ad5bdd0dd70a7f3882c006fca0e0ae13cb58`: bring in main's FLY-2934 registry assertion correction, without redesign or unrelated fixes. The current main had advanced beyond QA's clean-merge probe to `33fa00747`, adding FLY-2882 and FLY-2891. Merge `af0268d5df07b5d42e0596dcc6bda39bac03b6d0` has exactly one manually resolved file, StateStore.ts, with two conflict hunks:

- Keep the FLY-2911 transactional review-job migration and sparse-schema guards, and include main's `completed_at` column in that same migration.
- Keep main's first-completion timestamp assignment and the FLY-2911 `status = 'running' AND voided_at IS NULL` completion predicate together. Late/voided results must still fail the CAS and cannot record completion.

No other manual product edits. FLY-2934 removes only the stale count assertion; full expected registry mapping equality remains, including `review_early_stop`. The merged db.ts remains SHA-256 `bf0307b239feab26209e31845136394a8de276829a7226d4dd86c3636b694a65`; the compatibility manifest still contains both FLY-2373 and FLY-2911 rationales.

Discovery used `git grep -lF` with StateStore.ts and feature-flags-registry.test.ts full paths, filenames and parent directories, plus `completed_at` and the removed `toHaveLength(36)` literal. The 1,982 matched files (91 test matches) and per-match retain/exclude decisions are preserved in `qa4-rework-consumers.json.gz` (SHA-256 `f3a8badc871f3b46b601b060c9d5e6059b0cf2f430ec1e5b5673003916ac70e0`). Concrete selection is in `qa4-rework-tests.json`: previous QA review/compatibility checks plus the registry, sparse migration, FLY-1560 guard, imported lead-event schema regression, review-round completion timestamp and review scorecard consumers. Broad shared-module/directory matches outside the resolved review-job hunks are excluded; unchanged upstream subsystems are not turned into a local package suite.

Explicit-file validation: 15 files / 456 distinct tests pass (including registry 57/57); `pnpm --filter 'flywheel-teamlead...' build`, dependent typecheck (`...flywheel-teamlead`, `...flywheel-config`, `...flywheel-comm`), and `pnpm lint` pass. Lint reports the same 25 warnings and oversized StateStore limitation. Each retained test ran individually via its owning package. Registry `vitest related` also passes 57/57; bounded StateStore `vitest related src/StateStore.ts --run --config /tmp/fly2911-r5-teamlead-related.config.mts` passes 9 files / 304 tests. The related config includes only the retained concrete teamlead files; non-selected guards and scorecard/runner tests were already run explicitly. Related runs duplicate previously counted tests, so distinct coverage remains 15 files / 456 tests. Logs use `/tmp/fly2911-r5-*`.

QA owns the next frozen-head full-CI request and qa_retest. The prior head's failed full CI is historical evidence, not proof for this merge; the Implement phase does not request full CI before QA freezes its head. The unrelated voice installer flake was not changed.
