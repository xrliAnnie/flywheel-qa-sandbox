# FLY-2505 正式设计评审记录 — 调研
Issue: FLY-2505 (https://linear.app/geoforge3d/issue/FLY-2505/病根-重启后-reown-的-recovery-owner-在-commit-前失败且不留原因resulttext-空-只剩通用文案两次即)
日期: 2026-09-10
基于: plan.md

## R1

- Gate: 10977952-7a86-4a15-8c54-2eee0e9c1690
- Request: 99cc923e-15af-49c6-b5bf-36efff2f593a
- Effective reviewVerdict: CHANGES_REQUESTED
- Raw reviewerVerdict: CHANGES_REQUESTED
- 审查内容：86684e7fa 的计划/HTML；随后仅追加 progress cursor。

| findingKey | 级别 | R2 处置 |
|---|---|---|
| settle-requires-unexpired-lease | HIGH | §3.2 允许仍唯一匹配的过期 token 结算，保持所有 identity/revision/successor/commit fences；不授予新 mutation 权限。T3 用 30s socket + 2×10s cleanup + 20s 收尾跨 60s TTL 的实际参数组合证明退款与留因 |
| deferral-window-keyed-to-60s-lease | MEDIUM | §3/§4 新增每 reservation 固定 300s 观察界限，覆盖 lease 过期到失败结算的间隙；它不是 mutation lease，不续期、不依赖心跳阈值 |
| zombie-handler-await-breaks-reproof | MEDIUM | handler 移到取证之前，之后完整 session/revision/pane/CommDB/server re-proof；同步判死区间零 await；generic orphan 同样重算 fresh aging |
| alert-uid-payload-conflict-rolls-back-settle | MEDIUM | 相同事务 SELECT 已有固定 uid、校验身份后原样复用，不重新 enqueue 可变 payload；T6 改路由/文案复测不回滚 |
| readiness-window-vs-maintenance-cadence | MEDIUM | 保留 Lead 已确认的两个独立上限：最多3次失败或15分钟先到即止。明确不保证发足3次、记录 exhaustionTrigger 和实际次数，T3/T7 用300s节拍与跳tick对照；未自动延长已批准时间窗 |
| alert-disposition-union-not-extended | LOW | 按 Lead 指令撤回本轮补充，移入 plan §10 follow-ups；不修、不开单 |
| settle-signature-missing-alert-identity | LOW | 按 Lead 指令撤回 input 对象补充，移入 plan §10 follow-ups；不修、不开单 |
| observe-attempt2-proof-reads-workflow-attempt | LOW | 按 Lead 指令撤回 legacy 算法修订，移入 plan §10 follow-ups；不修、不开单 |

以上是作者修订，不是批准。必须新建 gate/request-review，以新一轮有效 verdict 为准。

## 配套验证

R1 修订后重新生成 HTML，DOM/评论、pathname 保存、长文 marker 分段、clipboard 成功/失败/缺失、storage 拒绝场景全部通过。仅设计文档/HTML 变更，未改实现源文件。修正后的依赖构建命令 pnpm -r --filter 'flywheel-teamlead^...' build 已以 exit 0 完成。

Lead instruction eebc5b21-1d74-4600-a2f9-109cc6455249 在 R1 已修订提交时到达，R2 尚未注册。已在送 R2 前撤回 LOW 改动；保留指定 HIGH/四项 MEDIUM 修订。最多 R3、评审运行时不推新提交。

## R2 — 最终有效批准

- Gate: 0bf3e2f9-1a20-4387-97d8-dc710e9d3419
- Request: c242aa9a-3dc8-457d-8653-35ce61035056
- Reviewed head: 9e184e8fd
- Effective reviewVerdict: APPROVED
- Raw reviewerVerdict: APPROVED
- HIGH: 0；advisories: 1 MEDIUM + 2 LOW。按 Lead 指令仅留档、不修、不开新单；无需 R3。

### pending-window-not-cleared-on-abort — MEDIUM

新增的 pending_reservation_until_ms 清除者清单漏了 fence abort，配合 §4 含糊的「claim_token 未被替换」可能给已放弃的 reservation 最多 300s 通用判死豁免

R2 新引入的 §3.2.2 把清除者枚举为「settle/commit/成功 TURN writer commit 清该字段」，§3.2.8 同时原样保留「既有 mutation 前 fence abort 继续 releaseAttempt 并清锁」。但 abortCodexRecovery（packages/teamlead/src/StateStore.ts:10723-10739）只把 claim_token/holder/acquired_at_ms/expires_at_ms/expected_lifecycle_revision 置 NULL，不会碰新列；而 codex-session-reown.ts:601 的 abort() 覆盖 reown_fence_lost(owner_or_binding_changed_after_claim / turn_holder_changed_before_recycle / owner_or_binding_changed_before_spawn)、reown_skipped_not_turn_holder、recycle_*、capabilities_* 等全部放弃路径 —— 这些场景下根本没有 owner 在飞（abort 发生在 reap/spawn 之前或 prepare 之后、spawn 之前）。于是 abort 之后 pending_reservation_until_ms 仍非 NULL 最多 300s，而它正是 §4 分支一「尚未结算的 reservation」的判据。此时唯一的守门是 §4 第 137 行那句「第一种还需当前 claim_token 未被替换、未 commit」，措辞可两读：若实现读成「没有*别的*token 占住该行」，NULL 即算未被替换 → 授予保护；只有读成「行上的 token 仍等于本 reservation 的 token」才正确拒绝。前一种读法会让 TURN 已易主/binding 已变的 session 白白多躲 300s 通用 zombie 与 orphan 判死，直接违反 §4 自己那句「closed/legacy、mutation lease、损坏字段、terminal/superseded/revision 变化一律不保护」。注意 §3.1 的 episode_lifecycle_revision 被定义为「独立于 abort 会清掉的 lease revision」，所以 abort 之后 §4 的 revision 校验仍然通过，兜不住这个洞。修法是一句话级别：把 abort 补进 §3.2.2 的清除者清单，或把 §4 分支一的条件改写为 `claim_token IS NOT NULL AND claim_token = 本 reservation 的 token`，并在 T7 补一条「fence abort 后不再受 pending 宽限保护」的对照。参照 §3.3 已经为 TURN writer 路径写了「避免 TURN 已改变后留下过期保护」，abort 路径缺的正是同一条守则。

### alert-payload-has-no-episodeid-field — LOW

§3.4 的 R1 复用校验要求比对「已存 metadata 的 executionId/episodeId」，但 WorkflowEngineAlertPayload 根本没有 episodeId 字段

R2 为解决 uid 冲突新增的规则写的是「验证 run_id 及已存 metadata 的 executionId/episodeId 与本次持久化身份相同」。核对类型：WorkflowEngineAlertPayload（StateStore.ts:73322-73411）顶层只有 leadId/projectName/eventId/eventType/title/body/severity/sessionKey/metadata，metadata.workflowEngine 里有 runId/issueId/nodeId/executionId/disposition/… 全程没有 episodeId；带 episodeId 的是另一个类型 WorkflowDeliveryContractUnboundAlertPayload（同文件 :47910 附近的 builder），两者不是一回事。所以照字面实现取不到 episodeId。规则本身是对的（SELECT 命中即原样复用、绝不重新序列化）并且身份校验可行 —— escalationUid 自身就是 `reown-exhausted:<execution>:<episode>`，episode 身份从 uid 解析即可；若坚持从 payload 取，就要扩展 metadata.workflowEngine，而那类闭合结构扩展已被 Lead 归入 §10 的 alert-disposition-union-not-extended 留档项。建议把这半句改为「比对 run_id、metadata.workflowEngine.executionId，以及 escalationUid 自带的 episode 段」，避免实现期照抄一个不存在的字段。

### stale-observation-event-id-unspecified — LOW

§3.2.5 新增的「非账务观察事件」没有规定事件 id，与同节其他事件的固定幂等 id 约定不一致

R2 在 §3.2.5 加了一条兜底：token 已被接管时「迟到诊断可另写非账务观察事件，注明 stale，不覆盖当前 last_failure」。这是个好补充，但本计划对其余每一类事件都指定了固定幂等 id（§3.2.6 的 reown_revive_failed:v1:<execution>:<episode>:<reservationSeq>、§3.4 的 reown_exhausted:v1:<execution>:<episode>、§3.2.4 的 capabilities UID），唯独这条没写。session_events.event_id 是 UNIQUE，insertEvent 撞唯一约束时静默返回 false（StateStore.ts:9820-9827），所以两种失手都可能：复用账务事件 id 会让这条观察记录被静默吞掉，改用 randomUUID 则同一个 stale reservation 的多条迟到回调（terminal reject、retireOnce reject、late receipt 各一条）会写出重复行，污染 §6 里 qa-fly-2456-observe 的 episode 事件序列判据。建议补一句固定形如 reown_revive_stale_observed:v1:<execution>:<episode>:<reservationSeq> 的 id，并在 T5 的 late receipt / reject 用例里断言它既不改预算也不重复。
