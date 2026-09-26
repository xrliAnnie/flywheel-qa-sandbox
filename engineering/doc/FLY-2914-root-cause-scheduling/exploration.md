# FLY-2914 病根排修闭环 — 探索
Issue: FLY-2914 (https://linear.app/geoforge3d/issue/FLY-2914/巡检闭环-6-巡检每轮自动列出病根类别出现-3-次且没有修复单在跑-lead-必须呈报-founder-排修让巡检发现的问题变成自动机制)
日期: 2026-09-25
基于: 无

## 问题与成功标准
FLY-2072 已按 class_key 记录病根，但多次出现的类别能长期留在 Backlog。每轮必须读出 occurrences ≥ 3、未 Done/Canceled、无 active workflow run 的类别，按次数降序展示；完成巡检前逐项交代本轮已呈报的 thread 消息或已有排期理由。等待 founder 的同一轮决策不重复发消息。标题与描述计数不一致取最大值，并保留差异。

## 选择
在现有巡检快照、FINDING 和 receipt 完成门增加排修检查。只读 Linear；使用工作流的持久运行状态；沿用既有呈报渠道与 waiting-episode（同一等待阶段只呈报一次）的思路。工作类型选择 code：跨快照、报告闭合校验及持久去重，不能只改提示词。

不选：仅提醒 Lead 自觉查看（不能验收门）；按 In Progress 标记推测 run（会误判）；自动建单/派单（未授权）；新排修服务/新消息通道（不必要）。

## 调研问题
- 两种快照入口（直接脚本与 Bridge 固定源执行）怎样得到同一份完整 Linear 子单数据？
- 现有 Linear list 不支持 parent/cursor 时，最窄只读扩展在哪？
- active workflow run 状态集合和 issue UUID 绑定是什么？
- 原 FINDING 的机制缺陷处置要求写 Linear；本轮只是催排已有类别，怎样避免错误增加次数或写入 Linear？
- 哪种既有消息回执与入站消息记录可证明已呈报、等待未结束？
- 完成门怎样防止删除候选项、伪造消息链接、吞掉分页失败？

## 范围
设计节点仅交付文档、评审和 founder HTML，不实现、部署或派发后继。后续实现先写相关失败用例，再最小实现。本机仅运行相关测试。现有巡检的其他建单规则不属于本任务；新增排修路径严禁写 Linear。

## 当前证据
基线 923d7a551。TURN: design / epoch 4 / activation:54486be1-bbac-413f-bb45-f805d010d466:759af149-5b7f-48dc-a11e-8c829eb39a96:eng_design:1。
现有 patrol.snapshot 由 Bridge 固定 helper pin、注册报告摘要；patrol.judgment.record 原地补充判断并执行三个完成门。通用 Linear issues 查询不接受 parentId / cursor，不能把第一页当完整子单集。
Bridge health 在初次观测中超时，stage brainstorm 已持久排队，后续按同一执行身份重查；不重启服务。
