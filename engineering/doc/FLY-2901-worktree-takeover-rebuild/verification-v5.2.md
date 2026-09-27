# FLY-2901 忽略内容保全门 — 增量验证
Issue: FLY-2901 (https://linear.app/geoforge3d/issue/FLY-2901/codex接管-替身接管工作目录失败worktree-takeover-failed-worktree-not-found)
日期: 2026-09-26
基于: plan.md（v5.2）、design-review-record.md、verification.md

## 范围与权威

执行体 `2935c975-32bb-4d97-b863-8010df5b9991`，run `afd81b64-62d7-442f-b221-988b2ad5621f`，implement TURN epoch 7。
接手时本地、远端、PR #1346 均为 `3722b7e8ba168925a30eabcfd8622e965ae417c8`，工作树干净。
该头包含后来批准的 v5.2 文档，原实现仍为 `42e435023515d79e82e4594f3d1be99b2d62043f` 的行为。
Lead 对问题 `d55d2ce6-63f1-496a-975d-8b08af9abcfe` 明确答复：旧的「只核对」说明作废；实施 §4.7a (a)–(f) 与 §10 全部 v5.2 回归，先红后绿，然后推送、当前头代码评审、`needs_review --pr 1346`。
按该答复先 fetch 并无冲突 merge `origin/main`，同步提交 `e13d4c02e`。没有重做设计。

## 定向测试选择

对改动源文件按完整路径、文件名、父目录分别执行 `git grep -lF`，另按导入名 `worktree-takeover-transaction` 搜索 `.js` 导入。
直接消费测试保留 `WorktreeManager.takeover-rescue.test.ts`、`Blueprint.fly887-worktree-takeover.test.ts`；真实持久事件与重启的 `worktree-takeover-rescue.real-sink.test.ts` 也保留。
owning package 的静态依赖选择器识别出 37 个相关文件（新增回归前）；运行时排除 `node_modules`、`dist`、`**/tmux-viewer.macos.test.ts`。
所有 teamlead 命令使用临时隔离的 `FLYWHEEL_CODEX_HOMES_ROOT`。

父目录字面匹配的排除项逐项如下（均未消费改动事务）：

| 匹配文件 | 排除原因 |
|---|---|
| `packages/claude-runner/test/kill-path-inventory.test.ts` | 检查 Blueprint 和 reaper 杀进程入口清单；本增量无进程操作 |
| `packages/config/src/__tests__/progress-schema.test.ts` | 注释引用相邻 rescue 模块；账本编码和 schema 未改 |
| `scripts/__tests__/runner-test-policy.test.mjs` | 引用 edge-worker 的技能模板文件；测试策略未改 |
| `scripts/__tests__/runtime-role-auto-qa-retirement.test.sh` | 引用 Blueprint 的旧 QA 退役文本；角色派发合同未改 |
| `scripts/__tests__/test-worktree-removal-contract.test.sh` | 检查 WorktreeManager 删除入口合同；本增量只增加原地清理前拒绝门 |

没有新增 shell 测试。此次 merge 引入的其他 issue 文件不计作本增量改动。

## 执行记录

- 首次尝试定向测试未启动：工作树没有安装 Vitest。随后 `pnpm install --frozen-lockfile` 成功；这是前置依赖问题，不是产品测试失败。
- 依赖恢复后，`pnpm --filter "flywheel-edge-worker..." --filter "flywheel-teamlead..." --filter "flywheel-comm..." build` 成功。
- 实施前 `pnpm lint` exit 0，5083 文件，25 条既有 warning。
- main 同步后的原有接管事务基线：47/47 通过，153.82 s，日志 `/tmp/fly2901-preincrement.log`。
- RED 源码 blob：`90c08fb6e8e3597a3c3bafb014932aeb341f6ebb`（`worktree-takeover-transaction.ts`）。v5.2 专项第一次运行 30 failed / 5 passed / 47 old skipped，121.72 s；旧实现对全部 30 个应拒绝场景仍返回 `rescued`。日志 `/tmp/fly2901-v52-red.log`。
- 追加边界的 RED：3 条畸形探针输出 + 1 条持久事件后、嵌套仓移动前的二次检查，4 failed / 82 skipped，16.52 s；日志 `/tmp/fly2901-v52-red-boundaries.log`。两批 RED 均在保护门源码修改之前执行。
- 正向对照保留 dirty / head_behind 的被忽略字节，以及树外全局忽略文件的正常解析；真大小写不敏感文件系统的两例在本次 RED 实际执行，没有跳过。
- 第一次 GREEN：39/39 新例通过，101.98 s，日志 `/tmp/fly2901-v52-green.log`。
- 代码核对又发现两处必须按计划收紧的边界：`ls-files --error-unmatch` 的 index 路径匹配不随 `core.ignorecase` 折叠；全局忽略路径中的 `普通文件/../ignore` 或尾随 `/` 应按 ENOTDIR 拒绝。3 条新增用例先 RED（15.84 s，旧门仍返回 rescued），修正后 GREEN（3/3，9.46 s）。日志 `/tmp/fly2901-v52-index-red.log`、`/tmp/fly2901-v52-index-green.log`。
- 最后仅增强正向对照的断言：枚举 `git ls-files --others --ignored --exclude-standard -z`，逐个比较原位置字节；单独复跑 2/2 通过，18.84 s，日志 `/tmp/fly2901-ignored-bytes-final.log`。
- 源码 blob `e528134e040c52e94ca0649ab66c3cb607d713da`：受影响包及依赖重新 build 成功；`pnpm lint` exit 0（仍为 25 条既有 warning）；`pnpm --filter "...flywheel-edge-worker" typecheck` 的 edge-worker、teamlead、voice-codex 三包全部通过。
- 真实持久化与路径边界：`worktree-takeover-rescue.real-sink.test.ts`、`DirectEventSink.fly2901-takeover-rescue.test.ts`、`review-target-containment.fly2901.test.ts` 共 3 文件、33/33 通过，60.31 s。真实 StateStore 重启后仍能恢复，missing 类沿用 generation，替身 head 权威检查通过。
- 最终 owning-package `vitest related`：37 文件中 36 passed / 1 skipped，529 passed / 9 skipped，495.72 s，exit 0。日志 `/tmp/fly2901-related-final.log`。接管文件 89/89 通过（含 42 条新增）；FLY-1707 原恢复用例 16/16 通过。9 个跳过均为沙箱不允许全局 `ps` 时既有进程回收测试的宿主条件分支（reap.e2e 8 条、real-tmux 1 条），不能作为真实宿主回收证明。
- 代码提交：`59b550353`；本轮正式代码评审将绑定包含验证记录与末尾里程碑的最终推送 HEAD，重点核 §4.7a (a)–(f) 和全部回归。

最终相关命令（全部使用 `--maxWorkers=1 --no-file-parallelism`，排除 `**/node_modules/**`、`**/dist/**`、`**/tmux-viewer.macos.test.ts`）：

```sh
pnpm --filter flywheel-edge-worker exec vitest related src/worktree-takeover-transaction.ts src/__tests__/WorktreeManager.takeover-rescue.test.ts --run
pnpm --filter flywheel-edge-worker exec vitest run src/__tests__/WorktreeManager.takeover-rescue.test.ts -t "preserves ignored node_modules and runs bytes"
FLYWHEEL_CODEX_HOMES_ROOT="$(mktemp -d /tmp/fly2901-codex-homes.XXXXXX)" pnpm --filter flywheel-teamlead exec vitest run src/__tests__/worktree-takeover-rescue.real-sink.test.ts src/__tests__/DirectEventSink.fly2901-takeover-rescue.test.ts src/bridge/__tests__/review-target-containment.fly2901.test.ts
pnpm --filter "flywheel-edge-worker..." build
pnpm --filter "...flywheel-edge-worker" typecheck
pnpm lint
```

测试选择的预查只调用 Vitest `getRelevantTestSpecifications()`，没有调用执行测试的 API。最终命令包含显式改动文件，未运行本机整包或全仓套件。最后增强的两条正向对照是在 related 进程启动后编辑的，所以额外单独运行其最终断言；保护门源码在上述全部最终验证期间保持同一 blob。

源码只改 `worktree-takeover-transaction.ts`：把 target 选择移至保全前，新增私有检查门与停手原因，并在两处调用。规则变更的诊断列出触发的规则源路径（如 `(d) .gitignore`）；按 §4.7a 的收窄算法，不枚举或预测该规则源会影响哪些忽略文件。规则标签同时进入既有的 20 条路径诊断字段，避免 detail 的 300 字符展示截断把路径列表吞掉。

## 当前执行体 R1 阻断修复

对 `90798367ce9b08982ef95f2bd06ec0a01ce5a82f` 的正式代码评审返回 CHANGES_REQUESTED，唯一 HIGH 为 `snapshot-status-stale-vs-fingerprint`。完整轮次身份、根因与六项非阻断建议的处置见 `code-review-v5.2-r1.md`。

修复提交 `5ee94bc5c`，源码 blob `30ecc1acf0620a06af9996fdd991606c03efb648`。首次指纹把自己读取的 HEAD/status 与分类及快照使用的基线逐项比较；不相等时在任何保全或破坏写入前拒绝。没有改变 manifest、重入、许可或忽略内容门的范围。

- 先 RED：远端探测窗口分别注入新的 tracked 改动、untracked 文件、HEAD 前移，旧实现三例均错误返回 rescued。3 failed / 1 positive passed，18.31 s，`/tmp/fly2901-review-r1-red.log`。
- 后 GREEN：同四例 4/4 通过，13.40 s，`/tmp/fly2901-review-r1-green.log`。拒绝例核对 HEAD、原 index/worktree/untracked 字节和无救援 ref/事件；正向例恢复救援快照，核对探测期间对已知脏路径写入的最新字节。
- 再次执行完整路径、文件名、父目录的 `git grep -lF`，以及 `.js` 导入 stem 搜索。测试候选与前文相同，五个排除测试及原因仍适用；父目录命中的历史文档、复现材料、路径清单和运维脚本不是新增测试依赖。原始 325 路径匹配按查询保存于 `/tmp/fly2901-review-r1-consumers.json`。
- `pnpm --filter "flywheel-edge-worker..." build`、`pnpm lint`、`pnpm --filter "...flywheel-edge-worker" typecheck` 均 exit 0；仍为 25 条既有 lint warning，edge-worker/teamlead/voice-codex 三包 typecheck 全通过。日志为 `/tmp/fly2901-review-r1-{build,lint,typecheck}.log`。
- 真实 StateStore/DirectEventSink 重启与路径边界三个文件再次 33/33 通过，42.23 s；使用全新隔离的 `FLYWHEEL_CODEX_HOMES_ROOT`，日志 `/tmp/fly2901-review-r1-sink.log`。
- owning-package `vitest related` 最终 exit 0：37 文件中 36 passed / 1 skipped，533 passed / 9 skipped，331.47 s；接管文件 93/93（89 原有 + 本轮 4 条），原 FLY-1707 恢复用例 16/16。9 个跳过仍为既有宿主进程能力条件分支，不能当作真实宿主回收证明。日志 `/tmp/fly2901-review-r1-related.log`。

本轮继续使用前文列出的 related、三个 sink 文件、build/typecheck/lint 命令与排除参数；新增专项命令是同一 takeover 文件的 `-t "snapshot baseline during remote probe"`，没有运行整包测试。源码及测试在这批最终验证期间保持不变，后续仅记录文档与里程碑；修复后的有效代码评审必须重新绑定最终推送 HEAD。

## 交接边界

本机只跑相关测试。full exact-head CI 与真实 Codex 替身演练由 QA 按原判据负责；本实现节点不请求 full CI、不派 QA、不合并、不部署。
