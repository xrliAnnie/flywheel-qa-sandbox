# FLY-2901 接管失败自动重建 — 实现验证记录
Issue: FLY-2901 (https://linear.app/geoforge3d/issue/FLY-2901/codex接管-替身接管工作目录失败worktree-takeover-failed-worktree-not-found)
日期: 2026-09-25
基于: plan.md（v5.1）

> ⛔ 本机只跑相关测试（issue 要求）。全仓全量只以冻结头 full CI 为准，由 QA 发起；本节点未请求 full CI。
> 跑 teamlead 用例前都 `export FLYWHEEL_CODEX_HOMES_ROOT=$(mktemp -d)`；从未运行 `tmux-viewer.macos.test.ts`。

## 1. 静态检查

| 检查 | 命令 | 结果 |
|---|---|---|
| 全仓 lint | `pnpm lint` | exit 0，`Checked 5256 files`，0 error；25 条 warning 均不在本分支改动文件中 |
| 受影响包构建 | `pnpm --filter "flywheel-teamlead..." --filter "flywheel-comm..." build` | exit 0 |
| 下游 typecheck | `pnpm --no-bail --filter "...flywheel-config" --filter "...flywheel-edge-worker" typecheck` | 13 个包全部 Done（claude-runner、config、edge-worker、flywheel-cli、flywheel-comm、gemini-agent、inbox-mcp、teamlead、terminal-mcp、voice-bridge、voice-codex、voice-core、voice-headphone）。首跑时 voice-codex 因本工作树未构建 `flywheel-voice-bridge` dist 报「找不到模块」，构建该包后通过——环境原因，与本改动无关 |
| 合并 origin/main 后 | `tsc --noEmit -p packages/teamlead`；`biome check plugin.ts` | 0 error；plugin.ts 仅 2 条既有 `useConst` warning |

## 2. 直接消费测试（按导入路径精确解析）

做法：对每个改动的源文件，找出**用相对导入路径精确解析到该文件**的测试文件（`from`/`import()`/`vi.mock`），而不是按文件名 grep——后者会被 `index`/`registry`/`progress`/`plugin` 这类通用名误匹配（按文件名粗 grep 得 281 个，其中 70 个是同名误匹配，已排除）。
保留 211 个测试文件，每批 ≤6 个文件逐批跑（避免位置过滤器过长时静默匹配为空）。

| 包 | 文件 通过/失败 | 用例 通过/失败 | 失败处置 |
|---|---|---|---|
| config | 10 / 0 | 220 / 0 | — |
| flywheel-comm | 2 / 0 | 20 / 0 | — |
| edge-worker | 34 / 4 | 490 / 22 | 见下 |
| teamlead | 159 / 1 | 2288 / 1 | 见下 |

失败逐条处置：
- edge-worker `Blueprint.fly1188-codex-prompt` / `fly2147-runner-memory` / `fly2148-runner-memory-closeout`（20 条）：这些旧式 worktree mock 只有 `isRegistered`；DAG 阶段带 startPoint 的派发现在走 `runTakeoverTransaction`（计划内的合同变更）。修复：9 个旧式 mock 补上 `runTakeoverTransaction`（未登记→经 mock 的 `create()` 返回 `created`；已登记→`reused`），复跑 9 个文件全绿（commit b1fd2e1d4）。
- edge-worker `WorktreeManager.takeover-rescue`（2 条）：批跑时与其他任务争用 CPU，超过 edge-worker 默认 30 s 超时（单独跑分别约 18 s、25 s）。修复：该文件的 describe 块显式设为 180 s，并把篡改用例拆成两条；复跑 47/47（commit be85e71a0）。
- teamlead `actions-retry-route`「preserves a locked codex design backend…」（1 条，`Unexpected end of JSON input`）：单独复跑 27/27 通过；该路由用例只经由类型层接触本改动（`StartRequest` 新增两个可选字段），判定为并发负载下的抖动。

## 3. `vitest related`

| 包 | 输入 | 结果 |
|---|---|---|
| edge-worker | 6 个改动源文件 | 38 个文件：36 通过、2 失败（4 条，全部是超时）。当时整机负载均值 101→142（额度恢复后大量 runner 同时开跑）。`WorktreeManager.resume`（FLY-1707）加 `--testTimeout=180000` 复跑全部通过；`WorktreeManager.reap.e2e` 的用例自带 20 s/30 s 硬超时和 8 s 进程收敛等待，覆盖不了，但它调用的 `remove()` / `removeCleanWorktreeByPath()` / `pruneOrphans()` / 回收器本分支一行未改，且在负载较低时的第 2 节批跑中（同一分支、`create()` 改动之后）9/9 通过 |
| config | progress-schema.ts、feature-flags/registry.ts、store-policy.ts | 22 个文件：21 通过（379 条），1 失败：`feature-flags-drift.test.ts` 在收集阶段报 `spawnSync git ENOBUFS`，见下方说明 |
| flywheel-comm | commands/progress.ts | 2 个文件，20/20 |
| teamlead | — | **排除**：改动的 teamlead 源文件（plugin.ts、run-infra.ts、DirectEventSink.ts、LeadAlertNotifier.ts 等）都被枢纽模块传递引用，`vitest related` 会退化为 1583 个文件的整包全量；以第 2 节的 160 个直接消费者 + 冻结头 full CI 代替 |

**`feature-flags-drift` ENOBUFS**：第 43 行 `execFileSync("git", ["ls-files", "-z"])` 没设 `maxBuffer`（默认 1 MiB = 1,048,576 字节）。实测已跟踪路径列表：origin/main 1,039,834 字节；本分支合并前 1,038,107；**合并 origin/main 之后 1,053,355**——两边各自都在线下，合在一起越过了线（本分支新增约 15 个路径）。这是潜伏的缓冲上限问题，下一个新增约 9 KB 路径的 PR 也会撞上；修复是测试文件里一行 `maxBuffer`，不在本单范围，已问 Lead 是否并入本 PR（question 844cccb2-224c-4c44-ad13-f6a5ca8d6ac6），默认另起单。合并前的第 2 节批跑中，该测试通过。

## 4. 守卫与脚本

| 守卫 | 结果 |
|---|---|
| `bridge-child-process-census` + `fly2121-legacy-census` | 通过 |
| claude-runner `kill-path-inventory` | 5/5 |
| `scripts/__tests__/fly1674-residue.test.sh` | 首跑 FAILED=1：派发器按 plan §4.6 复用 `three_stage_takeover_failed` 告警 kind，属白名单外字面量。按守卫的精确（路径, 词）豁免机制加入派发器及其测试两条（每条都有存活校验），复跑 PASSED=87 FAILED=0 |
| `lead-alert-*.test.sh`（7 个） | 全部通过（4 + 7 + 46 + 10 + 5 + 31 + 全 PASS） |
| `lead-alert.sh` 其余 41 个消费者 | **排除**：本改动只在 kind 白名单与 informational 列表里加一个新 kind，不改变它们发送的其他 kind 的行为 |

## 5. 本单新增测试（节选）

- `WorktreeManager.takeover-rescue.test.ts`（47，真 git）：七类处置、零丢失（从远端救援提交两层还原后与原索引/工作区/未跟踪字节逐一比对）、全部停手原因保字节、各步崩溃重入、manifest 一字节篡改、`create()` 三处故障注入、repo 锁并发、Codex R1 三条回归。
- `worktree-takeover-rescue.real-sink.test.ts`（3）：真 StateStore + DirectEventSink + 生产 repo 锁，事件后 / prune 后 / cleaned 写失败三种重启；并验证替身 binding 下 `resolveWorkflowHeadAuthority` 读到 target（不撞 head）。
- `DirectEventSink.fly2901-takeover-rescue.test.ts`（28）、`event-route` 两条 400、派发器 FLY-2901 块 20 条、run-dispatcher 2 条、Blueprint 接管合同 18 条、告警/开关/账本指针若干、`review-target-containment.fly2901.test.ts`（2）。

## 6. 变异 / RED 证据

- 零丢失：把 dirty 救援推送临时关掉，dirty 用例立即失败（事务自带的零丢失断言也拦下：`zero_loss_invariant_violated`），已还原。
- Codex R1 三条的回归测试在修复前全部 RED（分支探测失败时返回 `created`/`rescued`、缺能力时返回 `reused`、竞态远端 ref 被快进），修复后 GREEN。
- 子代理负责的块 4/5/7/8 均先见 RED 再实现（记录见各自提交说明）。

## 7. 未在本机验证

- 真 Codex 替身演练：按 issue 要求等 Codex 服务恢复后由 QA 另行验证。
- 冻结头 full CI：由 QA 发起。
