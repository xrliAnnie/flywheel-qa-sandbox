# FLY-2910 设计评审 第 5 轮（re-dispatch 同 blob 复核）

- exec: 2dd9e016-7249-4832-9428-a93b5333f760 · requestId: eca434d5-2fca-4dad-8151-bc76e17d2e91
- reviewer: gpt-6-astra xhigh · codex session 01a0dc62-d6b9-7cd2-8f02-138decd8dc73
- plan blob: b31ba94ad1d98ae7deed84598f9664078638c5c1（与 R4 APPROVED 相同，未修改）
- 前一次尝试（session 01a0dc61-363b-7a73-80ff-657d872cee94）撞额度，无结论；Lead 换号后重跑本轮。

## Summary

本次结论绑定计划 v2.2 的精确 blob：`b31ba94ad1d98ae7deed84598f9664078638c5c1`。源码抽查 HEAD：`0e26db8a64e7e85d523e19557cbcd840eb388f7f`。

**[已执行验证]** `git log`、版本差异及哈希核对确认：R4 基线的 SHA-256 与[评审记录](engineering/doc/FLY-2910-alert-wake-dedup/review/design-review-round4.md:10)一致；当前计划仅更新版本说明、增加 R4 审批记录，设计正文没有实质变化。最终验证退出码为 0。

**[已读取源码核验]**

- **不吞新待办**：仅合并同代、窗口内、已有送达证据的等价告警；缺少身份或代次证据时照投。证据写入位于回执匹配及 owner 检查之后。[投递顺序](packages/teamlead/src/bridge/lead-inbox-loop.ts:531)
- **升级仍唤醒并带累计次数**：严重级别上升、新对象、新动作、数量变化均保留唤醒；数量翻倍被“数量变化即唤醒”覆盖。注记包含当前信及同批次先前告警。[判定与注记合同](engineering/doc/FLY-2910-alert-wake-dedup/plan.md:116)
- **Lead 隔离及重投幂等**：状态按 `(lead_id, fingerprint)` 查询；逐 delivery 标记与计数同事务提交，换代时重建严重级别证据。[StateStore](packages/teamlead/src/StateStore.ts:24761)
- **info 摘要**：可识别的纯 info 不唤醒；保留已批准的 `flag_scan_handoff` 待办例外。[判定入口](packages/teamlead/src/bridge/alert-wake-dedup.ts:148)
- **项目开关**：默认开启；关闭或读取失败时绕过去重，恢复原有逐条投递路径。[开关登记](packages/config/src/feature-flags/registry.ts:725)

## Issues

未发现本次范围内残留的 **BLOCKER/HIGH** 设计缺陷；无新增 MEDIUM/LOW 建议。

保留既有边界：plain／未知形状照投；搭车摘要为至多一次。此次为设计复核与接口抽查，未运行实现测试，未修改任何文件。

## Verdict

批准上述精确计划 blob；既有审批依据仍成立。

Verdict: APPROVED