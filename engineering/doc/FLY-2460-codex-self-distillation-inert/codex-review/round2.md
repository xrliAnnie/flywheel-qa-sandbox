# Design Review — plan.md (Round 2)

Date: 2026-09-09
Author: Codex
Status: CHANGES REQUESTED

## Summary

v2 的架构改向是成立的：把触发点移到首次 daemon session 建立后、runner 自己的 thread 创建前，正确绕开了 Codex 0.153.2 的 1 小时 idle 下限；同 session 的 `{client, codexHome, signal}`、worker-bound job 观察、kill switch、生产接线和回执读取硬化也关闭了 Round 1 的大部分问题。Round 1 #1、#4、#5、#6、#7、#9 可视为已接受并在设计层修正；#2 不再使用不可靠的唯一 lease 判定，回到 Codex 原生 1 小时 idle 语义，这个方向可以保留。

仍不能批准实施，原因不是要求恢复 v1，而是 v2 内部还有两个产品/验收阻塞和几个实现合同缺口。第一，stage1 `done` 只把内容写入 `stage1_outputs`，模型首轮能读的是 phase2 生成的 `memory_summary.md`；计划同时允许 phase2 `not_claimed` 仍报 `done`，所以“一定在下一次执行第一轮读到”不成立。第二，原 Lead 要求的 legacy → FLY-2359 seed 全链已被 E7 明确移出本单，但替代口径的 Lead question 仍未答复；在权威要求改变前，不能把部分接受当作关闭。另有候选预计算与 Codex 真 claim 谓词不等价、distill 时间侵蚀原 goal deadline、负观察被写成确定事实等问题。

结论为 `CHANGES REQUESTED`。这些修正不需要改 FLY-2359 transport，也不需要重开已否决的 idle=0/lease-fence 方案。

## What's Good (Keep)

- **admit-time seam 正确。** `CodexDaemonGoalRuntime.runGoal()` 当前在 `startSession()` 后立即 `ensureThread()`；在两者之间加一次性的 `beforeFirstThread`，daemon 已活、runner rollout 尚不存在、goal listener 尚未安装，确实是触发上一批原生 memories 的干净位置。
- **1 小时 clamp 已被正确接受。** v2 不再承诺蒸馏刚结束的线程，实验也明确只证明约 4 天旧线程可被 claim；没有再用 `idle=0` 作为规范路径。
- **并发风险显著降低。** 不再把瞬时 lease count 当授权；使用 Codex 自己设计的 idle + watermark 更新语义，比 v1 的 TOCTOU 方案可靠，也没有扩大 FLY-2358 admission 协议。
- **barrier 比 v1 明确。** 等 trigger `turn/completed`，只观察 `worker_id=triggerThreadId` 的 stage1/phase2 行，不再被全表旧 `running` 行直接绑架；error/pending 也不再假装成功。
- **runtime 与取消边界合理。** hook 只收到同一 session 的 client/home，并由 `stop()` abort；restart/resume 不重跑，closeout 原路径不动。
- **成本字段已诚实收窄。** 不再从单一 `threads.tokens_used` 伪造 input/cached/output breakdown；stage1 只记录原始 rollout bytes 代理，phase2 token 保持 unknown。
- **运维与安全合同已对齐。** `off` 为零 hook/RPC/DB/receipt，接线点明确到 `packages/teamlead/src/bridge/run-infra.ts`；旧 receipt 使用 `O_NOFOLLOW`、`fstat`、大小和身份校验。
- **FLY-2359 边界保持。** v2 没有偷偷改变其白名单、manifest 或 seed 时机，并诚实说明新任务在 FLY-2358 后没有自然 legacy 人口。

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

1. **[BLOCKER] “下一次执行第一轮可读”仍不由该架构保证。**

   **Why it matters:** stage1 成功只写 `memories_1.sqlite.stage1_outputs`；实际 prompt read path 在 `ext/memories/src/prompts.rs:27-49` 读取 `memories/memory_summary.md`，该文件由 phase2 才生成。Codex 的 global phase2 在 `state/src/runtime/memories.rs:1159-1163` 无条件执行 6 小时成功冷却，即使刚出现新的 stage1 output 也会 skip。计划 §3.4 又把“全部 stage1 done + phase2 未 claim”定义为顶层 `done`。因此 T1 结束 1 小时后启动 T2 时，可以发生：T1 stage1 在 T2 hook 内完成，但 phase2 因冷却不运行，T2 runner thread 随后创建时仍读不到 T1；计划自己的 E4 也承认这种情况要等 ≥6 小时后的 T3。§1.1 和 exploration O3 所说“这样第一轮就能读到上一任经验”比 E4 实际保证更强。

   **Suggested fix:** 明确选择并统一一种承诺：(a) 把 v2 保证写成“下一次合格执行开工前持久化上一批 stage1；只有 phase2 在该 hook 内 claimed+done 时，本次首轮可读，否则由冷却后的后续执行读取”，并让 receipt 区分 `stage1_done` 与 `readable_memory_ready`；或 (b) 把首轮可读作为硬门时，要求该次 admit 已越过 6 小时 cooldown 且 phase2 done，否则不得声称通过。不要把 `phase2.not_claimed` 与可读意义上的 `done` 合并。同步修改一句话、Mermaid、O3、状态词表、E2/E4 和 founder 成本/延迟预期。

2. **[BLOCKER] Round 1 #8 仍是待 Lead 决策，不是已关闭的验收变更。**

   **Why it matters:** 原要求明确包含“真实任务 → 触发 → 非模板记忆 → retire → 下一家由 FLY-2359 seed 到”。v2 的事实判断是合理的：FLY-2358 以后有解析身份的新任务直接进入 keyed home，没有自然的新 legacy source；不回填旧家时，这条链无法由普通新任务产生。但 E7 现在直接写“不在本单证明”，而 `b24705c1` 仍未答复。计划 §1.3 不能在原验收权威尚未撤销时宣称 Lead 追加要求已有落点，设计也不能以“未答复前按默认”自行改变验收。

   **Suggested fix:** 等待并记录 `b24705c1` 的明确裁定后再关闭本项。若 Lead 接受 keyed-home E4，更新状态/决策引用，明确原 legacy→seed 要求已被 supersede，FLY-2359 从本单验收依赖移除；若不接受，则需要另定受控旧家人口/独立证据，但仍不应修改 FLY-2359 transport，也不能用 fixture 冒充自动生成。`E7=no natural population` 可以保留为事实和非目标说明，但不能代替权限变更。

3. **[HIGH] 本地 `candidates` 不是 Codex 0.153.2 真 claim 集，当前状态机没有覆盖差集。**

   **Why it matters:** Codex 的实际 selector 还包含 `threads.archived=0`、`threads.preview<>''`（`state/src/runtime/threads.rs:1383-1390`），允许的 interactive sources 是 `cli/vscode/atlas/chatgpt`，up-to-date 判断同时查看 `stage1_outputs.source_updated_at` 与 `jobs.last_success_watermark`，claim 还受 `retry_at`、`retry_remaining` 和全局 running cap 约束。v2 §3.1 使用 `archived_at IS NULL`、只列 `vscode/cli`、只看 jobs，并固定 10 天；但 R5 又让 Codex 继承 home 的实际 `max_rollout_age_days`。结果可能是本地列出的候选没有被 claim、Codex claim 了本地没列出的线程，或本地判断 0 后跳过本可运行的管线。尤其“至少一行被 claim，但部分预选项没被 claim”时，receipt 的 `after=absent` 已允许，§3.4 状态规则却既不把它算 done，也不把它归为 partial/skipped，顶层状态未定义。另：`memories_1.sqlite` 缺失应表示 jobs/output exclusion 为空，不应把已有 state threads 整体变成空候选。

   **Suggested fix:** 不要把预计算结果同时当成本优化、权威 candidate ledger 和成功判据。最小方案是将它命名为 `candidateHints/shouldTrigger`，采用 Codex eligibility 的保守上界决定是否发 RPC；最终 claimed set 只由本 worker 的 job 行确定，并单独列 `expectedButUnclaimed`、`claimedUnexpected`。若仍要逐条等价，就完整复制上述谓词并固定/读取同一个有效 max-age 合同。明确 `after=absent` 的顶层状态，分别处理 missing state DB（无线程）和 missing memories DB（无历史 jobs/output）。增加 preview 为空、output 已新但 job 缺失、retry backoff/exhausted、non-default max-age、atlas/chatgpt、running-cap 和部分 claim 测试。

4. **[HIGH] absolute deadline 起点和既有 goal timeout anchor 尚未正确传播。**

   **Why it matters:** §3.4 写 `deadline` 从 `thread/start` 成功起算，但 R3 同时要求给 `thread/start` 传“剩余预算”；在它成功之前尚无这个 deadline，候选 DB 读取和第一条 RPC 实际不受 5 分钟上限约束。更重要的是，现有 runtime 在 `codex-daemon-goal-runtime.ts:504` 于 session/hook 之前记录 `runStartedAt`，再在 :543 把它交给 `runGoalToTerminal` 作为 active/waiting deadline anchor。把最长 5 分钟 hook 插在中间会直接吃掉正常任务的 5 分钟 goal budget；这不是单纯“延迟第一轮”，会改变原任务 timeout 结果。

   **Suggested fix:** 在 hook 入口、候选读取之前建立唯一 absolute deadline，并把 remaining time 传给 DB busy timeout/check、`thread/start`、`turn/start` 和 sleeps；文档不要用“`waitBudgetMs + 两次 RPC`”这种可被理解为相加的表述。对 goal budget，保留原有跨 restart 不重置语义，但把 distill 实耗从 deadline 中剔除，例如将传给 goal loop 的 anchor 调整为 `originalRunStartedAt + distillWallMs`。增加一个测试：hook 耗满接近预算后，首次 goal 仍获得与变更前相同的 active duration；restart 仍复用同一调整后 anchor，不能再次加预算。

5. **[MEDIUM] 45 秒/15 秒的负观察被写成了确定的 `no_claim`/`not_claimed`。**

   **Why it matters:** memories startup 是 daemon 内独立 `tokio::spawn`；observer 在 45 秒或 15 秒窗口结束并清 listener 后，后台任务仍可能稍后 claim。此时 receipt 会写“未 claim”，runner thread 已开始，而同一 worker 的 job 随后出现；这既使回执失真，也可能让 phase2 与首轮 prompt 构建发生竞态。worker scoping 修掉了 v1 的全表假完成，但固定观察窗口仍不能证明否定事实。

   **Suggested fix:** 把字段和状态改成 `no_claim_observed_within_45s` / `phase2_not_observed_within_15s`，明确后台仍可能继续；若该状态要支撑“首轮可读”硬保证，就必须观察到 phase2 terminal done，不能以负观察放行并报 ready。测试注入在第 46 秒出现 stage1、在第 16 秒出现 phase2 的时序，验证 receipt 不会声称确定未 claim，也不会将其计入可读成功率。

6. **[MEDIUM] `liveLease` 无法由计划列出的 C2 输入可靠计算，且风险措辞过强。**

   **Why it matters:** `.flywheel-leases/` 文件名是 executionId，Codex `threads.id` 是 Codex threadId；`state_5.sqlite` 和 `memories_1.sqlite` 没有两者的 Flywheel 映射。C2 只拿 home/DB/stat seam，不能证明“该 threadId 对应执行的 lease 仍在”。同时，闲置 >1 小时但仍活的 rollout 被 phase2 合并后，可能在其恢复和再次蒸馏前短暂进入其他任务的 developer memory；这符合 Codex 原生可恢复水位模型，但不能绝对描述成“只重复成本，不会有错误内容”。

   **Suggested fix:** 该字段不参与授权，最简单是删除，保留 home-level lease count 也只作无归属注释；不要为了一个观测字段把 StateStore/CommDB 映射引进 distill 核心。把安全说明改成“沿用 Codex 对 >1h idle live thread 的 provisional-memory 风险；更新后会重蒸馏，但存在短暂陈旧窗口”，并在风险表中显式接受。若 Lead 确实要求 per-candidate liveness，另加有来源的 threadId→executionId loader 及映射失败的 unknown 状态。

7. **[LOW] 仍有几处可执行文档事实和验收断言需要同步。**

   **Why it matters:** Codex `config/src/types.rs:56-57,384-390` 将 `max_rollouts_per_startup` clamp 到 1–128，不是 1–8；8 是 `memories/write/src/lib.rs:81` 的 stage1 concurrency limit。plan §3.2、exploration §2.3、research §2 都把 8 写成 Codex clamp，来源不准确。research 标题仍是“收尾蒸馏通道”，§4 仍写“收尾后 DB 有本线程 stage1 done”，风险表还写“收尾继续”，不符合 v2 admit-time 口径。最后，receipt 允许 `triggerThreadTotalTokens.value=null` 却仍示例 `exact=true`，E6 只断言 `exact=true`，会让 null 也通过而不能满足成本采集要求。

   **Suggested fix:** 把 8 标成 Flywheel 自定 batch cap/与并发上限对齐，Codex schema 上限写 128；清掉 research 中剩余的 closeout 规范措辞（exploration O2 的显式否决历史可保留）。token schema 规定 `value=null ⇒ exact=false` 或增加 `availability`，E6 对实际触发路径断言 `value` 为非负整数；若 turn terminal 后 DB 行仍未可见，按剩余 deadline 短轮询并如实记 unavailable。

## Verdict

CHANGES REQUESTED — address items above
