# Design Review — FLY-2137 plan.md (Round 2)

Date: 2026-08-31
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 已实质接受并大体关闭 Round 1 的 7 项意见：治理边界诚实、ACK 删除、QA target-set、部署顺序、kind 链路与 launchd installer 的方向都正确，整体架构可实现。但 committed blob `a04741c290403efe2b8a4a3dabf29393ff0f9cc6` 仍有一个真实 `gws` 直写 grammar 绕过，以及会让同日后续 finding 被既有 receipt 吞掉的 sweep 状态机反例；另有坏 JSONL 无法前进、mode finding 语义冲突和不可落地的 kind owner，故本轮仍需修改。

## What's Good (Keep)

- §0/§4.4 已准确把交付定性为 Claude CLI 行为护栏、审计和启发式检测，并把 credential isolation 设为另立 blocking issue；founder HTML 同步使用诚实措辞，避免以行为 rail 冒充机器授权边界。
- P6 已改成 service/method grammar + 读 allowlist，正确移除顶级 `gws events`、纳入 `transferOwnership`/ACL/clear/watch，并以未知方法 fail-closed；QA 豁免也改为逐形态 target-set，严格处理 `--params`、`events move` 双目标、默认 primary 和 QA id 格式。
- v1 删除 ACK 是正确收敛；receipt 存在而 mode 缺失/损坏即 deny，消除了 Round 1 的“误删后静默回 audit”。P1–P5 bypass 对 P6 明确无效也应保留。
- 部署/QA 顺序现在安全：先 converge hash 与注册证据，再用 hook stdin/PATH stub 做 audit/deny 演练；真实写只落 QA calendar 或明确授权的 Raya 回归，且 Raya cancel/cleanup 被纳入验收。
- alert kind 已补齐 shell、TS union、copy、kind-contract 和双面测试；sweep installer 也复用了现有 render/lint/bootstrap/bootout 先例且不在 CI/QA 自动安装，scope 合理。
- Ship 段保持为条件规则：当前仅需 Flywheel PR；若实现中出现外部仓改动，则先有 Flywheel anchor PR、`complete --pr` 绑定该 PR、伴生 PR 另取 founder 授权。该规则没有无端扩大本单实现范围。

## Issues & Recommendations

1. **[HIGH] `gws` service grammar 仍有已验证的直接 Calendar 写绕过，帮助/版本命令也会被误拦。**

   **问题：** §4.1:111-119 只接受 service 精确等于 `calendar`，但本机只读 help 实测 `gws calendar:v3 events insert --help` 成功进入 “Creates an event.”，即 `calendar:v3` 是当前 CLI 接受的同一 Calendar API service 形态；按计划它因 service 不等于 `calendar` 而完全退出 P6。另一个有效形态 `gws --api-version v3 calendar events insert --help` 也证明 `--api-version` 是带值 global flag，但未列入 stripping 表。反向看，`gog/gws --help|--version`、`gog calendar create --help`、`gws calendar help` 等只读 introspection 不在 allowlist，而“positional 缺失/未知 method 一律写候选”会把它们 deny，与 §0 的“读方法零误伤”冲突。

   **影响：** 这是计划覆盖范围内的直接 CLI grammar，不属于 §4.4 已接受的脚本/API 外绕过；攻击者或误操作只需使用 CLI 自带的 version-qualified service 即可越过 enforce。帮助命令误拦还会妨碍 agent 在升级后核对真实 CLI surface。

   **建议：** 将 `gws calendar:v3` 规范化为 Calendar service（并对 `calendar:<version>` 做严格、测试覆盖的版本语法判定），把 `--api-version` 的 `=`/空格形态纳入真实 global-flag 表；对 `-h|--help|--version` 以及各层 `help` 子命令定义只读终止语义，且仅在确认它们不会继续执行 mutation 时放行。RED 1 加上述已验证命令，以及 version-qualified insert/update/delete deny、非 Calendar `<service>:<version>` pass 的矩阵。

2. **[HIGH] `dayReceipt + 固定日签名` 会吞掉当天首条告警之后出现的新 finding，跨日 pending 也可能造成一天两条。**

   **问题：** §5:185-190 规定同日固定 signature，并把 `lead-alert.sh` 返回的 `sent` 当作新 snapshot 的 receipt。实际 `lead-alert.sh:527-531` 对同 eventId 已有 sent receipt 时直接返回 `sent`，不会更新或再投递 body。反例：09:00 发送 finding A 并推进 cursor；14:00 出现 finding B，sweep 写 B 的新 outbox、调用同一 eventId、收到旧 `sent`，随后按计划推进 cursor，于是 B 永远没被 founder 看见。计划虽存 `dayReceipt`，却未规定 receipt 后同日新 finding 的 defer 分支；若前一日 outbox 到次日才重试成功，再发送当日 eventId，还可能在一个 PT 日实际投递两条。零 finding 又没有 delivery receipt，按“只有 receipt 才推进 cursor”会永远不 checkpoint 成功扫描。

   **影响：** 这直接违反 Lead 硬约束“≤1 条/天且不丢”，而现有 RED 3 的“同日两跑只出一条”只检查数量，反而可能让该丢报实现通过。

   **建议：** 把状态转移写明：当前日已有 `dayReceipt` 时不得为新 finding 复用旧 receipt、不得越过它推进 cursor，而应保留到下一 PT 日聚合；跨日仍未 receipt 的 outbox 必须与当前积压采用一个明确的 re-bucket/merge 策略，保证当天最多一次实际投递；完整且零 finding 的成功扫描应允许本地原子推进 cursor而不产生 alert/dayReceipt。RED 3 增加“首条 receipt 后同日新增 finding 次日必达”“昨日 pending 在今日恢复且今日总投递仍 ≤1”“零 finding 会推进两个 cursor”三类状态机测试。

3. **[HIGH] 坏 JSONL 的 fail-loud 规则会形成永久 livelock，并压住其后的有效 finding。**

   **问题：** §5:197-198 同时要求单条坏 JSONL“跳过并计数进报告”、stderr + 非零退出、且“不发半成品告警”；§5:187-190 又要求无 alert receipt 就不推进 log cursor。于是同一坏行会在每次运行中重新触发非零，cursor 永远停在它之前，其后的有效 P6 行也永远不能形成可发送的完整 snapshot。“计数进报告”与“不发送报告”目前也没有可观察的 durable 落点。

   **影响：** 一条截断日志即可永久关闭整个 guard-ledger 检测面，launchd 只留下重复 stderr；这不满足计划声称的 fail-loud 且不丢。

   **建议：** 明确选择一种可收敛合同：例如把坏行原文 hash/位置写入 durable quarantine，并将 `audit_log_parse_error` 作为完整聚合 finding，只有该聚合取得 receipt 后才越过坏行；或 fail-stop 并提供必须人工修复/确认 cursor 的 runbook 与独立可见告警。无论选择哪种，都测试“坏行后仍有有效 P6 行、重启/重跑不 livelock、不静默跳过且最终只聚合一次”。

4. **[MEDIUM] enforce→audit 的 finding 语义在计划内部冲突，现有 state 也无法表达“一次降级”。**

   **问题：** §1:53-54 明确说 enforce→audit 降级本身算 finding，用户列出的 Round 2 修订也保持该要求；但 §5:180 又排除“显式授权 audit”。若目标是记录一次授权回滚，当前 state 没有 `lastObservedMode`/rollback receipt cursor，无法区分“刚发生的降级”与“已经处于 audit”，只能完全不报或每天重复报。

   **影响：** 实现者会在互斥规格间自行选择，RED 3 的“mode 降级 finding”也无法给出唯一预期。

   **建议：** 统一为一个可测试规则。推荐所有 enforce→audit transition（即使经 founder 授权）聚合一次，state 持久化前后 mode/授权消息 id；持续 audit 不重复报。若 founder 决定授权回滚完全不算 finding，则同步删除 §1 与 RED 3 的相反要求。

5. **[MEDIUM] `owner=eng Lead 责任域` 不是现有 `KindContract` 可接受的 owner，照计划实现会编译失败或路由错误。**

   **问题：** 实际 `KindOwner` union 仅有 `claude | codex | cross_by_provider | founder_direct`（`kind-contract.ts:39-43`），且 `kind-contract.test.ts:313-349` 强制 contract owner 与 `resolveTicketOwner` 一致；不存在 `eng Lead` literal。若随意改成默认 `claude`，`ticket-owner-map.ts:117-119` 会把 ticket 分给 Claude infra bot，并不等价于 Engineering Lead 责任域。

   **影响：** 计划当前不能机械落地，且 owner 选择会改变谁收到并负责处理治理告警。

   **建议：** 在 plan 中写出一个现有的精确 literal 及其实际路由后果；若确实必须由项目 Engineering Lead 持有，则把新增 owner 类型、resolver/owner face、NO_OWNER/CROSS 表和相应测试列入改动清单，不要用自然语言占位。`none_escalate` 与 remediation ref 可保持不变。

## Verdict

CHANGES REQUESTED — address items above
