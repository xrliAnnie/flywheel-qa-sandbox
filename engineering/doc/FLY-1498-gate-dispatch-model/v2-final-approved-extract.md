# FLY-1498 v2 终稿 — 批准裁定摘录
Issue: FLY-1498
日期: 2026-07-28
基于: founder 批准的 `/tmp/v2arch/v2-final-design.html` 与 `[lead-instruction 319d7eb7-2ea6-4e60-984f-fc493c8e2022]`

> 用途：把 FLY-1498 映射所依赖的终稿裁定固化进仓，避免临时文件被清理后失去
> 可复核来源。这里只摘录门与图的方向裁定，不另造设计。

## 1. 总原则

- Agent-first（方案乙）：能让模型做的事不写专用执行器；agent 亲手调用工具，
  工具薄壳只记账。
- 真实复杂性用最小数据承接：DAG、无人值守、跨厂商、founder gate 各由数据和
  通用谓词表达，不发明按场景分叉的流程机器。
- 调度常驻进程只做「看库 → 拉起进程」，不读消息内容、不路由、不执行外部动作。

## 2. 与本单有关的数据

- `tasks + task_dependencies + attempts`：DAG 是数据；节点、依赖、每次 attempt 与
  完成证据都在权威 SQLite 中。
- `gates`：ship 门状态与 founder approval 绑定的 exact head；批准落库，不依赖
  某个会话继续活着。
- `actions`：外部动作黑匣子，记录「准备做什么 → 做成没有」，用于断电后查事实；
  它不是派发器或专用执行者。
- generation：旧世代会话的迟到写由 kernel 拒绝。

Lead 已确认 founder 对原稿裁决台的四个默认项全部采纳：
actions 黑匣子、心跳列、generation、ship 门形状（完成事务内查询 + 批准落库）。

## 3. DAG 与返工

- 三段式、单 session、并行分支都只是 task 行与依赖边的不同形状；引擎零模板、
  零节点名特判。
- 每个 task 至多一个 active attempt。
- rework/retest 在**同一个 task**上创建新 attempt；「新套件武装好 + 旧套件收干净」
  必须在同一事务，不创建 successor task 或流程回边。

## 4. 节点完成合同

- 节点声明性交付物与实际 diff 派生义务共同组成完成合同。
- 产品代码 diff 需要跨族 code review；test-only、docs-only 不因为节点/session
  名字被索要 code review。
- 节点状态完成与合同证据满足写在同一事务，消灭完成后补记录。

## 5. ship

- ship 是动作，不是 DAG 节点。
- ship 前置只有三条通用项：founder approval 绑当前 head、当前 DAG 全节点成功、
  世界侧 head 未漂移。ship 不重新检查 code review/QA/docs 证据。
- gate 由使当前 DAG 达到「全成功」的事务内查询打开；「最后」是查询结果，不是
  节点身份。
- founder approval 写 `gates` 并绑定 exact head。
- 活着的 agent 亲手调用 GitHub merge；没有 agent 活着时，调度只负责唤醒一个
  agent，由被唤醒者重新核通用三条后执行。

## 6. 删除与跨单边界

- 删除 TURN 接力棒、病历卡族（obligations）、派发器/专用执行者注册与认领；
  不留 `ownerLeadId` 的 v2 consumer。
- 跨单只保留两条：vendor adapter 接口（已冻结）与 heartbeat 列
  （FLY-1499 建列，调度读取）。
