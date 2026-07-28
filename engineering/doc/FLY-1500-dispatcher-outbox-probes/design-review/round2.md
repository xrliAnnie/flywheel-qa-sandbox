# Design Review — plan.md (Round 2)

Date: 2026-07-27
Author: Codex
Status: CHANGES REQUESTED

## Summary

R1 的十项修改大多已沿正确方向落下：lease 接管、B1/B2、consume-time capability CAS、typed settle、独立 `requires`、correction kinds、canonical replay id 和 obligation 销账都明显改善了协议。但当前稿仍有几处 canonical SQL 与文字合同不一致，其中 `requires` 可毒死整条 lane、P12 内核动作没有授权/执行协议、probe streak 会跨确定答案串案，以及分支删除护栏尚未落到执行时；因此本轮仍不能进入实施。

## What's Good (Keep)

- 接管资格已改为必须 `lease_expires_at <= now`，并补了“旧世代 lease 未过期绝不 probe/release/resend”的反例测试；这关闭了 R1 最危险的双发窗口。
- `accepted` 已拆成独立提交的 B1，B2 把 `effect_intent` 与 capability consume 放进同一事务；`denied → rejected`、预算重试、`effect_unknown` 与 terminal obligation 也已有可实现的 typed 轮廓。
- `notify_before` 与 payload `requires` 分家是正确的；thread receipt late-binding、分片前驱链、requires 终局级联共同解决了 thread 锚定和跨 retry 乱序。
- correction kinds 的 disposition=`none` 使 saga 防递归断言真实可满足；补偿 command 仍不豁免 notify-then-do、planner 自动附通知依赖的裁决应保留。
- effect-key replay 现在比较 canonical envelope 并返回既有 canonical command id，FLY-1499/saga 的接缝也明确要求消费返回值。
- `effect_applied/effect_not_applied/unknown + evidence`、attempt obligation 的自动销账，以及 `:cool:`/SDK pin/DM/422 的事实纠偏方向正确。
- Discord edit/typing/pin 等表现层效果继续不进 outbox，是诚实且符合反 over-reaction 的边界。

## Issues & Recommendations

1. **[HIGH] reconcile release 仍不是按“所读 claim token”执行的 CAS。** `commandCasReconcileRelease` 只有 `claim_generation <= :currentGeneration`，没有 `claim_owner=:observedOwner AND claim_generation=:observedGeneration`（`plan.md:111-119`），但紧接着又声称所有回收翻转都带 owner+generation 谓词（`:132`）。上界只能做候选资格，不能证明要回收的仍是刚才读到的那次 claim；延迟/重叠的 reconcile 可误操作后续 ownership。**建议**：把 current generation 上界留在候选 SELECT，把 release CAS 改为精确匹配所读 `claim_owner + claim_generation + lease_expires_at<=now`；增加“旧 reconcile 快照之后 command 已 release/reclaim，旧 release 必须 0 行”的竞态测试。

2. **[HIGH] `requires` 的 JSON SQL 不是可用的 fail-closed：一条 malformed payload 会毒死整条 lane，级联扫描还会阻断无关 settle。** claim 硬门③和 requires 级联直接调用 `json_each(payload,'$.requires')`（`plan.md:170,187-189`）。我按计划 SQL 实测：前面放一条 `payload='{broken'`、后面放合法候选，SELECT 直接报 `malformed JSON`，不会跳过坏 command；终局级联的全表扫描有同样风险。**建议**：在 canonical SQL 中用惰性 `CASE`/安全包装只把 `json_valid` 且 `requires` 为 text array 的 payload 交给 `json_each`，其余行明确“不允许 claim”但不得中断扫描；级联/DAG 检查也必须复用同一安全解析器。新增“坏行在前、好行仍可 claim”和“无关坏行不阻断 terminal settle”测试。

3. **[HIGH] FINAL P12 的四个内核 action 只有表中一行，没有可执行的授权与原子效果协议。** Plan 把 `mute_reminder/extend_timeout/route_override/emergency_transition` 列为 `kernel` executor（`plan.md:233`），但唯一 executor 合同又明确“纯外发、无 DB 权”（`:247-269`），正常生命周期只定义事务外 `execute()`（`:271-290`）。同时权威设计要求逐 kind 校验 actor/capability/TTL，并在每次成功或拒绝时原子写 `events.kind='bypass_used'`；当前 plan/admission/验收均未实现这份合同（`design-chain/design-final.md:89-98`）。这会导致实现不可建，或更糟地把 break-glass 做成只需 notify_before、无需 founder capability 的普通 action。**建议**：定义单独的 typed kernel-effect settle 路径，在一个 kernel 写事务内完成 capability/actor/TTL 校验、业务状态 CAS、`bypass_used` event 和 command terminal；逐行补正反测试。若所有权要交姊妹批次，必须在 §6.6 冻结完整 API/原子边界，并从本批“已实现 kind”中移出，不能只留注释。

4. **[HIGH] effect probe 得到确定的 `effect_not_applied` 后没有清 unknown episode，下一次执行会继承旧 streak 并提前冻结。** §2 明确“任一次确定答案清零 streak/first_unknown_at”（`plan.md:55-57`），但 canonical reschedule CAS 只改 state/claim/retry（`:100-104`），§6.4 的 `effect_not_applied → pending` 直接走这条 CAS（`:304-309`）。例如 unknown×2 → 确定未生效并重排 → 新 attempt unknown×1，旧 `first_unknown_at` 已满 5 分钟时会被误判成连续三次。**建议**：让确定未生效的重排在同一 CAS 清 `probe_unknown_streak/first_unknown_at` 并更新 `last_probe_at`；同时把 retry_count>=5 的 probeable 分支明确落到 BudgetExhausted+terminal observation+obligation，而不是只写“预算谓词同上”。加入上述跨 attempt 串案测试和 `retry_count=5 + effect_not_applied` 终局测试。

5. **[HIGH] `github_branch_delete` 不入 manual_gate 的前提仍只写在 admission 描述里，尚未成为执行时的新鲜护栏。** Plan 把 managed shape/default/protected/merge evidence/bundle 写在 payload/admission（`plan.md:158-162,227`），但 v1 的真实合同是在删除前异步 fresh 检查 policy、绑定、merged PR head/merge-base、`ls-remote`，最后才做 lease-CAS（`packages/teamlead/src/bridge/branch-cleanup.ts:375-411`）。结构校验或旧 evidence 不能防 admission 后 policy/merge facts 变化，现有验收也只有 admission 拒绝和三态 probe（`plan.md:378,395`）。**建议**：明确 payload 中持久化的 attestation/recovery 字段，并要求 branch executor 在副作用前 fresh 重验全部 v1 护栏；不确定性→unknown，policy/shape/merge-evidence 拒绝→`rejected(stale|policy_denied)`，绝不调用 delete。补齐 no-merge-evidence、protected-policy 改变、binding mismatch、bundle 缺失的 executor 级零删除测试。满足后，我仍支持该 kind 不进 manual_gate。

6. **[MEDIUM] 新增稳定 `id` 排序后，0005 索引没有同步覆盖它，计划声称的“无 TEMP B-TREE”验收当前必失败。** DDL 仍是 `(kind,created_at)` / `(kind,next_retry_at,created_at)`（`plan.md:46-50`），查询已改成 `ORDER BY created_at,id` / `ORDER BY next_retry_at,created_at,id`（`:192,198`）。本机 SQLite 3.51.0 按原样 EXPLAIN，两条均输出 `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`；把 `id` 追加到相应索引后该节点消失。**建议**：新索引改为 `(kind,created_at,id)` 与 `(kind,next_retry_at,created_at,id)`，继续保留 partial predicate 的字面一致，并让普通/ANALYZE 变体都验收完整 plan。

7. **[MEDIUM] GitHub PR 的“head+base 精确认领”只修了说明，没有修 probe 合同。** kind 表文字要求 422 后按 head+base re-read，但 probe 仍写 `pr list --head`（`plan.md:224`）；research 的具体命令也只返回 head 对应 PR，不含 base（`research.md:75-80`）。同 head 指向另一 base 的 open PR 会被误 adopt，导致 intended PR 未创建却写成功 receipt。**建议**：executor 的 422 后重读和 crash probe 共用同一个 exact predicate：repo + state=open + head + base（必要时再绑定 head SHA），返回 receipt 的必须是唯一精确匹配；增加“同 head、不同 base 不得认领”测试。

8. **[MEDIUM] H3 的中心合同仍有多处互相冲突的旧文字，实施者无法判断哪处 canonical。** Plan 的错误分类仍写 permanent→`failed(policy_denied/noop)`（`plan.md:265-268`），与 CAS/settle/P8 的 `rejected` 相反；`:133` 写“第 5 次重排被拒”，但 SQL 与专项又是 retry_count=4 可完成第 5 次重排、=5 才终局；§6.3 标题称“三事务”却已是 A/B1/B2/C 四事务（`:271-290`）。Research 也仍称三事务，并把 0005 记成 commands +4、attempts +2，而 plan 实际是 +5/+3（`research.md:13-16,153-161`）。**建议**：统一以 typed settle 表和 canonical SQL 为唯一文本，删除旧 `definite_failure` 术语/failed 映射，修正 retry 计数句和迁移列数；加一条文档/常量对照测试，避免 research、DDL、类型表再次漂移。

## Verdict

CHANGES REQUESTED
