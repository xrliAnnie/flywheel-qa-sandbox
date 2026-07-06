# FLY-887 三段式 phase-session 并存保活 — QA 报告

Issue: FLY-887 (https://linear.app/geoforge3d/issue/FLY-887/pipeline-三段式-phase-session-并存保活-designimplementqa-不跑完就关qaimplement)
日期: 2026-07-05 / 2026-07-06(round 2 + round 3 + round 4 + round 5)
基于: plan.md

## Round 5（FLY-902 独立 QA session，验收 R2：merge 收敛 + per-phase 模型零 Sonnet + channel 门控）：PASS

**独立性声明**：本轮由 FLY-902（独立 Linear issue）的 QA session 执行，与 R1-R4 的 implement
session（同一个 Claude Opus 4.8 self-QA）不是同一个 session。为避免碰三段式自己的共享 worktree
（TURN 机制下不该被无关 session 触碰），本轮在一个独立的 detached-HEAD git worktree
（`git worktree add --detach <path> 7daa635b`）里验收，全程**零代码改动**，只读+跑测试+审计。

### 验收范围对照（issue 原文 5 条）

**1. per-phase model 零 Sonnet + label-bypass 矩阵**：PASS。
`packages/config/src/three-stage-phases.ts` 的 `DEFAULT_PHASE_TIER` 确认为
`{design: heavy, implement: heavy, qa: medium}` → `{claude-fable-5, claude-fable-5,
claude-opus-4-8}`，`zero-Sonnet invariant` 单测存在且绿。核对
`packages/teamlead/src/bridge/role-adapter-resolver.ts` 确认 label 层（Task override）确实排在
`dispatchModel` 之前——这正是「必须 bypass label 层」这条设计判断成立的前提。四路
`ignoreRunnerLabelSelection: true`（入场 `runs-route.ts` / 交接+修复 spawn `phase-orchestrator.ts`
三处 / retry `actions.ts`+`retry-dispatcher.ts`+`run-dispatcher.ts`）全部核对到位。读了
`run-dispatcher.fly887-label-bypass.test.ts`：真的调用生产函数 `buildRunnerSpawnFields`，断言
`sonnet`/`fable-1m`/`codex`/`agy`/`kimi` label 全部逃不出 phase 表，外加一条「同样的 label 不带
phase seam 时行为不变」的字节兼容哨兵——不是形式主义占位测试。`actions-retry-route.test.ts` 的
retry 矩阵（失败 phase 行 / 存量 sorter-pin 行 / 无持久模型行 / main 行字节兼容）同样是真实调用。

**2. channel 门控**：PASS。`three-stage-policy.test.ts` 覆盖 缺失/命中/未命中/不可解析/空数组/
kill-switch 优先级/入场路径 全部场景；`ConfigLoader.test.ts` 覆盖合法/空数组/缺失/非数组/裸数字/
空字符串。生产 `.flywheel/config.yaml` 里 `three_stage_channels: ["1516209714097291335"]` 核对
`~/.flywheel/projects.json` 确认就是 `flywheel-eng-lead`（Tadashi）自己的 `chatChannel`——即本
issue 自己的 dispatch 路径逻辑自洽。

**3. merge 收敛（887/892 语义共存）**：PASS。`git log` 确认 `9040ae4c` 是真正的 `git merge`
（非 rebase/squash），R1 的两个 reconcile 修复 commit（`0d51ea3c`、`19ead1d6`）在 PR head 历史里
可达——之前验过的 SHA 链没被 force-push 冲掉。`StateStore.getPhaseSessionsForIssue`（887 语义，
全 status 全行，供 keep-alive wake 目标 + ship 收尾）与 `getLatestPhaseSessionsForIssue`（892
改名后语义，每 role 最新一行，供 pipeline header）并存，调用点各自独立
（`event-route.ts` 用后者、keep-alive/finalization 代码用前者），未见交叉误用。

**4. R1 keep-alive 回归抽查**（非重跑完整 529 Room E2E——Lead 已确认这轮不需要）：PASS。
`phase-orchestrator.fly887-keepalive` / `StateStore.fly887-keepalive` /
`Blueprint.fly887-worktree-takeover` / `Blueprint.fly887-keepalive-prompt` /
`post-ship-finalization.fly887` / `run-dispatcher-fly887-turn-seam` 全部在本轮全量测试里通过，
不在下面任何一个失败列表里。

**5. 全仓测试 + lint**：PASS，细节见下。

### 全仓测试结果

在独立 worktree 里 `pnpm build`（16 个包全绿，0 TS 报错）+ 逐包 `pnpm test`（约 8300+ 用例）。
除以下几类**环境性失败**外全绿，且每一类都在**未改动的 `origin/main`、同一台机器 / 同一个
Runner 环境**里独立复现，证明与本 PR 的 diff 无关（而不是照抄 PR 描述里的自述）：

| 失败 | 数量 | 根因 | 是否复现于 main |
|---|---|---|---|
| `flywheel-cli/resolve-project.test.ts` | 1 | 本环境 `TMPDIR` 嵌在 `~/.flywheel` 之下，测试断言"walk up 找不到 `.flywheel/`"失效 | ✅ 复现 |
| `teamlead/codex-lead-runtime.test.ts` | 22 | 同上：`FLYWHEEL_CODEX_LEAD_WORKSPACE` 重叠检查撞上本环境的 runner-state tmp 路径 | ✅ 复现 |
| `teamlead/LeadAlertNotifier.test.ts` | 1 | 本 Runner `process.env` 里有真实 Discord bot token，泄进期望 mock token 的断言 | ✅ 复现 |
| `teamlead/createLeadRuntime-preflight.test.ts` | 2 | 同类环境问题 | ✅ 复现 |
| `teamlead/fly247-bash-suites.test.ts` | 1 | tmux 高负载超时（`vitest-worker onTaskUpdate timeout`） | ✅ 复现 |
| `flywheel-comm/await-codex-gate.test.ts`（STALE reviewedHeadSha） | 1 | 硬编码 5s 超时，在我自己并发跑测试造成的机器高负载下超时 | 单独重跑在 main 和 PR head 上都秒过（非复现，确认纯 flaky） |

以上 27 处环境性失败 + 1 处并发负载 flaky，**零处可归因于 FLY-887 R2 的代码改动**。

### Lint

PR head（`7daa635b`）`pnpm lint` **exit 0**：0 error，14 个 warning，且这 14 个 warning 全部落在
本 PR **完全没有改动过**的文件里（`DirectEventSink.test.ts` / `heartbeat-quiet-suppression.test.ts`
/ `runner-idle-watchdog-quiet.test.ts` / `scripts/qa-fly-863-codex-hold-signal-e2e.mjs`，用
`git diff origin/main...origin/flywheel-FLY-887 -- <这些文件>` 核实为空 diff）。满足「本 PR 触及
文件 lint clean」。

### 结论：PASS

FLY-902 issue 原文列出的 5 条验收范围全部独立验证通过，本 session 未修改任何实现代码。建议 Annie
在 ship gate 批准，Lead 作为 executor 执行 merge。

## Round 4（Annie 加的功能：phase-session 可观测状态行）：PASS + 修了一个真发现

Annie 要求把"phase-session 可观测"（一条随三段状态更新的 Discord 消息，如
`🎨design(parked)·🔨implement(active)·🧪qa(pending)`）直接加进 887，不开 follow-up。

**实现**（commit `ffa72f65`）：`computePhaseLineStates`/`renderPhaseStatusLine` 纯函数
（`phase-orchestrator.ts`）+ `AutoQaEffects.refreshPhaseStatusLine`（post 一次、之后原地
edit，零 churn，不 pin——镜像 FLY-560 attach-pin 的 edit/repost/404 语义但去掉了 pin，
因为测试 slot bot 没有 MANAGE_MESSAGES 权限、且 Annie 只要"能更新"不要求"置顶"）+
StateStore 两个新列迁移。挂在 `onPhaseComplete`（每次 handoff 后）+ `onQaResult`
（PASS/FAIL 后）两处，覆盖三段式全部状态转移。35 个新/改测试全绿。

**真机验证**（隔离 slot 3、全走真实 Discord 对话、fresh issue FLY-896）：

- 用 Discord REST API 直接读消息，**同一个 message id** 在 design 完成、
  implement→qa 交接、FAIL→fix→复验 PASS 全程被原地 PATCH（`edited_timestamp`
  逐次变化,不是刷屏新消息）——这正是 Annie 要看的"一条可更新的行"。
- **3 段并存硬证据**（Annie 明确要求亲眼看到）：在 QA FAIL、implement 正在修复、
  design 仍 parked 的那一刻，截了 `tmux list-windows` + `ps` 快照，design/
  implement/qa **三个进程/窗口同时存活**，逐字贴在真机验证报告里。
- Ship 后消息内容**完整可读、不是 404**，但发现一个真问题（见下）。

**Finding B（已修）**：ship 收尾时状态行从未刷新到最终态——`finalizeThreeStagePhases`
把 design/implement 关成 completed 后，没有人叫它把状态行也刷成
`.../done/done/done`，导致消息内容停留在 ship 前的最后一次更新。已修：给
`makeFinalizeThreeStagePhases` 加了第三个可选参数 `refreshPhaseStatusLine`，在
design/implement 都已经关成 completed **之后**调用（这样 QA 也早已是终态，三段全部
读成 done）。`plugin.ts` 侧用了跟 `phaseOrchestratorHolder`/`autoQaCoordinatorHolder`
同款的 forward-reference holder 模式接线（因为 `finalizeThreeStagePhases` 的构造点
早于 `phaseQaEffects` 实例化）。新增 3 个测试（正常刷新读到 completed 状态、
刷新抛错被吞掉不影响收尾、不传这个参数时字节兼容不报错）。

**Finding A（既有问题，不是本 PR 引入的回归，建议单独开 follow-up）**：真机验证中，
implement 修复轮次完成后，Bridge 自动唤醒 QA 复验没有触发。根因（已追踪到
`phase-orchestrator.ts`）：`onPhaseComplete` 的守卫要求 session 状态**精确等于**
`awaiting_review` 才判定为 handoff 边界；如果 runner 在调用 `complete` 之前，先**同步**
跑完了 Codex review（跳过了通常的异步窗口），session 状态可能在事件真正被处理前就已经
从 `awaiting_review` 跑到了 `completed`/`approved_to_ship`，守卫因此静默 no-op、不触发
唤醒。`reconcileOnStartup` 也补不上这个洞（它只处理 design 角色的 stranded 情况，
不处理 implement）。这次是 fail-closed（没有损坏任何东西，只是卡住等人工介入），而且
QA 那次真机验证过程中 QA 自己也独立发现了同一类问题并主动标注——两处独立发现互相印证。
这个守卫/reconcile 逻辑本 PR 完全没碰，是 FLY-793 时代就有的既有逻辑，建议单独开
issue（FLY-887/FLY-827 关联）跟进，不阻塞本次 ship。

**Finding C（既有的、次要的、可接受的 cosmetic 时序）**：每次 handoff 刚发生的瞬间，
刚激活的那个 phase 会先显示 `(pending)` 而不是 `(active)`，要等到**下一次**转移才会
纠正——因为 `refreshPhaseStatusLine` 在 `handoff()` 之后立即同步调用，此时被唤醒/新建
的目标 session 状态还没来得及翻到 `running`。纯观感问题，自我纠正，符合当初"最小版、
只读 session status、不查 CommDB parked 标记"的设计取舍（Tadashi 已认可），留作已知
限制，不修。

## Round 3（Annie 指定：全 Discord 叙事重跑）：PASS，给 founder 的可读证据

Round 2 的 529 Room E2E 走的是直接 API 旁路驱动，没有一条完整的 Discord 叙事。
Annie 要求重跑一次、全程走真实 Discord 对话，产出一条她能自己点开读完的 thread。

**Discord thread（founder 可直接打开查看）：**
https://discord.com/channels/1485787271192907816/1523516456409759814

用专门新建的 issue FLY-895（避免复用 round 2 的 FLY-202 造成混淆）。这条 thread
里有 15 条真实、按时间顺序发出的消息，完整读出：session 启动 → design 完成
（parked，明确标注没关）→ implement 启动 → 🛑 ship 授权需要founder拍板（Lead
正确拒绝自批）→ implement 完成→QA 启动 → QA 未通过、**唤醒同一个 implement**
修复（第 1 轮，真实的一处小毛病：新加的一条记录漏了句尾句号）→ fix-loop 更新
（implement 修好、push、PR 更新）→ ship → 完工。

**关键：** 在 implement 正在修复、design 仍 park 着的那一刻真实重启了一次 Bridge。
启动日志原文：「reconcileOnStartup: 666972eb...(FLY-895) already progressed
past design (live downstream phase) — skip stale handoff replay」。重启前后
session/TURN/tmux 窗口数量零漂移，implement 那个 pane 全程没断。Annie 六条
目标运行时行为逐条再次确认，和 round 2 PASS 完全一致（详见下方 round 2 章节）。

诚实的小观察（不是 bug，FLY-887 没碰这段既有逻辑）：QA 复验 PASS 那次，Lead 的
消息模板只在 FAIL 时发专门一条，PASS 没有单独一条字面消息——能从后续的
fix-loop 更新 + ship 徽标 + 完工消息推断出来。这是 FLY-793 既有的消息模板特征，
留作观察，不阻塞本次 ship。

测试 slot 已按标准拆除（Bridge/tmux/worktree/CommDB），Discord thread 本身不
受影响，现在仍可正常打开查看。

## Round 2 结论：PASS

本轮验证 round 1 的修复（commit `0d51ea3c`）+ 补一处新发现的边界情况（commit
`19ead1d6`）+ Tadashi 要求的隔离 529 QA Room 真机全链路 E2E（硬门槛）。三项全过。

### 1. Round 1 回归修复验证：PASS

`reconcileOnStartup` 的 `hasProgressedPastDesign` 守卫（`0d51ea3c`）确认解决了
round 1 发现的问题——重放已经合法 park 的 design session 不再误触发 design→
implement handoff、不再从活体 QA fix-loop 手里夺走 TURN。

- 之前 FAIL 报告里提交的回归测试（`phase-orchestrator.fly887-keepalive.test.ts`
  "FLY-887 QA FINDING" describe block）现在 **GREEN**（14/14），含两条哨兵测试
  钉住守卫两侧行为（真崩溃 remnant 仍会重驱 handoff；QA 分支单独测试仍会跳过）。
- 全仓测试重新跑一遍：teamlead 4900+ passed（另有 9 个失败只在**满并行跑全仓**
  时出现，单独/小范围重跑 100% 绿——已确认是资源争用导致的环境性 flake，跟本次
  改动无关，同 round 1 报告里记录的 codex-lead-runtime.test.ts 环境性失败同类）；
  flywheel-comm 732/732、config 323/323、edge-worker 1054/1054（+5 skipped，
  memory-supabase-live 环境性跳过）全绿。Lint 对本 PR 改动的文件干净（另有 14 条
  警告在本 PR 完全未碰的既有文件里，与本次改动无关）。CI 绿（PR #458）。

### 2. 新发现 + 修复：reconcile 分不清"真崩溃"和"已 ship"

代码审查中发现 `hasProgressedPastDesign` 的 round-1 修复本身还留了一条更窄的缝：
`getAlivePhaseSession` 只看**活体**行，如果 Bridge 恰好崩在
`finalizeThreeStagePhases` 收尾中途——已经把 implement 关成 `completed`（不再
"活"）、但还没轮到关 design（design 仍停在 `design_done`）——下次重启时
`hasProgressedPastDesign` 会把这个"已经 ship 完、只是收尾中途崩溃"的 design
误判成"implement 从未起来过的真崩溃 remnant"，重新在**已经合并的 issue** 上
spawn 一个全新 implement。

已跟 Tadashi 确认后在本 PR 内补上小而安全的修复：新 dep
`hasShipFinalizationClaim(issueId)`，查 `runPostShipFinalization` 的原子
per-issue claim 事件（`post_ship_finalization_claim`，已有的
`countEventsByIssueAndType` 复用）是否存在，OR 进 `hasProgressedPastDesign`。
一个真崩溃、从未 ship 过的 implement 不会有这个 claim 事件，所以守卫本身要保护
的"真 remnant 仍要重驱"行为不受影响。两条新哨兵测试钉住两侧：已 ship 完
（claim 存在）→跳过；从未 ship（claim 不存在）→仍重驱。16/16（fly887-keepalive
套件）+ 58/58（含 legacy keep-alive-OFF 套件）全绿。commit `19ead1d6`。

### 3. 529 Room 真机全链路 E2E：PASS（Tadashi 要求的硬门槛，已完成）

单测/集成测试证明不了的东西——真实 tmux 进程活体探测、真实共享 git worktree、
真实 CommDB TURN 表、以及**真实 Bridge 进程重启**——这轮用一个隔离测试环境
（slot 2）真机跑通了完整链路：park→wake→TURN→FAIL→wake-fix→wake-retest→PASS→
**穿插两次真实 Bridge 重启**→founder-approve→ship→三段统一收尾→worktree 删除→
teardown。部署源用一次性 sandbox 分支 `qa-e2e-887-scratch`（把两个跟本 PR 无关
的既有假测试密钥 fixture 中和掉，只为绕过 sandbox 仓库的 push-protection 误报，
从未碰真正的 PR 分支——Tadashi 已确认这个处理方式并明确不去点 GitHub 的
"allow this secret"）。

Annie 六条目标运行时行为（plan.md「目标运行时行为」表）逐条真机验证：

- **Design park + Implement 原地接管同一 worktree**：PASS——两者
  `worktree_path` 完全一致（无 `-design`/`-implement` 后缀分裂），两个 OS
  进程验证同时存活，Bridge log 记录 handoff。
- **Implement park + QA 接管同一 worktree、QA 可写**：PASS——QA 真的把测试
  文件/报告 commit 到共享分支上（`git log` 验证多个 commit）。
- **QA FAIL → wake 同一 implement 修 → wake 同一 QA 复验 → PASS**：PASS——
  Bridge log 逐字确认「wake」用的是**同一个 execution_id**、不是重新 spawn；
  TURN epoch 正确递增；implement/QA 各自的 `turn --exec-id` 自查在动手前答
  `yours`；QA 复验时 worktree 已在新 head，零 fetch/checkout。
- **穿插 Bridge 重启不误触发（本 PR 修的核心场景）**：PASS——两次独立重启，
  Design 仍停在 `design_done` 且下游活体/已推进时，Bridge 启动日志逐字打出
  `... already progressed past design (live downstream phase) — skip stale
  handoff replay`，session 数/TURN 行/tmux 窗口数量在重启前后**零漂移**。
  并且验证了对照组：设计刚 park、下游真的还没起来时，重启**正确地**重新驱动了
  handoff（证明守卫是真的在判断,不是无脑跳过）。
- **Ship 后统一收尾**：PASS——founder-approve 模拟后，QA 走完整 ship 序列，
  两个 parked 段（design + implement）都被 `closeRunner(finalizeDone)` 关成
  `completed`，`three_stage_turn` 表被清空该行，共享 worktree **只在此刻**才被
  删除（之前全程未删），Linear issue 自动标 Done。

**发现的两个与本 PR 无关的既有问题**（不阻塞本次 ship，建议开 follow-up）：

1. `pipelineConfigByProject` 在 Bridge **启动时**读入缓存一次，不是每次请求都
   重新读——测试/部署时改 `.flywheel/config.yaml` 的 `pipeline.three_stage`
   需要重启 Bridge 才生效。纯工具/文档层面的坑，不是运行时 bug。
2. **FLY-827 Codex 硬闸 ↔ 三段式 QA-as-ship-executor 的一处真实交互缝隙**：
   `codex_review_result` 的接收方只认 main/implement 角色的 session
   （`auto-qa-coordinator.ts` `isReviewableRole` 门），而三段式下最终执行 ship
   的是 QA 这个 session 自己的 exec-id——E2E 里验证 `verify-approval` 走这条
   路径时卡住过，只能手动在隔离测试库里直接插一行 `approved` 记录绕过。这是
   FLY-793（三段式本身）就已经存在的既有交互问题，本 PR 完全没碰
   `auto-qa-coordinator.ts` 的这段逻辑，**不是** FLY-887 引入的新 bug，但既然
   本仓库自己（flywheel 项目）三段式已经打开（`.flywheel/config.yaml`
   `three_stage: true`），这条缝隙值得单独立一个 follow-up issue 排查——如果
   本仓库的 Codex 硬闸也生效，未来某个三段式 issue 走到 ship 这一步可能会撞上
   同样的卡点。

E2E 过程中还有一处已核实无害的操作插曲：E2E agent 有一次误用了自己 shell 继承
的生产环境变量（`FLYWHEEL_BRIDGE_URL`/`FLYWHEEL_ISSUE_ID` 等，来自它自己作为
Runner 的身份）把一条 `codex-review-result` 事件发到了本仓库自己的生产 Bridge
（issue FLY-887 本身）。已读代码确认：`onCodexReviewResult` 对未知/不可复核角色
的 `targetExecutionId` 只是 log warning 后直接 return，不落任何状态改动——生产
上只多了一条无害的 orphan `session_events` 审计行，没有任何副作用。

### 结论

Round 2 验证 + 新边界修复 + 真机全链路 E2E 全部 PASS。Annie 的核心诉求
（QA↔implement 修复循环不丢 context、不重开、不费 token）在真实 Bridge 重启
穿插下得到了真机层面的证实，而不仅仅是 mock 测试层面。建议进入 approve gate。

---

## Round 1 结论：FAIL（已修复，见上）

代码级审查 + 测试执行发现一处 **高严重度、可复现的正确性 bug**：`reconcileOnStartup`
（Bridge 每次启动/重启都会跑）在 keep-alive 模式下会在**每一次 Bridge 重启**时错误地对
已经合法 park 的 design session 重新触发 design→implement handoff —— 无论流水线实际
已经推进到哪一步，都会把共享 worktree 的 TURN 从当前合法持有者（例如正在 fix-loop 中的
QA）夺走并错误地转授给 implement，还会给 implement 发一条它的 prompt 从未教过它处理的
"retest"（QA 专用措辞）唤醒消息。这个问题会在生产上**每次 Bridge 重启**都复发（本项目
重启 Bridge 是常态操作），直接违背了 FLY-887 本身要解决的核心诉求（"不丢 context、不被
打断的 fix 循环"）。

## 已验证通过的部分（代码级，非常扎实）

逐条对照 plan.md 的机制设计（M1-M9,7 处改动面 + kill-switch），全部实现与设计一致:

- **TURN 表 + `turn` 命令**（`db.ts` / `turn.ts`）: UPSERT + epoch 自增语义正确;
  `turn` 命令 yours/not-yours/no-turn 三态 + 正确的 exit code 契约（真失败才 exit 1）。
- **PhaseOrchestrator.handoff()**: 四态 liveness（alive/dead_pin/absent/indeterminate）
  处理正确，`indeterminate` 严格 fail-closed（不 park、不 close、不动 TURN）;
  wake-or-spawn 路径里 `grantTurn` 严格先于 `wakePhaseRunner`（真实测试从 fake
  `blueprint.run` 内部读表验证 happens-before，非仅断言调用顺序）。
- **`assertPhaseWorktreeReady`** 在 wake 前的 dirty/head-mismatch fail-closed 校验到位
  （handoff 和 fix-loop 两处都过）。
- **RunDispatcher pre-launch TURN grant seam**：`run-dispatcher-fly887-turn-seam.test.ts`
  用真实 fake `blueprint.run` 读表证明了"launch 前 TURN 已落"，覆盖 fresh spawn/两条
  spawn 兜底/kill-switch OFF 哨兵。
- **Blueprint worktree 原地接管**：`Blueprint.fly887-worktree-takeover.test.ts` 用**真
  git 临时仓**（非 mock）验证 dirty/HEAD-drift 时 fail-closed 拒绝接管，clean+HEAD 匹配
  时正确复用。
- **`runFailFlowKeepAlive`**：`recordFixRound` insert-or-read 幂等语义 + cap 检查 +
  wake(fix)/spawn 兜底路径全部符合设计;多轮验证测试证明 round 正确递增。
- **post-ship 收尾顺序**：`post-ship-finalization.fly887.test.ts` 用真实
  `WorkflowFSM`+`DirectiveExecutor`+`StateStore` 证明 `finalizeThreeStagePhases` 严格
  先于 `removeCleanWorktree` 调用，且正确把 parked design/implement 转 completed、
  保留 shipped QA session 原状、删除 TURN 行。
- **kill-switch**（`FLYWHEEL_THREE_STAGE_KEEPALIVE`）：默认 ON，registry 已登记
  （`feature-flags-drift.test.ts` 不会漏检），`=0` 时逐字回退旧 close+respawn 行为
  （legacy 测试套件专门用 `keepAliveEnabled: false` 跑，是有效的 byte-compat 哨兵）。
- **Prompt 文案**：design/implement 段的 park 契约 + 强制 turn 自查 + QA FAIL 段的新
  RE-TEST 措辞，snapshot 测试全绿；`declare-state` → `park` 的 drive-by 修正（含
  auto-QA prompt 那处同类潜在 bug）已生效。

全仓测试：teamlead 4862 passed / edge-worker 1054 passed / flywheel-comm 732 passed /
config 323 passed（另有 24 个 `codex-lead-runtime.test.ts` 失败是已知环境性问题——QA
runner 自己的 TMPDIR 落在 `~/.flywheel` 下触发该文件的安全校验，与本 PR 无关，该文件
根本不在 diff 里；用干净 TMPDIR 重跑 117/117 全过）。CI 绿（PR #458）。Lint 干净。

## FAIL 发现：`reconcileOnStartup` 在 keep-alive 下每次重启都会误触发过期 handoff

### 根因

`StateStore.getStrandedDesignPhaseSessions()`（pre-FLY-887 既有查询）：

```sql
SELECT * FROM sessions WHERE session_role = 'design' AND status = 'design_done'
```

这个查询在 FLY-793 时代的语义是"implement 从未真正起来过的崩溃残留"——因为当时
design_done 只是一个**转瞬即逝**的中间状态（handoff 立刻把它关掉+起 implement）。

FLY-887 keep-alive 把这个假设打破了：design session park 之后会**永久停留**在
`design_done`（这正是"park 不退出"的字面含义），直到 ship 才被 `finalizeThreeStagePhases`
转成 `completed`。于是 `getStrandedDesignPhaseSessions()` 现在**分不清"真崩溃残留"
和"健康 park 中，流水线早就往前走了"**——两者在这个查询看来一模一样。

`reconcileOnStartup()`（`phase-orchestrator.ts:310`）在**每次 Bridge 启动/重启时无条件
执行**，把查到的每一行都重放进 `onPhaseComplete` → `handoff(design, 'implement')`。
`handoff()` 本身没有"这个 issue 是不是已经推进过 implement"的检查——它只看
`getAlivePhaseSession(issueId, 'implement')` 是否有活体，有就走 wake-or-spawn 的
wake 分支：

1. `capturePhaseHeadSha(prev)` 对**共享物理 worktree**跑 `git rev-parse HEAD`——不管
   design/implement/QA 谁的 session row 传进去，读到的都是同一个目录当前的 HEAD。
2. `assertPhaseWorktreeReady(target, headSha)` 拿这个刚读出来的 HEAD 去比对 target
   （被唤醒对象）的 worktree HEAD——因为是同一个物理目录，这个校验**永远同义反复地
   通过**，不管流水线实际推进到多远。
3. 于是 `grantTurn({execId: <implement>, phase: 'implement'})` 被调用——**把 TURN 从
   当前真正的持有者（可能是 QA，正在 fix-loop 里）夺走**，转授给 implement。
4. `wakePhaseRunner({session: implement, kind: 'retest', ...})` 被调用——发给
   implement 的措辞是（plugin.ts wakePhaseRunner 的 'retest' 分支）："the implement
   phase pushed a fix... re-run your **QA scenarios** and emit `qa-result` again"——
   这段话是写给 **QA** 的，implement 的 prompt 里从未教过它怎么处理一条 "RE-TEST" 唤醒
   （implement 只被教了怎么处理 "QA FIX" 唤醒）。

### 复现（已写成失败的回归测试，随本次 QA 一并提交）

`packages/teamlead/src/bridge/__tests__/phase-orchestrator.fly887-keepalive.test.ts`
新增 describe block "FLY-887 QA FINDING: reconcileOnStartup re-fires design→implement
on EVERY restart under keep-alive"：构造一个永久 park 在 `design_done` 的 design
session + 一个活体 implement（模拟"流水线早就往前走了"），跑
`reconcileOnStartup()`，断言 `grantTurn` / `wakePhaseRunner` / `start` 都不应被调用。
**当前实现下这个断言失败**——`grantTurn` 被以 `{execId: 'impl-exec', phase:
'implement'}` 调用了一次，证实了上面的分析。

跑法（在 packages/teamlead 下，注意用干净 TMPDIR 避开环境性噪音）：

```
TMPDIR=/tmp npx vitest run src/bridge/__tests__/phase-orchestrator.fly887-keepalive.test.ts
```

### 影响面

- **每次 Bridge 重启**都会对**每一个**"design 已完成但 issue 还没 ship"的三段式
  issue 触发一次——这不是罕见 corner case，是这个仓库的日常操作节奏（本仓库 changelog
  里 Bridge 重启是按天甚至按批次发生的）。
- TURN 被错误转授之后，真正应该持有 TURN 的一方（例如 mid-fix-loop 的 QA）下次做
  `turn --exec-id` 自查会看到 `not-yours`——而 QA/implement 的 prompt 契约里**没有
  教过"看到 not-yours 该怎么恢复"**，等于把一个健康的 fix-loop 卡死，需要人工
  （Lead）介入才能恢复。这正好是 Annie 提出 FLY-887 想要根治的那类"半途被打断、
  context 断裂"的问题的一个新变种。
- implement 收到不属于自己的 "retest" 唤醒文本后的实际行为不可预测（不在被教过的
  契约范围内）。

### 建议的修复方向（不越权替 implement 做决定，仅供参考）

`reconcileOnStartup` / `getStrandedDesignPhaseSessions` 需要加一个"这个 issue 是否已
经推进过 design"的判断，例如：只有当**该 issue 不存在任何活体的
implement/qa**（`getAlivePhaseSession` 对 implement 和 qa 都返回 undefined）时才认定
design_done 是"真崩溃残留"，否则视为"健康 park，无需重放"直接跳过。TURN 表本身也可以
作为第二重信号（TURN 当前指向别的 phase → 跳过）。

## 下一步

按协议：本次 QA 报告 FAIL，commit + push 这份报告和回归测试到本分支后立即
`qa-result --status fail`，然后 STOP 等待——流水线会关闭本 QA session 并起一个新的
Implement-fix session 来修复上述问题。

修复后建议：Tadashi（flywheel-eng-lead）已确认——鉴于这是自举流水线基建本身（restart-
gated feature），ship 前仍需在隔离 529 QA Room 补一次真机全链 E2E（真 park→真 wake→
TURN 轮转→穿插 Bridge 重启→ship 统一收尾 + fix-loop cap 3），而不是 ship 了当生产
canary 去发现问题。这次发现的 reconcile bug 恰好会在 E2E 的"穿插 Bridge 重启"步骤里
复现，建议先修好这个再进 529 Room，否则会在那一步白白撞上同一个已知问题。
