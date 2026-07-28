# Design Review — plan.md (FLY-1501) (Round 1)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

计划对 R13 已批准机制的主线总体忠实：N=1 聚合、方案 A 抑制、claim-first、三层 tier 计数、restart ledger/seq cursor/同锁 resume 都没有被重新发明，验收矩阵也覆盖了大部分关键交错。但当前版本仍有数个会让实现无法按计划落地或让验收假绿的接口与文件落点缺口，集中在 C4/C5、FLY-1500 的 notify 合同、Codex 活跃会话投递链，以及 restart spool 的 crash-safe 发布；因此本轮不能批准进入实现。

## What's Good (Keep)

- W1 正确识别了终版 §3.1 与已合入 0002 schema 之间的 `obligations.payload` 缺列，并把修复放在 W2 之前。
- W2 保留了权威 `DETECTOR_SQL`、每收件人一个 `BEGIN IMMEDIATE` 事务、episode 历史保留、三层 tier 单调状态和 subject/recipient 分离，机制方向与 `design-FINAL-v2.md` §3.1/§3.2 一致。
- W3 已忠实纳入 v13 的单调 `seq`、`last_resumed_seq`、`resumed` 锁内立即转 `active`、全部写者共锁，以及 kernel 不可用时仍先写 spool/走独立告警腿。
- W6 对当前代码的判断准确：`runCodexReviewResult` 的 CLI 确实仍把可选参数传给带 env/git fallback 的 emitter；两个 swap pressure 变量除 truth allowlist/历史文档外无生产读取方。
- 保护性机制单列、并逐项回答枚举场景来源，符合本轮“只裁工程落点、不重议已批机制”的范围纪律。

## Issues & Recommendations

1. **[HIGH] C4 仍是 open question，却被错误地从 W2 的阻塞依赖中排除了。** 当前 runner registry 的 `AgentIdentity` 只有 `{agentId, instanceId, generation, activationId}`，且 `parseIdentity` 使用 exact-key 校验；直接增加 `ownerLeadId` 会被拒绝（`packages/v2-kernel/src/fence.ts:3-16, 68-111`）。计划却让 W2 直接读取该字段（`plan.md:38`），同时在风险段声称 C4/C5/C7 未收口只阻塞 W4（`plan.md:119`）。此外，notify command payload 在创建时复制了 `recipient`（`research.md:42-54`）；若 owner 在 command pending 后换代，tick 只更新 obligation，而 tier 未变化时不会重建 command，实际发送仍可能命中旧 owner。**建议：**在 W2 开工前冻结 C4 的精确版本化 shape、旧 registry 兼容规则、1499 的原子写入责任及 public type；同时与 1500 明确“发送时从 obligation 解析当前 recipient”或“owner 变化时原子 cancel/rewrite pending command”的唯一方案。A4 增加“tier command 已 pending 后 owner 换代，旧 owner 收到 0 条、新 owner 收到 1 条”的端到端断言，并把 C4 加入 W2 的显式 blocker。

2. **[HIGH] C1-C3 还不足以实现 R13 suppression/notify 合同。** 终版方案 A 要求 parent-open 在同一事务记录 `suppressed_tier`；当前计划只在 age tick 发现“tier 变化且父已 open”时记债，未给 1500 的 parent-open 写者提供 hook。于是“child command 已 pending → parent 随后 open、tier 尚未升级”的交错没有合同覆盖，A5 也没有断言 parent-open 当下的债状态。另一方面，当前 `commands` schema 要求 `cutover_epoch` 和 `created_at`（`packages/v2-kernel/src/migrations/0001-base-schema.ts:71-91`），计划的 notify INSERT 没有定义 epoch 来源、fence 规则或稳定 payload schema；C1 的 `command` 和 C2 的 receipt 成功条件也未类型化。**建议：**补一个 parent-open 同事务接口（或等价的 1500 原子写合同），明确不改 command state、只按规则推进债；冻结 `NotifyCommandPayloadV1`、`cutover_epoch` 来源/校验、effect-key 解析和“何种 receipt 才推进 last_notified_tier”。A5/A6 增加 parent 在 pending command 之后打开且无 tier 升级的交错测试。W2 新增 root export 时还需更新 exact public API 守卫（`packages/v2-kernel/src/__tests__/public-api.test.ts:27-45`），不能只说机械追加 `index.ts`。

3. **[HIGH] W4 对现有 Codex 投递链的关键假设不成立。** `CodexAdapter.write` 通过 `metadata.flywheelId` 去重，但持久消息 `id` 实际由 `randomUUID()` 生成，`dedupeKey` 也是该随机 id，并非 `message_uid`（`packages/agent-team-transport/src/codex/CodexAdapter.ts:121-172, 227-230`）。更关键的是，Codex watcher 只在 `phaseKeepAlive` 时创建（`packages/claude-runner/src/CodexTmuxAdapter.ts:505-530`），且 `start()` 并不启动它；只有 phase 已进入 paused hold 的 `confirmHoldPaused()` 才启动 watcher，而回调只是写 `runner_phase_wake`（`packages/claude-runner/src/codex-phase-lifecycle.ts:241-252, 366-400`）。活跃 Codex 会话没有计划声称的“watcher→turn/start 链白拿”；文件顶部也明确写着 resident runner “no mailbox wake”（`CodexTmuxAdapter.ts:15-20`）。另外 `writeMailboxEntry` 不是 transport 包 root export（`packages/agent-team-transport/src/index.ts:18-30`），未来 `packages/v2-engine` 不能依赖内部 subpath。**建议：**先由 1499/C5 定义并拥有活跃 sessionRef 到 daemon turn 的真实投递泵，或选择另一条能触达当前 daemon 的无状态实现；W4 通过公开 `ClaudeCodeAdapter`/`CodexAdapter` API 写入并使用 `metadata.flywheelId=message_uid`，不要把随机 message id 描述成幂等键。C5/C7 未闭合前 W4 不应以临时落包宣称可实现；A14 必须分别覆盖 active、paused/resumed、宿主重启和重复 deliver 后“恰一 vendor turn”，而不只是信箱文件收敛。

4. **[HIGH] W3 的 wrapper/告警接入不是所写的“四个 wrapper + 白名单一行”。** `lead-alert.sh` 明确要求 shell kind 与 TS union 同面（`scripts/lead-alert.sh:162-190`）；新增 kind 还会触及 `ALERT_EVENT_TYPES`（`packages/teamlead/src/LeadAlertNotifier.ts:63-70`）、穷举 `KIND_CONTRACTS`（`packages/teamlead/src/bridge/kind-contract.ts:64-70`）和 routing 分类（`packages/teamlead/src/bridge/infra-event-router.ts:37-91`），现有测试会拒绝 shell-only kind（`packages/teamlead/src/bridge/__tests__/kind-contract.test.ts:341-349`）。`cmux-watcher` 也不是待核实的猜测：plist 已是 `KeepAlive=true`，监督入口在 `flywheel-cmux-autostart.sh` 的 supervised exec 分支（`scripts/com.flywheel.cmux-watcher.plist.template:9-22`; `scripts/flywheel-cmux-autostart.sh:69-76`）。并且若按“exec 前一行”把 gate 放入 quota wrapper，它会在已写 `quota-monitor.running` 之后 hold（`scripts/flywheel-quota-monitor-wrapper.sh:102-109`），下次启动会把 gate 自己制造的 marker 当作 child crash。**建议：**列出 TS union、kind contract、ticket/notify routing 与 parity 测试；把 cmux 的 supervised 分支纳入明确 scope；为每个 wrapper指定“最后一次无副作用校验之后、任何本次-child-running marker/PID 写入之前”的准确插入点。quota gate 至少应位于新 RUN_MARKER 写入前，且验收需断言 held 不制造 legacy crash streak/marker。

5. **[HIGH] restart spool/ledger 的磁盘协议没有闭合到计划宣称的 crash replay 语义。** 研究稿把最终 `spool/<episode>.json` 定义为 `O_EXCL` 后直接写+fsync（`research.md:130-143`）。若进程在 create 后、完整 payload/fsync 前崩溃，最终路径会留下空文件或半截 JSON；下一次 `O_EXCL` 只看到 EEXIST，无法修复，kernel reconcile 也会永久失败。JSONL append 同样可能留下 partial tail，而计划没有定义尾行恢复、seq 重取或损坏策略。告警腿还有状态歧义：文档一面说失败应在 `held_alert_pending` 下次重发，一面说两腿 best-effort；但 `lead-alert.sh --strict-delivery` 的 `queued_transient`/`dead_lettered` 都可能 exit 2，仅 stdout 结果能区分（`scripts/lead-alert.sh:610-628, 676-699`）。**建议：**写出真正的 create-once 原子发布协议：同目录临时文件完整写+fsync，使用无覆盖原子发布手段占用稳定终址，再 fsync 目录；EEXIST 必须校验 episode/content 后才算成功，坏文件要 fail-closed/quarantine。定义 partial JSONL tail 的唯一恢复规则和 seq 单调性。明确哪些 helper 结果允许 `pending→attempted`、哪些保留 pending 重试；A9/A12 增加 create 后、半写、file fsync、publish、directory fsync、ledger partial-tail 以及每条告警腿返回值的 fault injection。

6. **[MEDIUM] W1 所承诺的“仅容忍真实 duplicate column”在当前 migrator 抽象中没有实现落点。** `Migration` 只有 `{id, ddl, fkMode}`，普通迁移直接 `db.exec(ddl)` 后记账（`packages/v2-kernel/src/migrations/index.ts:6-10`; `packages/v2-kernel/src/migrator.ts:68-82`）。正常二次运行会因 `schema_migrations` 记录而跳过，并不会产生 duplicate-column；若 column 已存在但账本缺 0005，当前代码只会抛错，也没有安全确认列 type/shape 后补账的 seam。**建议：**若这里仅指普通 migration replay，就删掉“duplicate column tolerance”措辞并测试 ledger skip；若确实要兼容“列已存在、账本缺失”的漂移状态，则把 schema precondition/validator 明确加入 migrator，只有 `pragma_table_info` 确认列名与声明完全匹配时才允许记账，其他 SQLite 错误一律继续失败。不要只按错误字符串吞掉异常。

7. **[MEDIUM] W5 依赖了不存在的 clamp，并漏列 strict manifest/snapshot 与 seed 落点。** 当前 admission 和四个 rotation API 对 `expiresAt > absoluteDeadlineAt` 都返回 `invalid_expiry`，不会钳制（例如 `packages/teamlead/src/StateStore.ts:20573-20580, 18665-18672`）；只有另一套 `renewWorkflowDecisionCapability` 会选择 deadline（`StateStore.ts:26924-26933`），而计划明确不走它。因此 A15 的“超上限被钳”按现有实现会失败。与此同时，schema v1/v2 node 都用 exact-key allowlist（`packages/teamlead/src/workflow-template.ts:321-338, 756-775`），pinned snapshot 解析还会再次严格验证 manifest（`packages/teamlead/src/workflow-run-snapshot.ts:482-562`）；“节点模板 config”不足以描述所需改动，也未点名哪个 QA seed 声明 180。**建议：**增加一个 dispatcher 共用的 expiry 计算函数，显式校验正整数并执行 `min(now + window, absoluteDeadline)`，三条 admission/rotation/repair 路径只调用该函数。列出 `WorkflowManifestNode`、v1/v2 exact validators、snapshot round-trip/digest tests 和确切 seed YAML；限定该字段能否只用于 decision node，并对 0、负数、小数、非数值、>24h 及三条 rotation 路径分别验收。

## Verdict

CHANGES REQUESTED — address items above
