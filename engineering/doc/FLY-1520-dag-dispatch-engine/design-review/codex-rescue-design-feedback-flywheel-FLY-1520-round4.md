# Design Review — FLY-1520 plan.md (Round 4)

Date: 2026-07-28
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 4 已正确关闭 Round 3 的 activation generation、intended-tail retry、approved-authority recovery、reopen/action-tail 和 logical-agent 单飞主路径问题，整体离可实施只剩 launch/agent lifecycle 收口。新引入的 activation-scoped launch fence 仍有一个确定的 session-key 冲突和一个未真正线性化的 read→exec 窗口，此外 agent_binding 初建/转移与已有 agent 接入尚不闭合，因此不能批准。评审基于当前 HEAD `f7d20453` 的完整计划和真实 API/DDL/trigger；checkout 无 `node_modules`，未声称运行了测试。

## What's Good (Keep)

- activation.generation 现在始终等于 attempts.generation，agent generation 被限制在 agents/RegisteredAgent/action actor/processing_attempts；这与 migration 0006 lineage trigger 及既有分叉 fixture 完全一致。
- T3 绑定链明确校验 activation.generation==attempt.generation，M0 也加入 agent=3、attempt/activation=2 的真库反例，保留。
- `launch_claim` 与 `agent_binding` 都采用统一 meta revision+epoch 信封，收割先 tombstone claim、再 terminal suite 的顺序正确。
- advanced-generation definitive rejection 现在可凭 exact `action_unsettleable_generation` 证据从 intended tail 续合法 successor，不再被 failed-only predicate 卡死。
- approved-authority recovery 区分“同 logical actor 仅换代”和“actor/config 改变需 founder 再授权”，没有静默扩大授权。
- reopen 完整清 target/actor/config/capability/approval/retry，action attempt 序号改从真实 chain tail 派生；六败后同 actor fresh approval 不再尝试第二个 root。
- global agent_binding 单飞、deterministic instanceId、durable attempt_dispatched identity payload和 terminal 全路径清绑定的方向正确。
- ship target、evidence、receipt-first、T4 observation、writer gap、四态 gate、两包依赖及所有原硬边界继续保持。

## Issues & Recommendations

1. **[阻塞] T7 的“新 session_ref”按当前公式会与旧 session_ref 完全相同，并撞上 tombstoned launch_claim。** T2 定义 `session_ref='v2dag:'+attempt_id+':'+attempt generation`（`plan.md:255-260`）；T7 明确复用同一 attempt、attempt generation 不变，却又要求新 session_ref 和 `launch_claim INSERT`（`:391-403`）。因此 resume 会得到旧 session_ref；旧 `launch_claim:{session_ref}` 已在同事务先 tombstone，随后对相同 meta key INSERT 必然主键冲突。即使改成 UPDATE，旧/新 activation 的 probe、owner token 与 crash receipt 也会混为一条。**修正**：session_ref 必须是 activation identity，而不是仅 attempt identity，例如 `v2dag:{attempt_id}:{attempt_generation}:{activation_id}`（activationId 预生成，故仍可确定重建）；activation.generation 继续保持 attempt generation。T7 的 `activation_resumed` receipt/launch reconstruction 也必须绑定新 activation/session/owner token。增加同一 attempt 连续 resume 两次、两条 tombstoned claim 均保留且第三条 claim 唯一的测试。

2. **[阻塞] launch claim 仍不是从 SQLite 判定到外部 exec 的线性化 fence。** 当前适配器只在 exec 前重读 token/state/activation（`plan.md:272-281, 414`），没有要求 `lease_until > now`；reaper 延迟时，过期 launcher 仍可在 claim 保持 claimed 的情况下启动。更关键的交错仍成立：adapter 读到 claimed → 被抢占 → reaper tombstone+terminal → adapter 恢复并 exec。真实 `EngineDriver.attachRunner` 只检查 agents kind/generation，不检查 activation active，因此不能补上这道缝。T7 又没有 T2 的 dispatched→started 单赢家 CAS，而 launch_claim 在业务事务内已经是 claimed；两个重构 launcher 可持同一个数据库内 owner_token 并同时通过。**修正**：把 claim 状态机改为 activation-scoped `pending→claimed(owner_token,lease_until)→tombstoned`，owner_token 由 claim-confirm 竞争者产生，T2/T7 都必须通过 revision CAS 恰一胜；过期 takeover 换新 token，使旧 launcher自动失权。adapter 必须校验未过期，并与 reaper 使用同一个 per-session OS lock/fencing adapter：validation+exec 与 tombstone+terminal 互斥，不能只靠“立即重读”。新增三例：两个 T7 launcher 争同 activation、lease 过期但 reaper 尚未运行、adapter 已读后与 reaper 交错。

3. **[高] agent_binding 的首建和字段转移还不是闭合的数据合同。** §2.2 把 meta INSERT 首建限定为 admission/gate/families 三处（`plan.md:103-110`），但首次 dispatch 还必须创建 agent_binding 与 launch_claim；T2 又写“agent_binding CAS 置 active”，对不存在的行无法 UPDATE。数据形状要求 `session_ref_last`，首次 active 写入列举的字段却没有它；terminal 说“保留 last”也没有明确执行 `last=current,current=null`；T7 DeathEvidence 写的是不存在的 `agent_binding.session_ref`（`:393-395`），实际字段是 session_ref_current/last。**修正**：在 meta.ts 给每个新 key 写精确转移表并纳入允许的 INSERT sites：absent→active 用 INSERT；clear→active 用 revision CAS；active(old)→active(new) 把 old.current 移入 last；active→clear 把 current 移入 last并清 current/activation/attempt。首次 last 明确为 null或 current，并让 parser 与表一致。修正 T7 probe=current、后续 dispatch probe=last；M1 加全转移与旧 revision replay 测试。

4. **[高] 已存在但从未进入 v2-dag 的 generation>0 agent 会永久无法派发。** T2 对这类 agent 要从 `agent_binding.session_ref_last` 取得 absence evidence（`plan.md:242-245`），但该 key 只由 v2-dag dispatch/T7 创建；当前合并库里的既有 v2-engine agents 没有 binding，agents 表本身也不存 instanceId/activation/session。eligibility 允许 binding 不存在，随后 evidence 又永远拿不到，形成静默跳过。**修正**：二选一并写进 admission：本批 executor logicalAgentId 必须是不存在或 generation=0 的 fresh/provisioned agent，generation>0 且无 binding 直接 admission typed reject；或增加显式、审计化的 legacy-agent adoption API，以外部 supervisor 的 exact process/session evidence 创建 clear binding。不得让 dispatch loop无限 skip。加入 existing gen>0/no-binding 的反例。

5. **[高] T4 终态化活跃下游 runner 仍缺少获得 absence 的可执行路径。** 计划要求 T4 收集 DeathEvidence，却只有 ProcessProbePort，没有 stop/quiesce port；正常 rework 的下游 runner 很可能仍 present。直接 terminal activation/claim 后，旧 physical runner 的 agents generation 对未被新 target 注册换代的其他 logical agents仍 current，而 `attachRunner`/engine poll 本身不以 activation state作 current-generation fence。仅规定 runner 在“自己收到 completion/terminal 返回后退出”不能覆盖被外部 rework 终态化的进程。**修正**：T4 在事务前对闭包内每个 active suite 增加 quiesce protocol：通过 RunnerControlPort/宿主 supervisor 请求停止，ProcessProbe exact session 确认 absent后才进入事务；若仍 present，返回 typed `ReworkAwaitingQuiescence`，不改库。或者明确该 absence packet 是 API 强前置且由哪个 1502 组件提供，但本包测试仍需 fake stop→absent 流程。覆盖活下游 present、stop 后 absent、stop/完成竞态。

6. **[中] capability “恰两个 mint 点”的文字与新增恢复 API 仍不一致。** §2.3 仍写 mint 2 仅为 due-retry（`plan.md:144-148`），而 T6 又有 generation recovery mint，`recoverShipAuthority` 也直接 mint（`:376-384`）。逻辑授权边界可以保持两类，但实现者按当前文字会得到三个以上 call sites，静态验收也无法判断越权。**修正**：明确两类且集中到两个内部入口：founder-authorized mint（approve + recoverShipAuthority 共用同一 helper/authority predicate）和 reconciler rearm mint（due retry + same-actor generation recovery共用一个 helper）；逐一列出 caller、predicate 和事件，静态测试断言 capability INSERT 只存在于这两个内部入口。recoverShipAuthority 还应明写 approved、settled null、target/tip/DAG unchanged、无 intended action。

## Verdict

CHANGES REQUESTED — address items above
