# Design Review — plan.md (FLY-1501) (Round 3)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 已正确封闭 Round 2 指出的 stale recipient、非持久 `duplicate` receipt、no-clobber spool 发布、partial-tail 恢复、非法软窗值和临时 shim 落包路径，相关验收也基本随合同同步。当前仍有一个会阻止 W3 按现有架构落地的跨语言 `fcntl` 锁 seam，以及两处会让并行 issue 或 manifest 实现产生歧义的合同缺口；因此本轮仍不能批准进入实现。

## What's Good (Keep)

- `resolveNotifyRecipient` 正文现已从 obligation subject 出发读取 live registry，并将 obligation recipient 降为 audit cache；A4 也明确禁止 handover 与发送之间依赖额外 tick。
- Discord alert-leg 状态映射已与 `lead-alert.sh` 的真实语义对齐：只有 `sent`/`queued_transient` 是 durable receipt，`duplicate` 保持 pending 并等待 lease 到期重试。
- spool 改为完整 temp 后 hard-link no-clobber 发布，live/applied 双位置参与幂等判断；ledger 残尾也改为先 truncate+fsync 再分配 seq/append。
- W5 已采用 absent-only default、present-invalid reject，并明确只给 heavy 与 heavy-land QA seed 配置 180 分钟。
- W4 已删除临时 `agent-team-transport` 落包分支，W3 总览也已更新为五个 supervised entry。

## Issues & Recommendations

1. **[HIGH] TypeScript reconciler 目前没有可调用的同一 `fcntl` 锁实现，R2-3 的关键并发修复仍缺工程落点。** 计划要求 `packages/v2-kernel/src/alerts/restart-storm-reconcile.ts` 在 live→applied 时“经与 gate 相同的 fcntl helper 取锁”（`plan.md:38,48`），但 `flywheel-v2-kernel` 的生产依赖只有 `better-sqlite3`（`packages/v2-kernel/package.json`），Node 运行时没有原生 `flock/fcntl`；仓内现有 Node 跨语言锁实现也明确记录这一限制（`packages/teamlead/src/account-heal/mkdir-lock.ts:1-9`）。`scripts/flywheel-config-lock.py` 只能持锁并包住一个外部命令，当前并不存在供它执行的、同时完成 expected-content 校验、live/applied 仲裁、rename 和 directory fsync 的 reconciler 命令；该脚本也不在 v2-kernel 的 package export 中。若实现者直接在 TS 中 rename、换成 mkdir lock 或只“尽量”调用脚本，都会重新打开 A12 的重复发布竞态或偏离已批准的同锁机制。**建议：**在 plan 中选择并冻结跨语言桥，例如给 `restart-storm-gate.py` 增加内部 `mark-applied` 子命令：它自行获取同一 child lock、校验 expected episode/live/applied、执行 durable move；TS reconciler 在 DB commit 后通过显式注入的绝对 helper path/`execFile` 调用。同步定义 helper 缺失、lock contention、内容不匹配和 DB commit 后 helper crash 的返回/重试语义，并加入“Python gate 持锁时 TS reconcile 不得移动，释放后只移动一次”的真实双进程测试。若选择 native addon，则必须列出依赖、macOS 构建/打包和 fail-closed 合同，不能把它留给 implement 临场决定。

2. **[MEDIUM] C-recipient 的正式跨 issue 合同仍保留了已废弃的 claim-time 调用点。** W2 正文已明确唯一调用点是 execute/effect handoff（`plan.md:37`），但供 FLY-1500 引用的接口合同仍写“claim/execute 时调”（`plan.md:99`）。这不是无害措辞：1500 若按合同在 claim 时解析并缓存 recipient，owner 在 claim 后、effect 前换代时仍会发给旧 owner。合同状态行还没有把 C-recipient 列入“写入 plan 即生效”的已冻结接口（`plan.md:102`）。**建议：**把 §4 改为“仅 execute/effect handoff 调用；claim 不解析、不缓存权威 recipient”，并将 C-recipient 加入已生效合同清单；A4 增加 owner 在 claim 后、effect handoff 前换代的子例。

3. **[MEDIUM] W5 声明了 decision-credential-only scope，但现有触点清单不会强制该 scope，也没有冻结 dispatcher 从哪里读取该字段。** v1/v2 parser 的 node exact-key allowlist 是所有 node 共用的；仅“加白名单项+正整数校验”（`plan.md:66`）会让 design/implement/generic/gate/land 也可声明合法的 `submissionWindowMinutes`，其中 gate/land 分支还可能在返回规范化 manifest 时静默丢掉该字段。decision family 并不由 node type/id 决定，而是由 pinned loops+edges 结构推导（`packages/teamlead/src/workflow-run-snapshot.ts:91-107`），所以需要完整 manifest 解析后的结构校验。另一个落点问题是 dispatcher 当前使用的 `node` 来自 `snapshot.resolved.nodes`，而 resolved node builder/parser不携带该字段；字段实际应从 pinned `snapshot.manifest.nodes` 读取，而不是 live seed/template。**建议：**增加 post-parse invariant：字段存在时 `resolveWorkflowDecisionContract`（或等价纯函数）必须返回 `qa_verdict|review_verdict`，其他 node 一律拒绝；明确三条 dispatcher 路径通过一个 helper 从 pinned manifest node 读取窗口并在无 decision contract 时固定为 60。A15 增加 v1 implement/gate、v2 generic/gate 携带合法 `180` 仍被拒，以及 snapshot 创建后修改 live seed 不影响既有 run expiry 的测试。

## Verdict

CHANGES REQUESTED — address items above
