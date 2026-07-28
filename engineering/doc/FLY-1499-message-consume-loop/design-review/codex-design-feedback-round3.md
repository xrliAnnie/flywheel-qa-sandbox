# Design Review — FLY-1499 plan.md (Round 3)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 对八项 Round 2 finding 的主体修复是有效的：AttemptHandle、phase transition、逐事务 disposal fence、runner/Lead 分支、注册校验、必填 epoch、EngineRuntime 和全 proposal 字节边界都已进入明确的实现与测试合同。当前仍有四个协议级阻断项：tick 驱动的实际时间线超出 v11 SLA 公式、terminal recipient 仍可继续收信、runner 在 marker 后停止 durable redelivery 且未维护公平计数，以及公开 `register()` 仍可绕过 runner 的原子换代；另有三项验收/边界问题需一并修正。本轮审查的 plan blob 与用户指定 `124506ee312a` 完全一致；当前 HEAD `6b236c25e035` 只是其后的 progress-only 提交，仓库仍未安装 `node_modules`，因此没有虚报包测试结果。

## What's Good (Keep)

- AttemptHandle 方案正确关闭了跨 retry 错结算：success/failure 都按 attemptUid 定位，并同时重验 message、完整 identity、mailbox recipient/state；`uid#1 timeout → uid#2 running → #1 late result` 的双出口反例也已进入 T4。
- `recordInjectedTx` 与 `reportDeliveryTimeoutTx` 将 marker/timeout 判定和 mutation 放进同一个 `BEGIN IMMEDIATE`，方向正确；actual `events` 表具备 `event_uid UNIQUE`、append-only update trigger 和 durable `created_at`，继续用它作 phase anchor 无需 schema migration。
- disposal 将 registry/activation/redirect-target 重验嵌入每个 mutation 事务，并删除 null-registry 放行，已经修掉 Round 2 的真实 TOCTOU；CAS 继续绑定 old recipient。
- coordinator 现已按 kind 构造，runner 不再调用 Lead converter；AttemptHandle 随 deliver 载荷下发、deliver backoff/no-busy-loop 也都有明确测试入口。
- 注册路径补齐 subject、active activation/generation、null-registry-with-running 和 resume exact-owner 校验；expectedCutoverEpoch 也已成为 public enqueue 的 runtime 必检字段。
- EngineRuntime 已进入主要入口/helper，lead pull 上限和 TDD 依赖顺序已修正；proposal 总 UTF-8 字节与字段级限制真正覆盖了 Round 2 的“大 effectKey、小 payload”反例。
- §11 新增的矩阵化断言、致红变异和无法独立变异时诚实标注，符合本项目对 guard/fallback 验收不许假绿的纪律。
- Round 1 已关闭的候选 SQL、STAT4 矩阵、配额算法、第五次失败账、canonical conflict、kernel add-only 和零接线边界均保持完好。

## Issues & Recommendations

1. **[HIGH] tick-only phase observation 与跨进程 settlement fallback 使实际最坏时间超过 v11 唯一 SLA 公式。** `plan.md:304` 称跨进程结算后等待下一 tick 已由公式“首项”预算，`plan.md:343-344` 又只在 tick 上判 deliver/T_max deadline；但 v11 只有一个全局 `T_tick`，另有的 tick 仅是目标 retry 的 `(R−1)×T_tick`，没有为每个 attempt slot 的 terminal observation 或两段 deadline 取整付费。最小反例取 `q=1,R=1,K=4`：`A=6`，若每次跨进程结算 hint 都丢，六个 slot 之间最多出现五次 tick 等待，而公式只给一次；attempt 恰在 tick 后启动时，deliver 和 T_max 各自还可再超近一个 tick。另一个未覆盖窗口是 `shim.deliver()` Promise 永不 settle：若唯一 runner drain 正在 await，它必须证明外部 watcher 仍可独立执行 timeout CAS，否则 `T_deliver_tot` 根本不是硬上限。建议为 deliver/T_max 配置独立的精确 deadline scheduler（周期 tick 仅作恢复兜底；这不同于已删除的 mailbox-due latency fast-path），并规定跨进程 proposal 必须路由回拥有 coordinator 的 EngineDriver，使 settlement commit 后可立即继续；若仍保留“下一 tick”作为每槽 fallback，则只能走正式设计修订重算公式。T6 增加 never-settling shim，T7 增加 attempt 刚错过 tick、所有跨进程 ring 丢失的对抗时间线，并按公式直接判红。

2. **[HIGH] terminal recipient 在 disposal 前后仍被 enqueue 当成可路由，新消息可以永久落回死信箱。** enqueue 目前只检查 registry 行存在（`plan.md:312`），而 disposal 为证明 authority 又要求 terminalIdentity 的 registry 行继续存在（`plan.md:352-355`）。runner activation 置 terminal 后、disposal 逐行执行期间乃至完成后，producer 因此仍可插入新 pending 消息；若 disposal 使用初始清单会漏行，若无限 drain 则持续 producer 可令它不终止。建议 enqueue 在同一 immediate 事务中把“可路由”收紧为：registry identity 存在，且 runner 对应 activation 仍 `active`；activation terminal mutation 与此读串行后，后来入队一律拒，之前提交的消息由 disposal 收完。若 generic Lead identity 也支持 terminal disposal，必须同样给出 durable routability/terminal 证据；否则将本批 disposal 类型明确收窄为 runner。T8 增加 activation terminal 后入队拒，以及 enqueue 与 disposal 各个 row transaction 间交错不留 pending 的测试。

3. **[HIGH] runner 分支仍未忠实实现权威 durable-deliver 和 K 配额状态。** 权威 final/v8 明确要求 runner `deliver` 带退避持续重试，直到观察 mailbox terminal 或 activation terminal；新版伪码却在 marker 存在后“不再重投”（`plan.md:298`），这把一次成功写入 vendor 的返回值变成了新的停止条件，属于未经 gate 批准的设计修订。marker 应只结束 deliver deadline、锚定首次注入时间，不应取消设计规定的幂等 redelivery；后续重投沿用同一 AttemptHandle，且绝不重置 T_max。与此同时，runner 的 new-message 分支调用 `selectNext` 后没有像 Lead 分支那样保存 `sel.nextStreak`：初值 K 下先服务一个 nf 后仍保持 K，会继续压过 founder；resume/redelivery 又必须避免重复计数。建议在 runner 新 attempt 成功 start 时恰好一次提交 nextStreak，并按既定 backoff 在 marker 后继续 deliver，直至 terminal/activation terminal。T5/T7 增加 Lead/runner 同候选流选择序列等价和 resume 不重复计数；T10 断言 marker 后仍重投、terminal 后立即停止。若 Lead 坚持 marker 后停止，必须把它作为显式 §1.2b 设计修订重新批准，不能标成普通 `[落地]`。

4. **[HIGH] public `register()` 仍为 runner 提供绕过 §1.6 原子换代的快捷路径。** `registerConsumerTx` 可被 batch 3 正确组合，但 `register(kernel,...)` 仍无条件包一层独立 `Kernel.write`（`plan.md:186-196`）。对已有 runner registry，它可以在旧 activation/capability 尚未同事务 terminal/revoke 时单独切 registry；对首次 runner 注册，也允许 activation/attempt 先提交、registry 后提交。仅验证“新 activation 已 active”不能替代 final §1.1 要求的 `{旧 activation terminal + capability revoke + 新 attempt/activation + registry cutover}` 单一 immediate 事务。建议将 convenience `register()` 限为 Lead；runner 注册只允许 batch-3 outer transaction 调 `registerConsumerTx`，或提供真正拥有全部四步的高阶原子 API。T1 增加 public runner shortcut 被拒，以及 outer transaction 任一 crash 点重放后仍恰一 active activation/current registry 的合同测试。

5. **[MEDIUM] marker conflict 的 read-back 仍未验证完整 canonical intent。** Round 2 要求错误 marker collision fail-loud；当前只比较 kind/payload（`plan.md:334`）。同 event_uid、同 `{attempt_uid}` payload 但错误 `cutover_epoch`/source fields 的行仍会被接受，其 `created_at` 随即成为 T_max anchor，可能提前或推迟换代。建议为 `pa.injected` 定义完整 canonical row（至少 kind、payload、source_kind/source_id、mailbox/current cutover_epoch；existing created_at 必须格式合法并作为唯一 anchor），read-back 逐字段核对，并保留该 event_uid prefix 给 engine 内部。T6 的 collision matrix 应覆盖 wrong kind、payload、source 和 epoch。另统一结果语义：marker-first 时 timeout helper 当前是 no-op，并非“后到必拒”；测试应断言 loser 零 mutation，而不是与文字矛盾地一律期待 throw。

6. **[MEDIUM] T8 指定的 successor interleaving 在真实 Kernel 上不可发生，无法兑现新增的 acceptance discipline。** 计划要求 successor “commit 精确插在重验与首 mutation 之间”（`plan.md:363,419`），但两者处于同一个 `Kernel.write(...).immediate()`；实际 `kernel.ts:291-309` 在回调前取得 `BEGIN IMMEDIATE` 写锁，批次1 QA 也已证第二 writer 只能等待/SQLITE_BUSY，绝不可能中途 commit。正确的验收应分两类：successor 在某个 per-row transaction 开始前先 commit → 该事务重验后零 mutation；successor 在旧事务重验后发起 → 必须等旧事务 commit，随后下一 row transaction 看到 stale 并停止。断言应是“successor commit 之后零旧身份 mutation”，而不是不可能的“同事务重验后、mutation 前 commit”；并覆盖 successor 在 attempt settlement 与消息 disposal 之间、两条 message transaction 之间的边界。

7. **[MEDIUM] §10 公开了没有跨批次消费者的低层 mailbox 相变，扩大了误用面并与既定边界冲突。** `recordInjectedTx`、`reportDeliveryTimeoutTx`、`settleFailureMailboxTx` 都只被本包 coordinator/driver/registration/disposal 组合；§10 却以“1501 的告警清账事务需要”为理由全部 root-export（`plan.md:402-404`），而既定边界明确规定 1501 只拥有 aggregation alarms 和 shim vendor implementation，不应直接 bump mailbox retry/dead 或裁决 deliver timeout。尤其 `settleFailureMailboxTx` 自身没有 attempt/identity fence，公开它会把内部拼装基元伪装成受支持的外部 API。建议只公开真实跨批次 seam：InjectionShim 类型、submit/failure 等高层入口，以及 batch 3 确需的 `registerConsumerTx`；其余 transitions 保持包内私有。若坚持导出，必须先给出具体枚举场景、调用方、同事务组合步骤和负向权限测试，否则按 §8 anti-over-reaction 原则删除。

## Verdict

CHANGES REQUESTED — address items above
