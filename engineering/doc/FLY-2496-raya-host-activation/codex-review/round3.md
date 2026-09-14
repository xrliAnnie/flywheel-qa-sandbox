# Design Review — plan.md (Round 3)

Date: 2026-09-13
Author: Codex
Status: CHANGES REQUESTED

## Summary

v3 又收敛了一大步：`AUTH-FENCE`、`CUTOVER-RESUME` 的 at-most-once 停止语义、`ALERT-KIND-CONTRACT` 均已按真实代码闭合；scratch 候选产物、毫秒级逐 job 停机记录和非 severe rebind 分支也都是正确方向。但仍有三个原 finding 没有真正闭环。P3 的 resolution 仍无法用现有单一 cursor 表达交错的 processed/unprocessed 历史；主 checkout 的 `ff-only` 仍位于不可逆停机之后；更关键的是，auto-rebind 会产生新 activation，而现有 P6 明确要求 cutover activation 与当前 Lead activation 相等，原窗口证据无法诚实重绑到新 PID。后两者分别留下可避免的 maintenance 入口和一个合法 Flywheel 漂移后无法到达 P7 的状态。因此本轮仍为 `CHANGES REQUESTED`。

## What's Good (Keep)

- H0/H3 的 canonical authorization 行、全 SHA pin、Discord 作者核验和公共 `resolveFounderId` 与真实导出签名一致；ambient legacy-stop env 也被明确清除。`FLY2496-R1-AUTH-FENCE` 可关闭。
- probe intent 现在按时间下界向前分页，任何耗尽、403 或 timeout 都进入 `probe_delivery_ambiguous` 且不做第二次 POST；这满足 R2 要求的 fail-closed at-most-once 合同。`FLY2496-R1-CUTOVER-RESUME` 可关闭。
- pre-stop 当场 POST、scratch 完整 install/build、候选 digest 和“候选即唯一晋升字节”消除了停机后的第二次 package build；这些部分应保留。
- `activation_probe` 已覆盖 shell allowlist/informational mirror、TS union/informational set、`KIND_CONTRACTS`、`alert-kind-copy.ts` 三个穷举函数及 strict-delivery 两条路径。`FLY2496-R1-ALERT-KIND-CONTRACT` 可关闭。
- 先前已关闭的 `SEED-SCHEMA`、`LEDGER-INFO-COUNT`、`MEMORY-CHECKPOINT`、`SUMMARY-PROVENANCE` 本轮未出现回退。

## Issues & Recommendations

1. **P3 仍不能形成现有 cursor 可表示的连续处理前缀。**  
   `findingKey: FLY2496-R1-CURSOR-BOUNDARY`  
   **Issue:** plan §5 B（`:154`）一面说“不依赖任何回复推断”，一面仍把候选消息之后任意一条 Raya bot 消息当成该候选“已应答”；真实旧壳有两个 detached gateway 和各自独立 queue，并不存在这种全入口/source-message 绑定。更确定的错误在 resolution：§5 C/§6.2（`:155,211`）规定 `confirmed_unprocessed` 把 B 降到该消息之前，但真实 `FileInboundCursorStore` 每频道只有一个标量 `{channelId: lastConfirmedMessageId}`（`InboundCursorStore.ts:47-82`）。反例：m1 较早且 confirmed_unprocessed，m2 较晚且 confirmed_processed；B 原为 m2，降到 m1 前会让新 owner 同时重放 m1 和 m2，重复 m2 的回复/calendar/meeting 副作用。类似地，T0 后但 T1 前若一条消息已被旧壳回复，算法仍以 `<T0` 的 B seed，因此该消息必然被再次拉取。最后，把 T0−15min 之前全部视为 processed 的 `assumptions[]` 也不是 FLY-2445 §6.2 `:180` 要求的证据；上游只允许在证明旧文字入口根本未运行时声明明确历史基线。
   **Why it matters:** 该算法可以永久跳过未处理输入，也可以重放已有外部副作用；`unresolved == []` 不再证明“已确认完成的连续前缀 + 确定未处理的后缀”，而 P4b/P5 会据此继续安装。
   **Suggested fix:** 先定义一个单调 cut C，并只允许所有 `<= C` 的消息均有 source-bound 回复引用/外部 durable receipt 或人工完成对账，所有 `> C` 均确定未处理。任意 Raya bot 后续消息不能算证据；Discord reply 至少要验证 `message_reference.message_id`，有 calendar/meeting 副作用还要核真实外部 receipt。遇到“较早未处理、较晚已处理”的交错时，不得简单降低 scalar cursor；必须先人工完成/对账较早缺口，使它成为 processed 连续前缀，或新增真正的 replay suppression/holdback 机制。15 分钟之前若要排除在补录范围外，应记录经授权的 explicit historical baseline 及证明，而不是写一个“视为已处理”的假设。增加上述 m1/m2 交错、T0–T1 已回复消息和无关 Raya bot 出站三个真实 seed 集成用例。

2. **一个可避免的 Git 失败仍留在旧壳停机之后。**  
   `findingKey: FLY2496-R1-PRESTOP-PREFLIGHT`  
   **Issue:** plan §5 B（`:154`）的顺序仍是 quiesce → 主 checkout `git merge --ff-only` → promote。scratch 候选虽已决定运行字节，但 `merge --ff-only` 仍会修改主 checkout，并可因 checkout 在 pre-stop 与该命令之间变脏、分支/引用变化或文件系统错误而失败。此时两个旧 job 已停，且该 Git 操作对启动已验证候选并非不可避免。它也与 R2 已给出的“主 ff 在停机前或 P5 后对账”修复要求不一致。
   **Why it matters:** 计划仍不能兑现“所有可预见失败在不可逆边界前完成”；一个与候选运行字节无关的 checkout 竞争即可把 Raya 留在 maintenance。
   **Suggested fix:** 把 main 的 fast-forward 作为最后一个可逆 pre-stop 步骤，并在其后立即重验 HEAD==target、candidate/artifact digest 与两份 legacy owner identity，再 quiesce；或者让激活完全以冻结候选为 source of truth，把 main 对账延后并相应移除 P3/P5 对 `HEAD==raya_sha` 的前置依赖。无论选择哪条，quiesce 后不应再有会决定流程能否继续的主 checkout mutation。增加“pre-stop 后 checkout 变脏/HEAD 漂移”用例，断言失败时两旧 job 仍活着。

3. **auto-rebind 与 P6 的 activation 绑定合同不相容。**  
   `findingKey: FLY2496-R1-SHA-FREEZE`  
   **Issue:** rebind 条件要求 Raya 在后续 fleet wave 中得到一个新的 `process_started_at`/PID（plan `:142`），而 activation id 定义包含 PID 与 start time。真实 P6 validator 却硬要求 `.cutover.activation_id == .lead.activation_id`（`updater-raya-deploy.sh:355-357`），FLY-2445 §6.2 `:175,182` 也要求窗口 delivery/outbound 属于当前 activation。原 cutover probe 已由 P5 的第一代 activation 收取并回复；后续 Flywheel restart 产生的新 activation 不会倒退 cursor 再处理它。因此仅把 ledger 的 `flywheel_deployed_sha` 改掉、作废 proof 并“重跑 H4.3”，无法为新 activation 诚实生成同一 cutover 证据。即使另发普通 text probe，H4 的旧 summary delivery 也早于新 process start，必须再等一个当前 activation 的 round。计划没有修改上述 equality/schema，也没有要求重跑 H4.1/H4.2，所以合法漂移分支不能按所写路径到达 P7。
   **Why it matters:** “Flywheel 部署不冻结”是计划的正常路径，不是罕见异常；N 后任一正常发布都会使首次迁移永久停在 P5，或诱使 proof 把旧 activation 的证据错误归因给新 PID。
   **Suggested fix:** 最小方案是在首次 P5→P7 建立短 Flywheel deployment freeze，使窗口证据、text、summary 与最终 live process 保持同一 activation。若必须保留 auto-rebind，则需显式升级 proof/ledger/receipt：保留 original cutover activation，另记并验证 current activation 与受认证 restart succession；修改 `raya_p6_evidence_valid` 的 equality；rebind 后重做 H4.1、等待新的 H4.2，再 collect。proof writer 与 updater/rebind 还应共享现有 Raya deploy lock（或等价事务），防止 proof 写入与“rename stale + manifest CAS”交错留下旧 SHA proof。测试至少覆盖 deploy-before-proof、proof 已写后 deploy、P6 后 crash/rebind，以及每种情况下证据 activation 的归属。

## Advisory (non-blocking)

- research/exploration 尚未完全同步：research §1.3 自称“完整字段”却仍是旧 authorization/window_probe 形状；exploration `:138` 仍写停机后 build，`:148` 仍写 10 分钟内未答消息会永久丢失，`:150` 仍声称 merge 者可判为 Raya bot。这些与 v3 plan/research 其他段落直接冲突，实施前应统一。
- `probe_delivery_ambiguous` 的 `resolve --as probe_message-id` 只覆盖“后来找到了已发消息”。若 crash 恰发生在 intent 落盘后、POST 调用前，则不存在可绑定 id；当前设计会安全停住但没有规范恢复入口。可补一个有证据且受授权的 `confirmed_not_delivered`/replacement-probe 路径，或明确它是需新授权的终止态。
- 既然 rebind 选择依赖全局 `leads-restart-status.json`，predicate 建议同时 pin `schemaVersion==1`、`failed==0`、`skipped==0`、冻结 roster 下的 `total==17` 和合法 `recordedAt`，而不只看字符串 `leadsRestartStatus==healthy`。
- 本轮按要求做 source-grounded static review；未运行会生成构建/测试产物的套件，以保持“除反馈文件外不修改任何文件”的边界。

## Verdict

CHANGES REQUESTED — address items above
