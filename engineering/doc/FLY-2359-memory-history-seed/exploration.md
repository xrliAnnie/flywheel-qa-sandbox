# FLY-2359 历史记忆种回 — 探索
Issue: FLY-2359 (https://linear.app/geoforge3d/issue/FLY-2359/2355b2-记忆回流-种回去任务结束把一次性家蒸馏出的记忆汇进-agent项目)
日期: 2026-09-08
基于: 无

## 需求与已裁定范围

同一个 agent 在同一个项目中，第 N 次任务已经蒸馏落盘的经验，在第 N+1 次任务开场可用；不能串 agent，不能串项目。

上游 PRD 为 `flywheel-FLY-2119@305e9ed9d651cc78f65a2b06006ab00be12337da:engineering/doc/FLY-2119-codex-identity-memory/prd.md` §5.3.1/2/4、§7.2。当前分支包含 B1（FLY-2358）已实现的路线 (a)：`agents/<encode(project)>/<encode(workflow_node_id)>` 共享持久 home。因此本单交付首次种回历史及四条验收，不再建任务结束回流服务。B1 的新任务原地积累就是持续存放点。

## 现状证据

- 基线 `ee113cab956bf3d71f186e5d72b24baf545e629c`，本阶段 TURN 为 design epoch 1。
- B1 `plan.md` §0.1、`implementation-evidence.md` 与当前 `codex-home.ts` 一致：准入锁内决定身份、创建租约；旧任务恢复仍用 execution home。
- 当前建家不导入旧 `memories`；旧家不能删除，否则会丢掉唯一历史。
- 2026-09-08 只读 sessions 聚合：606 条 Codex 执行有 `(flywheel, implement)` workflow_node_id；152 条历史 implement 的 node id 为空。不能把这 152 条的显示/旧分类字段自动升级为可信新身份。
- `eng_design` 与 `design` 是两个不同的稳定 node id；`session_role=design` 只是粗分类，不合并为一个人。

## 选择方向

复用 B1 路径、锁、租约以及现有 runner contract 装配。只对有精确 project + workflow_node_id 的已终态旧执行读取已蒸馏 Markdown；从受管 home 根按 execution id 推导路径，拒绝任意来源路径。未知归属留在原处并报告数量，不根据标题、worktree 名或内容猜。

待 research 定稿的是历史载体：直接拼进 Codex 原生 memories 最像原生使用，但可能被 Phase 2 重写且需要搬数据库才能保持输入引用；独立只读历史目录加启动 contract 入口能避开这一所有权冲突。优先最小且不会静默丢历史的形式。

## 去重与冲突的产品语义

去重必须按内容字节和来源决定，重复运行结果一致；不同文字都保留来源，不让模型判断覆盖哪条。不承诺自动识别语义矛盾。当前任务的显式指令优先于旧经验，互相矛盾的旧经验应被看成历史证据，不能当授权。

## 四条验收不收缩

1. implement 任务结束后，该对持久 home 中有本次已蒸馏条目。
2. 下一任务首个开场可以读到它；另须证明首次从旧家种回也可读。
3. qa home 没有 implement 标记。
4. flywheel implement home 没有 joycon-typeless implement 标记。

QA 必须在 529 房/真机执行真文件夹具。受控 RED 分清：撤掉历史 seed 证明首次导入断开；恢复 execution 级家且不回流证明原需求 1/2 失败。不能把 B1 已绿色的持久化冒充 B2 的新增效果。

## 边界

不实现代码、不派后继节点、不部署；不加删除任务 home、不清理旧家、不动公共 home、不改记忆节流值。新记忆自动蒸馏受 Codex 原生时机影响，传输验收不能伪称已经证明即时自动蒸馏。

## 待 Lead 意见

非阻塞问题 `b3c5f047-e608-4d40-8bef-0e8dd2b1dabb`：报告 B1 范围收缩、可信身份及双 RED 口径；继续独立研究。
