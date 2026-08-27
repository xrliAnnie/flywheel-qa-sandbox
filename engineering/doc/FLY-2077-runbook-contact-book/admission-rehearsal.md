# FLY-2077 新类别入册演练记录
Issue: FLY-2077 (https://linear.app/geoforge3d/issue/FLY-2077/2073册子-runbook-contact-book-进仓骨架-第一版底稿读者-infra-bot通用写法)
日期: 2026-08-27
基于: plan.md

## 目的

验证 README 里的「新类别出现 → 谁写 → 写在哪 → 最少写什么 → 怎么验」是一条能执行的入册路径。本记录是实现验收证据，不保存该告警的处理流水或原始 log。

## 真实告警样本

- 类别：`cmux_cleanup`
- 非敏感事件标识：`a35f63d6ed98815e167eefae5bc755824a2e5dbb`
- 告警 Lead：`flywheel-eng-lead`
- claims 记录时间：2026-08-27 13:20:01 PT
- 真实性来源：运行中告警 claims 账本的只读查询；该账本还显示此类别自 2026-07-21 起持续出现。

## 从新类别到落位

| 入册问题 | 本次演练结果 |
|---|---|
| 谁写 | 由处置该类问题的 Infra bot 或 Lead 写；本次骨架由 Implement runner 代入处置者角色落位，后续真实处置由 Tadashi 维护 |
| 写在哪 | `doc/oncall/runbooks/cmux_cleanup.md` |
| 现象 | 已写：清理因证据不足或状态冲突拒绝继续 |
| 去哪看 log 还原 | 已写：从 cmux 同步任务的调度或启动配置取得 log 位置，用告警对象、拒绝原因和时间定位 |
| 做了什么 | 已写：保留对象、不绕过保护、把证据交给 Tadashi；真实安全清理发生后再回填动作 |
| 怎么确认好了 | 已写：后续同步 log 记录处置结果，且同一拒绝在负责人选定的观察范围内不再出现 |
| 该找谁 | `contact-book.md` 对应行指向 Tadashi |

## 演练结论

这条真实告警可以从类别直接落到一页 runbook 和 contact book 的一行，五个最少栏位齐全；过程中没有需要新增脚本、检测器或处理流水。独立的「无本机上下文 bot 走通」由 QA 节点按 README 执行，本记录不冒充该独立抽验。
