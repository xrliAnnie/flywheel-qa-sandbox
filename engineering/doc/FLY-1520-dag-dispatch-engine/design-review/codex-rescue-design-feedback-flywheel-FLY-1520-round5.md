# Design Review — FLY-1520 plan.md (Round 5)

Date: 2026-07-28
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 5 已正确修复 activation-scoped session_ref 冲突，并把 agent_binding 转移、T4 quiesce、claim 竞争和 ship mint 授权边界显著收紧。当前仍不能批准：launch claim 在成功启动后没有一次性消费或 durable launched receipt，过期接管可对仍存活的 runner 再次启动；同时 OS 锁只覆盖 spawn adapter 与 reaper，没有覆盖 takeover 和 T3/T4/T7 的 tombstone/terminal 路径。另有两处计划文字与本轮声明不一致，需要在实现前消歧。

## What's Good (Keep)

- `session_ref='v2dag:{attempt_id}:{attempt_generation}:{activation_id}'` 真正把 launch identity 提升到 activation 级；T7 每次新 activation 都得到新 key，旧 tombstoned claims 可完整保留。
- activation.generation 继续严格等于 attempts.generation，agent generation 仍只用于 agents/RegisteredAgent/action actor/processing_attempts，符合 migration 0006 lineage trigger。
- T2/T7 业务事务只创建 pending claim，owner token 由 commit 后的 revision-CAS 竞争者生成；这消除了“多个重构 launcher 共用业务事务内 token”的原问题。
- agent_binding 已有完整 absent/clear/active 转移表，并明确 T7 probe current、后续 dispatch probe last；全局 logical-agent 单飞边界清楚。
- T4 在写事务前加入 requestStop + exact-session absence，仍存活时 typed no-op 重试，避免直接把活 runner 从数据库中抹去。
- T3 的 evidence 闭包、非写任务零 Git 路径、completion/admission receipt-first、ship target 单源和四态 gate/settled 模型继续保持闭合。
- founder-authorized recovery 与 reconciler rearm 的权限谓词已集中，ship intent 仍完整核对 gate actor generation、capability id、issuer/audience/subject 和 FENCE null bindings。
- M0 真库 spike、500-task fail-closed 上限、actions trigger fixtures、静态语义围栏和两包依赖约束都适合保留。

## Issues & Recommendations

1. **[阻塞] `launch_claim` 在成功 exec 后仍停留于可接管的 `claimed`，不能保证同一 activation 至多启动一次。** §2.2b 只有 `pending|claimed|tombstoned`，adapter 成功 exec 后没有状态转移或 durable launch receipt；lease 到期即可仅凭 revision CAS 换新 token，未要求 `ProcessProbePort` 证明 exact session absent。于是健康 runner 运行超过 launch lease 后，重构 launcher 可 takeover 并启动第二个 runner。即使不等 lease，同一 owner token 的 SpawnPort 重放也仍能再次通过；T2 的 `dispatched→started` 只保护首次 attempt launch，保护不了 T7 或同 token 的 adapter 重放。**修正**：为 token 增加一次性消费语义，例如锁内 CAS `claimed→launching/launched` 并持久化 launch receipt（token、activation、host epoch/进程 identity）；第二次同 token 必须 fail/no-op。过期 takeover 必须在同一 session lock 下并要求 exact-session absent。若在 consumed/launching 后、exec 前崩溃，走 reaper/T7 恢复，不允许再次 exec 同一 activation。增加三组 crash/replay 测试：同 token 双调用、成功启动后 lease 过期但进程仍 present、launch receipt 前后各崩一次。

2. **[阻塞] per-session OS 锁的参与者集合仍不完整，计划声称排除的 read→terminal/exec 交错仍可发生。** §2.2b 和 Ports 只要求 Spawn adapter 与“收割适配器”共锁；lease takeover 自身不取锁，T3、T4、T7 也直接在 kernel.write 中 tombstone claim/terminal activation。可构造两条交错：①旧 adapter 持锁并在 lease 到期前通过校验，锁内停顿；不取锁的 takeover 到期后换 token；旧 adapter exec，随后新 adapter 也 exec。②T4 在 absence probe 后，旧 adapter 锁内通过校验；T4 不取锁便 terminal；adapter 随后 exec。真实 `EngineDriver.attachRunner` 仅检查 agents kind/generation（`packages/v2-engine/src/driver.ts:115-133`），不检查 activation；对 T4 中未换代的下游 logical agent，这个迟到 runner 仍可 attach。**修正**：定义唯一锁序 `LaunchLockPort(session_ref) → kernel read/write`，让 pending claim-confirm、expired takeover、adapter one-shot launch、T3 terminal、T4 closure terminal、T6 reaper、T7 cutover 全部参加；进入锁后重验 claim/activation/binding/evidence。T4 多 session 必须按 canonical session_ref 顺序取锁，避免死锁，且禁止任何 kernel.write 内反向取 OS 锁。补 takeover×adapter、T4×adapter、T7×adapter及多 session 锁序测试。

3. **[高] admission 对 existing agent 的实际谓词比本轮声明更强，会拒绝所有 generation>0 agent，而不只是“无 binding”的 legacy agent。** §2.2a 先把问题限定为“generation>0 但无 binding”，随后却规定 executor agent 必须“不存在或 generation=0”（`plan.md:150-153`）。这会使已经由 v2-dag 建立合法 clear/active binding 的稳定 logical agent 无法被后续 issue 再 admission，与“logicalAgentId 稳定跨 attempt”和全局 binding 单飞模型冲突。**修正**：写成精确矩阵：agent absent 或 generation=0 provisioned 可 admission；generation>0 + 合法同 epoch binding（clear 或 active）可 admission，active 仅由 T2 单飞阻止派发；generation>0 + binding 缺失/畸形才 typed reject。增加 gen>0+clear 接受、gen>0+active admission 后 dispatch skip、gen>0+missing binding 拒绝三例。若本批有意禁止跨 issue 复用，则必须把它记录为新的显式偏离并定义 logicalAgentId 分配规则，而不能以 legacy-only wording 表达。

4. **[中] “capability INSERT 只在两个 helper”与 writer-adoption capability 同时存在，静态验收按字面不可实现。** §2.3 的 github_merge 段称 capability INSERT 仅存在于 `founderAuthorizedMintTx` 与 `reconcilerRearmMintTx`（`plan.md:180-186`），但同节随后又要求 `mintWriterAdoptionCapability` 写入 `adopt_writer_gap|lost_open_attempt` capability（`:199-204`）。**修正**：把约束明确为“`action='github_merge'` 的授权入口恰两个”，writer-adoption 是第三个独立 action namespace；静态测试应按 action/调用图断言，而不是全包 grep `INSERT INTO capabilities` 只有两个命中。另一种可行映射是保留一个私有低层 insert helper，再由三个领域授权 helper 调用，但必须分别测试各自 authority predicate。

## Verdict

CHANGES REQUESTED — address items above
