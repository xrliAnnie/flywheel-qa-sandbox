# Design Review — plan.md (Round 1)

Date: 2026-09-09
Author: Codex
Status: CHANGES REQUESTED

## Summary

本方案找到的 Flywheel 接缝基本正确：正常 goal 终态后 daemon session 仍存活，app-server v2 的 `thread/start.config` 也确实支持 dotted config override；同 daemon、只读触发线程、保留 Codex 原生限额守卫、只读取证和 fail-open teardown 的方向值得保留。

但当前版本还不能实现核心承诺。最直接的阻塞是 Codex 0.153.2 会把 `memories.min_rollout_idle_hours=0` clamp 成 1 小时，因此刚结束的 runner 根线程不会成为 stage1 候选。现有实验蒸馏的是约 4 天前结束的线程，不能证明收尾即时蒸馏。与此同时，keyed home 的 `count leases == 1` 只是瞬时观察，检查后仍可有新执行准入；若未来解除 1 小时 clamp，全家级 idle override 就可能捞到另一执行仍在写的 rollout。轮询、关停和成本回执还各有会产生假 `done`、延迟受控关停或伪精确数据的缺口。

结论为 `CHANGES REQUESTED`。先解决下列合同问题，再进入实现；无需改 FLY-2359 的运输逻辑。

## What's Good (Keep)

- 根因方向正确：Codex 原生 memories 是新根 session 启动时的异步管线，runner closeout 前复用同一 daemon 是当前架构中可行的触发接缝。`CodexDaemonGoalRuntime.runGoal()` 正常返回后会清掉 `running`，但保留 live session，直至 adapter `finally` 调用 `stop()`。
- `thread/start` 的 `config`、`baseInstructions`、`sandbox`、`approvalPolicy` 参数均与 0.153.2 app-server v2 协议一致；不设 `ephemeral`、给触发线程 `generate_memories=false` 的意图也正确。
- 保留默认 25% rate-limit guard、10 天年龄窗和原生 6 小时 phase2 cooldown，避免绕过 founder 账号配额保护；不回填 288 个旧家也是正确的范围控制。
- 触发线程 `read-only + never`、回执不含正文/prompt/凭据、SQLite readonly、原子 0600 写入、蒸馏异常不改变原 goal outcome，符合现有安全和 fail-open closeout 风格。
- FLY-2359 被当作下游运输依赖而不是本单改造对象，边界正确；529 exact-head、真实模型、RED 变异和非模板内容证据比只跑单元测试更可信。
- `better-sqlite3` 已存在于 workspace lock/allow-list 中，新增 claude-runner 直接依赖在构建层面可行。

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

1. **[BLOCKER] `min_rollout_idle_hours=0` 在 Codex 0.153.2 中不会生效。**

   **Why it matters:** `config/src/types.rs:391-394` 对有效值执行 `.clamp(1, 48)`。计划 §3.2 R3 虽然能把 JSON override 送进 config manager，最终仍会得到 1 小时。候选 SQL 又在 `state/src/runtime/memories.rs:239-247` 要求 `threads.updated_at_ms <= idle_cutoff`，所以刚刚终态的 `outcome.threadId` 不会被 claim。现有 scratchpad 实验使用 2026-09-05 的旧线程，于 2026-09-09 触发；它只证明“老于 1 小时的线程可蒸馏”，没有验证本方案的收尾路径。按当前状态机，该执行很可能在 60 秒后被记成 `done/no_new_jobs`，与一句话承诺和 E1 直接冲突。

   **Suggested fix:** 先重新做架构决策，不能按现计划实现。可选方向只有：(a) 明确允许并交付一个解除 1 小时下限的受控 Codex 版本/升级版本，并增加二进制版本闸和“目标线程终态后 <1 分钟即被 claim”的真机证据；或 (b) 改为 Flywheel 显式蒸馏/其他能按 thread id 定向触发的机制；或 (c) 接受至少 1 小时后的异步补偿并重写产品承诺、时序和验收。若继续坚持“不改 Codex 二进制 + 5 分钟 closeout + 本次线程当场蒸馏”，三者在 0.153.2 上不可同时满足。

2. **[BLOCKER] `countCodexAgentHomeLeases(home) === 1` 不是蒸馏期间的并发授权。**

   **Why it matters:** `codex-home.ts:572-640` 的 admit 只在短期 mkdir lock 内列 leases，然后允许创建新的 lease；蒸馏侧检查返回后没有任何东西阻止第二个执行进入同一 keyed home。全家级 idle override 会扫描所有合格线程，而不是只扫描 `outcome.threadId`。因此存在 check-then-admit TOCTOU：收尾执行认为自己唯一，随后新执行进入并开始写 rollout，蒸馏线程可能读取半截内容。现有家锁 `staleMs=60_000`，也不能原样持有 5 分钟当 fence，否则会被判 stale。另且 C4 要求“非目录返回 0”会把现有 `listCodexAgentHomeLeases()` 明确拒绝的 unsafe/symlink leases 路径误判成“无人共享”，这是 fail-open。

   **Suggested fix:** 为整个 override 窗口定义 mutation-time admission fence：admit 必须在创建 lease 前识别它，fence 要有 owner、deadline、崩溃恢复和明确释放；或改用 Codex 能按目标 thread 定向 claim 的能力。增加多进程 race 测试：蒸馏检查完成后并发 admit，必须是新 admit 等待/蒸馏跳过，而不是两者同时进行。非目录、symlink、拒读必须抛错并转为显式 skip，不能返回 0。若“绝不改 FLY-2358 准入/lease”仍是硬边界，则 keyed-home 全局 idle override 不能被宣称安全，需要交 Lead 重新裁定。

3. **[HIGH] `jobs` 全表的“无 running + 任意变化”不是管线完成屏障，会产生假 `done`。**

   **Why it matters:** Codex 在 `start.rs:77-80` 先 await phase1，再进入 phase2；stage1 job 已变 `done`、phase2 global job 尚未 claim 的短窗口内，§3.3 条件已经成立，adapter 可立刻停 daemon。反方向，S0 中由旧 worker 留下的 `running` 行会让本次通道无关地等满 5 分钟。任意 job 失败或变为 pending 同样满足“发生变化且无 running”，仍会被叫作 `done`。`memories/` 目录在 rate guard 前就会创建，60 秒目录存在也不能证明 no-candidate；更不能把“目标线程因 1 小时 clamp 不合格”当成功。

   **Suggested fix:** 把成功定义绑定到本次触发和目标：至少要求 `kind=memory_stage1 AND job_key=outcome.threadId AND worker_id=triggerThreadId AND status=done`，并在 receipt 中分别表达 target stage1、其他 claimed jobs 和 phase2。只等待本 worker claim 的 running jobs；旧 worker 行只记录，不作为本次 barrier。若本 worker claim 了 phase2，则等其 terminal；若没 claim，明确记 `phase2=not_observed/cooldown_or_guard_unknown`，不要冒充已完成。建议把 closeout 保证简化为“目标 stage1 已持久化，phase2 best-effort”，并增加 `stage1_done → phase2 尚未 claim`、旧 running、job failed、无候选四类时序测试。

4. **[HIGH] 插入点、错误路径、受控关停与时间预算的合同互相矛盾。**

   **Why it matters:** 计划要求在 try 内 `outcome` 赋值后调用；若 `runGoal` throw，控制流直接进入 catch，`caughtError` 直到 catch 才赋值，因此该调用根本看不到 `caughtError`，无法按 R2 写 `distill_skipped:no_session`。而一个 awaited 5 分钟操作放在 `finally` 之前，事实上会延迟 `finally`，与“永不阻塞 finally”不符。现有 `phaseLifecycle.waitForShutdown()` 在 goal 赢得 race 后仍可稍后 resolve，但计划只检查已有的 `controlledShutdownRequestId`；收尾蒸馏期间新到的 shutdown 会被拖到预算结束。最后，`waitBudgetMs` 只约束轮询，`thread/start` 和 `turn/start` 各自默认还可等待 30 秒，DB/回执操作也未计入，因此 §6 的“影响上限 = waitBudgetMs”不成立。

   **Suggested fix:** 画出并实现一个单一 closeout 控制流：先让 goal settle 并保存 outcome/error；在现有 `finally` 中完成必须立即执行的 watcher/TUI 取消后、`runtime.stop()` 前做可选 distill；所有 distill 错误只写状态，不改原结果。保留同一个 shutdown promise/AbortSignal，并让任何晚到受控关停立即中止轮询、停止 daemon、走原 ack 顺序。用从通道开始计算的 absolute deadline，把 remaining time 传给两个 RPC、sleep 和读取；`startThread` 也需可传 timeout。文档应改为“boundedly delays teardown but never bypasses it”，并测试 goal throw、晚到 shutdown、RPC 卡住、DB 读取超时。

5. **[HIGH] `cost.triggerTurnTokens` 的来源和精度声明不符合 0.153.2 数据模型。**

   **Why it matters:** `state/migrations/0001_threads.sql:12` 的 `threads.tokens_used` 只有一个总数；`state/src/extract.rs:105-110` 写入的是 `total_token_usage.total_tokens`，无法给出 input/cachedInput/output 三项。R4 又明确不等 `turn/completed`，读取时甚至可能尚未写完。准确 breakdown 实际存在于 `thread/tokenUsage/updated` notification（`app-server-protocol/.../thread.rs:1834-1909`），但当前 client 只有一个 `setEvents` 槽，`runGoalToTerminal` 返回时会清空 listener；计划没有新增触发 turn 的监听/终态 seam。`stage1InputTokensEstimate` 所称 filtered bytes/70% cap 还要求复现 Codex rollout 过滤、序列化和模型 context window，C2 仅描述读取 memories DB，数据来源不足。

   **Suggested fix:** 二选一并保持 schema 诚实：(a) 在 client 增加按 trigger thread/turn scope 的 terminal + token usage 订阅，等待 `turn/completed` 并从 notification 记录 exact breakdown；或 (b) receipt 只保留 DB 能证明的 `totalTokens`，且标明读取时点和可能不完整，删除 input/cached/output/E6 的断言。stage1 估算必须列出实际输入来源和逐步算法；若只读 rollout 文件原始字节，就命名为 raw-rollout approximation，不得声称 filtered/capped。为跨执行汇总固定 null/unknown 语义，并测试 notification 串线、turn 失败和缺 token 事件。

6. **[MEDIUM] `withLiveClient<T>(fn)` 没有完整承载 R1 的“client 与 home 来自同一 runtime”约束。**

   **Why it matters:** runtime 的 `session` 同时保存 `client` 与 `codexHome`，但 C3 只把 client 借给 callback；adapter 再使用外层局部 `codexHome` 就不再是计划声称的单一 runtime 权威。仅检查 `session != null` 也不等于 transport 仍 live，client 已有 `isClosed()` 语义。此外，异步 callback 与并发 `stop()` 的所有权关系未定义。

   **Suggested fix:** 让 runtime 暴露一个受控的 closeout lease，例如 callback 收到只读 `{client, codexHome}`，进入时同时验证 `!stopped && !running && session && !client.isClosed()`，callback 结束前阻止第二次 borrow；`stop()` 到来则通过 AbortSignal 取消它。adapter 不接受另一条 home path。测试 runtime 选择的 home 与 client 成对、closed transport 返回 null、borrow 中 stop 可终止且最终 drained。

7. **[MEDIUM] kill switch 的 observable 行为有三种互斥说法。**

   **Why it matters:** R2/状态词表说 disabled 会写 `distill_skipped:disabled`；§3.5 说关闭后与今日完全一致；E5 和 C5 测试又要求无回执/零调用。实现者无法同时满足，也会让回滚验证不确定。

   **Suggested fix:** 采用最小且可逆的合同：生产组合在调用通道前判断 `enabled=false`，零 thread/turn、零 DB、零回执，仅打一条不含敏感信息的启动期 warn 或配置日志；从 receipt reason 枚举移除 `disabled`。若 Lead 需要每次执行都有 disabled receipt，则反过来修改“完全一致”、E5 和零调用测试，明确这是可观察行为变化。

8. **[HIGH] E4 没有给出可重复证明 FLY-2359 legacy → keyed 运输的前置状态与顺序。**

   **Why it matters:** FLY-2359 只在 keyed home 首次、零租约 admit 时扫描合格 legacy execution homes，并以 manifest 永久封账；已存在的 manifest 不重扫。当前 main 已有 FLY-2358 keyed homes，正常新 implement 任务通常不会自然产出一个新的 legacy home。E4 的“如果是 keyed 就只验证下一次 keyed 读取”不能替代 Lead 明确要求的完整 `真实任务 → 蒸馏 → retire → 下一家 seed`；若目标 identity 已封 manifest，本次新 legacy 内容也永远不会被导入。

   **Suggested fix:** 不改 FLY-2359 运输代码，但在 QA runbook 固定一个从未 admit/无 manifest 的 `(project, role)` identity，并明确怎样先由真实 Codex 任务产生一个 FLY-2359 可识别、已终态且稳定的 legacy source，再部署含两 PR 的 exact head 做首次 keyed admit。保存 source session 身份行、legacy home hash、retire、首次 manifest/snapshot/index、首轮 tool-read 全链证据。E4 必须在 FLY-2359 落地后成为最终 gate；`blocked_on_FLY-2359` 只能是中间状态，keyed 半程不能算满足 (a)。若在现有架构无法自然产生该 legacy source，应先让 Lead确认可接受的房间搭建方法，而不是用已蒸馏 fixture 替代真实自动生成。

9. **[MEDIUM] 生产接线和文件安全步骤仍有未落到具体 seam 的地方。**

   **Why it matters:** `packages/claude-runner/src/index.ts` 只是导出；实际 production adapter composition 在 `packages/teamlead/src/bridge/run-infra.ts:757-782`。C6 写“index.ts（或生产组合处）”会允许实现只加类型/导出而生产永远不启用。回执 `attempt` 要读取旧 `<executionId>.json`，但 §6 只约束目录和临时文件；若旧 receipt 是 symlink、非普通文件、过大或 schema/identity 不符，直接读取会违反“symlink 一律拒绝”并可能把任意 JSON 当重放权威。

   **Suggested fix:** C6 明确修改 `teamlead/src/bridge/run-infra.ts`，在 composition 时一次解析 env，并在 teamlead 的 run-infra 接线测试中断言 default on、精确 `off`、其他值 warn+on；`index.ts` 只承担必要导出。为旧 receipt 读取规定 `lstat/open(O_NOFOLLOW)/fstat`、普通文件与大小上限、version/executionId/home 校验；异常旧文件 fail-open 为本次独立 attempt（并记录安全错误），不得跟随或覆盖其目标。补 receipt symlink/非普通文件/畸形/身份不符测试。

## Verdict

CHANGES REQUESTED — address items above
