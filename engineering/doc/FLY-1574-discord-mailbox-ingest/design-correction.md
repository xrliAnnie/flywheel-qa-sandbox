# FLY-1574 设计更正附录 — 交付即启用(ship-enabled)

Issue: FLY-1574 (https://linear.app/geoforge3d/issue/FLY-1574/消息层重构-e-批次2-discord-收编不再直推统一走-mailbox)
日期: 2026-08-10
基于: plan.md(R8,implementation-node cross-family review 修订)

## 触发

Lead 指令 `[lead-instruction 71b5bf84-69ac-4640-9d15-0ad9d86a2227]`,转达 founder 当日指令:

> 「我们做的所有事情,如果是带 feature flag 的,要直接给它 enable。这样避免做了但因为 flag 没 enable 导致我们看不到。」

背景:本周三次发生「做了但 flag 没开导致没生效」(auto-QA / Opus 4.6 / FLY-1663 v2 carrier)。

## 更正内容(对 plan.md 的交付约束)

1. **交付终态 = ON**。`FLYWHEEL_MAILBOX_DISCORD` 的置 ON 动作从「runbook 里的一步」升格为 **ship 完成的定义的一部分**:代码合入但未置 ON 且未实测生效 = ship 未完成,不存在「合了等人来开」的交付状态。
2. **机制不变**:flag 读法(dotenv_live 现读)、OFF 路径字节等价、运行时回切(founder 08-05 回滚要求)全部保留;registry 极性仍为显式取值(`'1'`=ON)——因为 §6.1 的 census/清账栅栏要求 ON 的时点受控(Codex R1 #10 裂脑防护),**受控 ≠ 可选**:栅栏步骤全绿后置 ON 是无条件的收尾动作。
3. **验收补强**(§3.2 新增第 7 条):部署后**实测新流真的在跑**(founder 真发消息 → mailbox `discord_chat` 行出现 + 该消息零直推)→ OFF 回切实测旧流 OK → **再回 ON 并停在 ON**。「配置写了」不算数,以行为证据为准。

## 不变项

- founder 的 ship-enabled 结论不动;implementation-node 复审发现的 route 保真、headless socket、Discord 静默 DEAD、OFF mutex 逃生、双 runtime socket ownership、lock-unavailable 与 poison-row claim wedge 问题已在 plan R8 修正,以 R8 为技术权威;
- OFF 作为回滚手段的可用性与测试(哨兵)不动;
- flag 删除仍归全家族清理单。
