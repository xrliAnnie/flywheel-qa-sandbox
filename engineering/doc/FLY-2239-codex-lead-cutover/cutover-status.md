# FLY-2239 Codex Lead 全员 cutover — 收官状态
Issue: FLY-2239 (https://linear.app/geoforge3d/issue/FLY-2239/cutover-resident-codex-lead-全员切换2216-ship-后名册-opt-in-激活五步-pane-告警对齐)
日期: 2026-09-05
基于: plan.md

> 状态:实现节点 scope-cut 版。下表只记录设计阶段于 2026-09-05 实核的现状;D0–D6 已设计、未执行,待 founder 真正需要时再跑。本轮只交付名册驱动 pane guard、测试与 PR。

## 已定决策

- **pane 告警选 O1(名册驱动)**:本 PR 已把 guard 改为复用 `findResidentCodexLeadTargets` 并逐字匹配 `projectName/leadId/leadKey`;统一标题为 `Codex Lead <project>/<lead> TUI window not visible`,成功装载会写 `guard ARMED for <project>/<lead>`。合入并部署前,生产仍是旧字节。
- **InfraBot 维持纳入**:founder 2026-09-02 06:37Z 原话「InfraBot(Claw)纳入」([原消息](https://discord.com/channels/1485787271192907816/1516209714097291335/1544597171095994408)),06:38Z 原话「go + InfraBot 纳」([原消息](https://discord.com/channels/1485787271192907816/1516209714097291335/1544597258421665833))。Tadashi 裁定:resident Codex 名册语境下实际对象是 `codex-infra-bot-lead`;`claude-infra-bot-lead`(Claw)不是本次对象,零触碰。
- **真机强停演练延期**:founder 2026-09-05 06:54:46Z 原话「we could do 2239 常驻验收演练 too, I am not using them recently so stop is fine」([原消息](https://discord.com/channels/1485787271192907816/1516209714097291335/1545688627189645372));Lead 随后按 founder 08:18Z 直令收缩本轮范围:D0–D6 不做,待 founder 真正需要时再跑。没有新的当次授权不得执行任何强停或 kickstart。

## 收官状态卡

| Lead | opt-in | plist / manifest | observer / 巡逻观察 | pane 五层 | 假死演练 | 真告警 URL | pane guard ARMED | 证据目录 |
|---|---|---|---|---|---|---|---|---|
| `raya/raya` | 未执行;registrar 在 FLY-2259 | 均未出生 | 未出生 | 未验 | 已设计、未执行;待 founder 需要 | detected:无;recovery:无 | 未出生 | 无 |
| `growth/mufasa-lead` | 2026-09-02 06:57Z | 在 / 在 | heartbeat online、巡逻于 2026-09-05 06:12:22Z 观察本代 | 待窗口复核 | 已设计、未执行;待 founder 需要 | detected:无;recovery:无 | 待本 PR 部署后的下一代 | 无 |
| `flywheel/codex-infra-bot-lead` | 2026-09-02 07:27Z | 在 / 在 | heartbeat online、巡逻于 2026-09-05 06:10:05Z 观察本代 | 待窗口复核 | 已设计、未执行;待 founder 需要 | detected:无;recovery:无 | 待本 PR 部署后的下一代 | 无 |

## Raya 的两个边界

| 边界 | 完成谓词 | 当前状态 |
|---|---|---|
| 激活完成 | FLY-2259 runbook §4.0–§4.9 全过;§4.7 证明 launchd、pane、online heartbeat、exact probe 与真人回话;§4.9 关闭出生窗口;未进入 §4.11 回滚 | 未执行 |
| FLY-2239 收官 | 本 PR 经班车部署;§4.10 前先证明巡逻观察本代;演练后 detected/recovery 两 phase 各新增一条 target-bound claim 与一条真 Discord URL;新代日志有 roster-driven ARMED 行 | 未执行 |

Raya §4.10 的 claim overlay 必须在强停前后各拍一次。查询必须保留 `event_type`、fleet `lead_id` 两个精确条件,并用 `GLOB` 绑定 target + phase(`LIKE` 会把 kind 里的 `_` 当通配符):

```sql
SELECT 'detected' AS phase, COUNT(*) AS claims
  FROM alert_claims
 WHERE event_type = 'codex_lead_residency_stalled'
   AND lead_id = 'codex-lead-residency'
   AND event_id GLOB 'codex_lead_residency_stalled:raya-raya:detected:*'
UNION ALL
SELECT 'recovery', COUNT(*)
  FROM alert_claims
 WHERE event_type = 'codex_lead_residency_stalled'
   AND lead_id = 'codex-lead-residency'
   AND event_id GLOB 'codex_lead_residency_stalled:raya-raya:recovery:*';
```

`claims.after` 必须相对 `claims.before` 为 detected **恰好 +1**、recovery **恰好 +1**。对应 Discord URL 分别单行写入 `recovery-drill.alert.detected.url` 与 `recovery-drill.alert.recovery.url`;不能拿别的 Lead 同期告警补数。

## 延期演练的停止线

本节只是未来再次获批时使用的合同,不是本轮验收项。两位必须串行,先 Mufasa 后 InfraBot;每位成功 = research.md §4 的 D0–D5 全过且 D6 未进入。强停前记录 exact label、pid、lstart、T0 与预期路径「Bridge residency 巡逻 → resident recovery helper → 本 Lead 自己的 launchd job」。强停后每分钟记录一次。

10 分钟线沿用设计实核:生产巡逻每 60 秒一次;最坏估算为 heartbeat 过期 180 秒 + 等下一轮 60 秒 + 连败后两轮 120 秒 + helper 30 秒 + 新代 online 60 秒 = 450 秒(7.5 分钟)。开窗当日若实测间隔使估算超过 10 分钟,先问 Lead,不得开窗。到 10 分钟完整收敛元组仍缺任一项即进入 D6:恢复可用性、记 FAIL、停止后续强停并报告 Lead。

## 未来持棒者回填合同

再次获得 founder 需要 + 当次授权后,每位完成时回填:`T0_at → 收敛时刻`、新 pid/lstart、新 generation/carrier、`pre_mutation` receipt 行号、detected/recovery 两条 URL、`verify-windowed-lead.sh` rc、ARMED 行时间戳、证据目录。Raya 只有两个边界都过才把整行标为完成。任何 FAIL 保留原始事实,不得只写最终又活了。
