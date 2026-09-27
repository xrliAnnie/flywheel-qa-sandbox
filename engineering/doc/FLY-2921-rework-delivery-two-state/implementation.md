# FLY-2921 返工投递收成两态 — 实施说明
Issue: FLY-2921 (https://linear.app/geoforge3d/issue/FLY-2921/病根修复-6-返工投递收成两态送达-失败交还-lead投给死体改投替身不再把整条-run-打-held6-张-46)
日期: 2026-09-26
基于: plan.md（Codex R4 APPROVED，blob 63bf95a）

本文件只记录实施与 plan 的对应关系、偏差和已知边界；设计本身以 plan.md 为准。

## 1. 与 FLY-2919 的合入顺序（Lead 已确认，问题 232cab63）

实施开工时 FLY-2919 仍未合入 main。按 plan C2 第 4 步 / §6.2 的兜底执行：

- **按活性换体的路径关闭。** `replaceWorkflowReworkActor` 只接受两种可在事务内复核的死亡证明：
  `unlaunched_rollback`（该执行体有 `unlaunched_admission_rolled_back` 或
  `rework_replacement_launch_rolled_back` 事实）和 `launch_abandoned`（该执行体的 dispatch
  ledger 为 `abandoned`）。会话终态、窗格消失 / dead_pin、驻留 hold 到期、内容缺失，都只是
  「需要核验」的理由：在现有授权范围内请求收体（`closeActorForReworkSupersession`，只在投递
  `pending` 或未推送的 `turn_granted` 时），然后按活性未知处理。
- **活性未知**：未推送的投递计一次失败（满 5 次交还 Lead）；已推送的 `turn_granted` 只复探加告警，
  未知满 2 小时交还 Lead（`liveness_unknown_timeout:*`，这是「未知超时后照常交还 Lead」的落点）；
  `wake_delivered` 只复探加 30 分钟 / 2 小时两档告警。
- **不接 2919 的受控收尾入口**：running / `wake_delivered` 的目标不发收体请求。

**2919 后合入时怎么打开被关闭的路径**：在 `replaceWorkflowReworkActor` 的 `proof` 联合类型里加入
2919 的「受信进程证据（执行体 + 代次）」一种，事务内按执行体与物理代次复核；协调器
`unverifiedDeath` 在请求收体后先取 2919 证据，证死就走 `replaceActor`；running /
`wake_delivered` 目标的收体改走 2919 的 `close_requested` 入口。2919 改死体扫描时必须保留本单
C6.1/C6.2 的「未关账返工目标 → 交给协调器」守卫（`handOffDeadReworkTargetToCoordinator`）。

## 2. 对照 plan 的落点

| plan | 代码 |
|---|---|
| C1 五态、两列事实、迁移、旧迁移按列跳过、维护断言 | `StateStore.migrateWorkflowReworkDeliveryTwoState`、`migrateWorkflowReworkDeliveryBudget`、`assertMaintenanceSchema` |
| C1 推送写事实不写状态 | `markWorkflowReworkWakeSent`（与投递时钟 `sent_at` 同事务） |
| C1 签收从 `turn_granted` 接收、交卷顺带签收自愈 | `projectWorkflowReworkWakeReceiptTx`、`settleWorkflowReworkOnCompletionTx`、`closeReworkReturnedToLeadHoldTx` |
| C2 单事务换体 + 预算 3 + 每版本回执 | `materializeReworkReplacementCoreTx`、`replaceWorkflowReworkActor`、`countReworkReplacementsSinceLeadResumeTx` |
| C2 启动中动作表 a–f、defer、活性未知两档告警 | 协调器 `reconcileLaunchingReplacement`、`deferWorkflowReworkDelivery`、`noteWorkflowReworkLiveness` |
| C2 Lead 重投复位同一个 wake（busy 可重试） | 协调器 `rearmReworkWake` 效果 + flywheel-comm `resumeTurnWakeHold` / delivery-operations |
| C3 失败唯一终点 + delivery 作用域门 + 前置条件 + 重投 | `settleWorkflowReworkFailure(Tx)`、`hold-shape-registry` 新形状、`workflowHoldAuthoritativePrecondition`、`applyStateWorkflowHoldResumeActionTx` |
| C3.6 founder `/rework` 兼容 | `openOperatorRework` |
| C4.1–C4.5 | `rollbackUnlaunchedWorkflowAdmission`、`escalateUnlaunchedWorkflowStall`、`watch.ts`、`holdUndeliverableTx`、`markReworkReplacementContentMissingTx` |
| C4.6 暂存取消永不落地 | `delivery-operations.ts`、flywheel-comm `cancelTurnWakeDelivery` |
| C5 驻留 hold 第二次返工 | `resident-wake-fence.ts`、`enterResidentHoldForCompletionTx` |
| C6 替身只有一条铸造路 | `handOffDeadReworkTargetToCoordinator`、`rollbackDeadWorkflowNodeExecution` 守卫、`allocateWorkflowResumeFallback`、调度器启动围栏 |
| C7 交卷必须有新提交 | `rework-completion-evidence.ts`、`event-route.ts`、`commitWorkflowTransitionTx`、flywheel-comm `complete` |
| C8 消费者 | 调度器、巡检账本、hook 白名单、签收分类器、告警 disposition、runbook、529 脚本 |

## 3. 与 plan 的偏差（均为实现细节，逐条说明）

1. **`deferWorkflowReworkDelivery` 也接受「未推送的 `turn_granted`」**。plan 写「只作用于 pending」。
   Lead 重投后 wake 复位返回 `busy` 时，崩溃恢复路径上投递可能已是未推送的 `turn_granted`，
   也需要不计失败地延后；已推送的行仍走复探调度。
2. **回滚脚本对 `migrated:held:` 前缀的行恢复成 `held`**（plan 只列了 `returned_to_lead → needs_lead`）。
   这样 held run 上旧的窗格交接门在旧代码里仍能工作，恢复更精确；其余行按 plan 映射。
3. **C6.1 的「提醒协调器」每个（请求, 路由版本, 执行体）只发一次**（事件
   `rework_dead_target_handoff:*`）。每个调度 tick 都把 `next_retry_at` 置为 now 会抹掉退避，
   让未推送投递在几秒内连计 5 次失败。
4. **`returned_activation_already_consumed` 没有保留旧名别名**：2026-09-26T18:57:15Z 扫描本仓
   `packages/`、`scripts/`、`lead-rules-base/` 与本机 `~/.claude/plugins/cache/*/`，除 StateStore 里说明改名的
   注释外零匹配；插件 fork 源 `xrliAnnie/claude-plugins-official` 未检查。它是 HTTP 拒绝原因字符串，
   不是 CLI 子命令，别名无已知对象。事件 kind
   `rework_needs_lead_cleaned` 保留原名，保证事件历史连续。
5. **founder `/rework` 替换已交还的返工时顺带关闭那扇 Lead 门**，避免 active run 上留下一个
   只会报 `rework_target_superseded` 的幽灵门。
6. **推进事件 UID 带上路由版本**（`rework_delivery_<to>:<req>:<rev>`）。一个请求在换体 / 重投后
   会在新版本上再次 `pending→turn_granted`，按请求一个 UID 会撞 `workflow_event_uid_conflict`。

## 4. 删除清单（死代码）

- 状态：`awaiting_receipt`、`replacement_pending`、`needs_lead`、`held`（仅返工投递表）。
- `StateStore.materializeWorkflowReworkReplacement`（并入共用核心）、`settleHeldReworkRecoveryFailure`、
  `validateNeedsLeadReworkQuiescenceTx`、`openReworkContentUndeliverableTx`（改为
  `markReworkReplacementContentMissingTx`）。
- `settleWorkflowReworkFailure` 的 `onExhausted` / `terminal` 参数、冻 run、撤节点预留、验证路径置
  `needs_lead` 分支；`advanceWorkflowReworkDelivery` 的 `→awaiting_receipt|replacement_pending|held`
  与 `alertIdentity` / `nextRetryAt` 参数。
- 调度器 held 窗格恢复块、`heldReworkRecoveryProbeAt`、`replacement_pending` 物化分支、
  `settleHeldReworkRecoveryFailure` 包装。
- 协调器 `markReplacementPending`、`handoff_held_pane_loss`、`awaiting_receipt` 推进。
- `resident-wake-fence` 的 `resident_hold_already_woken`。
- `watch.ts` 返工「投不到」半边。
- `scripts/fly-1648-hot-loop-closeout.mjs` 及其两个测试（Lead 确认删除，问题 67a24662；git 历史留档）。

三种旧返工 hold 形状（`rework_activation_stalled_held` / `rework_pane_loss_handoff` /
`rework_retry_exhausted`）保留解码，前置条件读 `returned_to_lead`；本单之后不再产生。

## 5. 已知边界

- **2919 合入前**：会话终态但进程已死的返工目标不会自动换体，会在约 15 分钟（未推送）或 2 小时
  （已推送未签收）后交还 Lead；`wake_delivered` 后目标死亡只告警。这是 plan 为防「账面终态当死亡、
  在活体旁造替身」而选的 fail-closed。
- phase_wake 家族「投不到」冻 run 不在本单范围（plan §7）。
- 现存 held run 上的 8 行返工投递只映射字面值，不自动解冻；由原门、FLY-2922 统一入口或 terminate 处理。

## 6. 代码评审记录

Codex `gpt-6-astra` xhigh，线程 `01a0df1a-4e97-7402-a389-23f45bf8f21e`，原文见同目录 `codex-code-review-r1.md`～`r5.md`。

| 轮次 | 结论 | 处理 |
|---|---|---|
| R1 | CHANGES REQUESTED：3 MAJOR | 返工 TURN wake 的通用冻结交回协调器；Lead 重投后等待启动围栏按启动阈值有界计失败；`/rework` 清理后的拒绝改为抛出、整笔回滚 |
| R2 | R1 全部关闭；1 MAJOR | 重投复位与推进之间崩溃会让巡检取消 wake：仍归该执行体的 `pending/returned_to_lead` 返工改为 `wait` |
| R3 | R2 关闭；1 MAJOR | 长期 `wait` 占满巡检每轮额度：`wait` 不计额度 |
| R4 | 1 MAJOR | 上限只抬高饥饿阈值：改为单轮内单调前进的扫描游标（`claimDueTurnWake` 新增 `after`），无上限、无排除列表 |
| R5 | **APPROVED** | — |

每轮修复都有回归测试，并做过突变验证（撤掉修复后测试转红，突变装载以标记计数确认）。

补记：按 Lead 对问题 4dcfc95b 的裁定（批准必须是对确切 head 的全量复核），R5 之后又对 PR head `1fade6296` 做了全量复核 R6，结论 **APPROVED**（`codex-code-review-r6.md`）。

## 7. QA 返工 1（QA FAIL @ 1fade6296）

QA 依据：exact-head CI 36268153912 在 Quick Gate、teamlead 分片、light、script 分片变红，本地另有三处阻断。全部根因与修复：

| 失败 | 根因 | 修复 |
|---|---|---|
| Quick Gate：FLY-2006 retention consumer gate | 529 脚本新增的 `hold_resumed` 不存在判断是对 `workflow_run_event` 的 anti-join，未登记 | 配置登记为 `protect`（归档回执会让脚本误判门仍开着） |
| fly1674 residue | 新回归 `fly2921-rework-wake-no-freeze` 引用 hold 形状名 `three_stage_turn_stuck` | 精确白名单 |
| fly2337 / StateStore.patrol-tick | 夹具往五态表插退役的 `held` | 改为 `returned_to_lead`（守卫已按新字面值判断） |
| lead-token-savings drift | `flywheel-comm/src/db.ts` 字节变化，兼容摘要未刷新 | 逐块审计（只动 TURN wake 原语）后重钉哈希并补 rationale |
| config feature-flags drift | C7 新增环境变量 `FLYWHEEL_REWORK_DELTA_TIMEOUT_MS` 未归类 | `NON_FLAG_ALLOWLIST` 登记为调参旋钮 |
| required wall-clock thresholds | C7 超时测试用真实耗时上限断言 | 改为以 `rework_delta_unverified` 审计事件证明超时路径 |
| Script Tests 4/6 容量护栏（1038s/1020s，86%） | 与 main 同一分片对比：增量来自 `test-cmux-sync.sh`（+88s）与 `pnpm build`（+37s），均非本改动 | 未自行 rerun，报 Lead 裁定 |

教训：这几处都不在我当初的「相关测试」清单里。改动 CHECK 字面值、被钉哈希的共享文件、环境变量和 CI 门配置时，要按字面值 / 路径做全仓 `git grep`，再把命中的测试与门都纳入本地验证。

## 8. QA 返工 2（QA FAIL @ 55592737f：PR 与 main 冲突）

QA 依据：PR #1364 对 origin/main `1f5626254` 为 CONFLICTING/DIRTY，唯一内容冲突在
`packages/teamlead/src/__tests__/fixtures/fly2567/compatibility.json`。本轮只做技术同步，不改产品代码。

- 合并提交 `b69ebc639`（`Merge origin/main (1f5626254) …`），merge-base `d52df7841`。
- 冲突只在 `bootstrap-generator` 一组：main（FLY-2911）在 rationale 中插入 `getQuestionOrder` 说明并重钉
  `flywheel-comm/src/db.ts`；本分支追加 FLY-2921 TURN wake 原语说明并重钉同一文件。解法：保留 main 的
  rationale 原文，末尾追加本单那句；db.ts 钉到合并后的字节 `a150357b…`。合并后的 db.ts 恰好等于
  base + FLY-2911 的 11 行 `getQuestionOrder` + 本单已评审的 TURN wake 改动。
  `runner-patrol-rules.md` / `patrol-runbook` 两组 main 未动，保留本分支条目。7 组成员哈希逐个对合并树复核一致。
- 双方都改、git 自动合并的文件：`db.ts`、`StateStore.ts`、`event-route.ts`、`plugin.ts`、
  `workflow-engine-dispatcher.ts`、`truth.ts`、`fly-2006-retention-consumer-gate.config.json`。
  main 侧改动（FLY-2911 / 2883 / 2891 / 2882 / 2941 / 2934）不读写退役的返工投递状态，也不调用本单删改的函数。
- 上一轮 QA 记录的 `feature-flags-registry` 旧硬编码断言（36 vs 38）随 main 的 FLY-2934 一起消失，合并后 57/57。

本地验证（合并 head `b69ebc639`）：

| 项 | 结果 |
|---|---|
| `pnpm lint` | exit 0，0 error（25 条仓库既有 warning） |
| `pnpm --filter "flywheel-teamlead..." build` | exit 0 |
| `pnpm --filter "...flywheel-comm" --filter "...flywheel-config" typecheck` | exit 0（先补建 `voice-codex` 依赖的 `flywheel-voice-bridge` dist） |
| 显式 vitest（一文件一命令，52 个文件） | 52/52 文件、1570 条全绿：本单改动的全部测试文件 + fixture 三个消费者 + 重叠文件上 main 新增/修改的测试 |
| 脚本 | retention consumer gate 测试 10/10 + 门本身 `ok:true`；`qa-generalized-e2e-lib` 55/55；`qa-fly-2456-rework-adopt` 51/51；`fly1674-residue` 89 断言 PASS |

未跑 `vitest related`：本轮我写的唯一文件是 JSON fixture，`git grep` 按全路径 / 文件名 / 父目录只命中
`lead-token-savings-drift`、`-generator-oracle`、`-launch` 三个测试（已跑）；其余 diff 是 main 已在自身 CI
验过的代码，对 `StateStore.ts` 等枢纽文件跑 related 等于整包全量，不在本地范围。exact-head 全量 CI 与
两 Lead 529 复测由 QA 在新 head 上负责。

代码评审：对合并提交做只读 Codex 评审 R8（`codex:rescue`），结论 **APPROVED**，0 finding，原文见 `codex-code-review-r8.md`。

## 9. QA 返工 3（QA FAIL @ 72be5fc30：exact-head CI Script Tests 1/6 红）

QA 依据：exact-head 全量 CI run `36292915296` 只有 Script Tests 1/6 失败，失败项是
`scripts/__tests__/test-claude-lead-session-start-adopt.test.sh` 的
`repeated installer convergence blocked or failed under a tty`（17 passed / 1 failed）。另一项是两 Lead 529 在
step 0-1 后中止，属 QA 复测范围，实现侧无法补跑。

本 diff 没有改这个测试，也没有改它测的 `claude-lead.sh` 安装函数。这是测试 harness 本来就有的竞态：

- 日志时间：上一条 PASS 在 `04:11:04.6917`，`installer pty attempt 1 timed out` 在 `04:11:04.7630`，
  只隔 71ms；harness 的 deadline 是 30s，而且报错里已经捕获到安装器的成功行（`hook installed`）。
- 读循环只有三个出口：`poll()` 非 None、deadline 到、`os.read` 抛 `OSError` 后 `break`。71ms 排除 deadline；
  若是第一个出口，后面的 `poll()` 不会返回 None。所以只能是：Linux 上子进程最后一个 slave fd 关闭时，
  master 的 read 抛 EIO，而这时子进程还不能被回收，紧接着的 `poll()` 仍为 None，被当成超时 SIGKILL。
- 修复（`2b8ef4a7f`，测试文件 +5/-2）：读循环后用剩余 deadline 调 `process.wait(timeout=…)`，只有
  `TimeoutExpired` 才判超时；非零退出仍照报。产品代码零改动。Lead 对问题 `6f359a0b` 裁定在本 PR 内修，不另开单。

复现与验证（本机是 macOS，pty 挂断语义和 Linux 不同，没有另起 Linux 虚拟机）：

| 项 | 结果 |
|---|---|
| 同构 harness + 「master 空读改抛 EIO」模拟 Linux，子进程关 pty 后 0.3s 才退出 | 旧逻辑：9ms 报 `attempt 1 timed out`，输出含 `installed`（与 CI 同形）；新逻辑通过 |
| 反例（新逻辑） | 真挂死仍在 deadline 超时；关 pty 后挂死仍超时；关 pty 后 `exit 3` 仍报 `exited 3` |
| 真实文件里的 harness 原样提取 + 真实安装器，建模「EIO 后下一次 `poll()` 仍为 None」 | 基线 `72be5fc30` 走进超时分支失败；修复后通过；探针确认竞态窗口各触发 1 次；不建模的对照也通过 |
| 改动的测试文件本机连跑 6 次 | 每次 18 passed, 0 failed |
| `bash -n`、`git diff --check` | 通过 |
| `pnpm lint` | exit 0（25 条仓库既有 warning） |

另外做过一次「加宽窗口」实验（安装器后 `exec 0<&- 1>&- 2>&-; sleep 0.3`），但真实安装器那一路在 macOS 上
直到进程退出才收到挂断，旧 harness 也通过了。所以它不算 RED 证据，上表没有用它。

消费者发现：按全路径 / 文件名 `git grep -lF` 只命中 `.github/workflows/ci.yml`（调用方，未改）和
FLY-1751 / FLY-2562 / FLY-2799 的历史文档（排除）；父目录 `scripts/__tests__` 的 903 处命中只是路径同目录，
不依赖本文件行为（排除）。没有改包源码或 TypeScript，所以不需要 build、typecheck 和 `vitest related`。
exact-head 全量 CI 与两 Lead 529 复测由 QA 在新 head 上负责。

代码评审：对 `2b8ef4a7f` 做只读 Codex 评审 R9（`codex:rescue`，xhigh），结论 **APPROVED**，0 finding，原文见 `codex-code-review-r9.md`。

## 10. QA 返工 4（QA FAIL @ b74dff7ae：PR 与 main 再次冲突）

QA 依据：PR #1364 的 head `b74dff7ae` 对 `origin/main` `975822f5d` 为 DIRTY；唯一内容冲突在
`packages/teamlead/src/StateStore.ts`。本轮合并 main，不重做 FLY-2921 产品设计。

冲突来自 FLY-2921 的返工换体重构与 main 的 FLY-2900 quota-standby 保护落在同一段：

- FLY-2921 已把公开的 `materializeWorkflowReworkReplacement` 收进私有共用核心
  `materializeReworkReplacementCoreTx`；该核心既服务「证明旧体死亡后换体」，也服务合法的 resume fallback。
- main 在旧公开入口上新增 `codexQuota.isCodexQuotaStandby(deadExecutionId)` 零写保护。把它机械塞进共用核心会
  错杀 resume fallback，所以保护落在新的公开死亡换体入口 `replaceWorkflowReworkActor`：quota standby 直接返回
  `codex_quota_standby`，由 quota resume/fallback lane 接管，数据库零写。
- `freezeRunTx` 同时保留两道保护：返工 TURN wake 先交还 coordinator，普通 quota-standby recipient 再交给 quota
  resume lane；两者都不把 run 打 held。
- 文件尾部同时保留 FLY-2921 的 `handOffDeadReworkTargetToCoordinator` 与 FLY-2900 的 writer migration helper。

新增回归 `leaves a quota-standby rework actor to the quota resume lane`：构造 pending rework、未启动回滚死亡证明和
同一 execution 的 standby carrier，调用 `replaceWorkflowReworkActor`，断言返回 `codex_quota_standby`，并对所有用户表
做前后快照相等断言。

本地验证（合并中工作树；只跑相关测试）：

| 项 | 结果 |
|---|---|
| `pnpm --filter "flywheel-teamlead..." build` | exit 0；13 个受影响包及依赖构建成功 |
| 六个显式行为文件（一文件一命令） | 6/6 文件、402/402：workflow-rework 110、workflow-engine-transition 75、quota-standby 49、no-freeze 2、dispatcher 150、quota-fallback 16 |
| `vitest related src/StateStore.ts src/__tests__/StateStore.workflow-rework.test.ts --run` | **不计通过**：它把 StateStore 展开成 600+ 文件；Lead 因并发 Runner 令主机负载升至 130–185 而中止（指令 `42bf9d72-e9d6-47ff-84a6-e496aafb3ffa`），本轮不再运行 |
| related timeout 复核 | dispatcher 150/150、workflow-rework E2E 9/9、retention 29/29；post-ship 58/58（同一具体文件，`--testTimeout=20000`；默认 5s 下失败用例每轮漂移，均为 timeout、无断言差异） |
| `pnpm lint` | exit 0（25 条仓库既有 warning） |
| `git diff --check` / `git diff --cached --check` | exit 0 |

格式补充：默认 Biome 因 `StateStore.ts` 为 3.0 MiB（仓库上限 1.0 MiB）跳过它；强制 4 MiB 检查会要求重排
整份文件的既有 imports/format，并报 main 新增段的既有 `useTemplate`，本轮没有为两处冲突做 3 MiB 机械重排。
新增测试文件的默认 Biome 检查通过，TypeScript 则由上述 build 完整检查。

测试发现与排除记录：

- 字面值 `rework_wake_owned_by_coordinator` 唯一测试命中
  `fly2921-rework-wake-no-freeze.test.ts`，已跑。
- 字面值 `codex_quota_standby` 的保留行为文件：`StateStore.codex-quota-standby.test.ts`、
  `StateStore.workflow-rework.test.ts`、`workflow-engine-dispatcher.test.ts`、`quota-fallback.test.ts`，已跑。
  排除 `feature-flags-drift.test.ts`、`feature-flags-registry.test.ts`（配置登记）、
  `workflow-resume-resolver.test.ts`（resume resolver）、`codex-quota-outbox.test.ts`（通知 outbox）、
  `flag-store-runtime.test.ts` / `kind-contract.test.ts`（静态登记）、`capacity-permit.test.ts`、
  `resume-loop.test.ts`、`standby-bench.test.ts`（未触及的 quota 子系统）；其中 StateStore 的传递消费者另由
  `vitest related` 覆盖。
- `StateStore.workflow-rework.test.ts` 的全路径/文件名搜索只命中文档、证据清单和
  `packages/teamlead/ci-test-costs.json`，没有另一份可执行测试消费者。
- `StateStore.ts` 的全路径/文件名搜索命中的可执行静态守卫
  `feature-flags-drift`、`fly1808-wave-a`、`fly2396-authorship-boundary`、`fly2398-narrow-boundary`、
  `StateStore.land-carryover`、`StateStore.workflow-gate-card-lifecycle`、`fly2248-mechanism-guards`、
  `fly2278-retirement`、`fly2278-settle`、`hold-shape-registry`、`workflow-dispatch-seams.structure`、
  `ship-judgment-history-disabled`、`workflow-gate-fence-wiring` 以及 `auto-narrow-rollback-precheck.test.sh`、
  `fly1674-residue.test.sh`、`fly2403-design-model-comparison.test.sh`、`qa-fly-2456-*` 都只消费文件路径、
  结构或库存，不依赖这次 quota/rework 冲突语义，故不纳入显式集合；部分真实传递消费者已由 related 自动执行。
- 父目录字面值 `packages/teamlead/src` / `packages/teamlead/src/__tests__` 命中整个包的共址文件，不能证明依赖；
  这些目录共址命中全部按「仅父目录相同」排除，没有用它们枚举整包来模拟全套测试。

exact-head 全量 CI 与两 Lead 529 复测仍由 QA 在新 head 上负责；本轮没有请求 full CI，也没有把被 Lead
中止的 related 图当成绿证据。
