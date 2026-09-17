# FLY-2632 批准绑内容 — 探索
Issue: FLY-2632 (https://linear.app/geoforge3d/issue/FLY-2632/land批准绑内容-founder-按卡后引擎自动-rebase-到最新-mainci复审通过且非冲突-hunk-逐字不变即沿用原批准直接)
日期: 2026-09-16
基于: 无

## 目标与已定方向
Founder 2026-09-16 16:34Z 已选 A：按一次卡后，并行准备多个 PR；只有最后写入 main 串行。批准归属 founder，内容可证明没越出允许的冲突解决范围时，不重开卡、不二次批准。
本节点只交付设计、独立审核、静默发布 HTML；不实现、不派继任者、不请求 ship。

## 验收问题
1. 冻结批准时相对 merge-base 的文件集与逐 hunk 字节指纹，不忽略空白。
2. 引擎先尝试自动对齐 main；不能自动合的冲突才交给只负责冲突的返工体。
3. 新头 CI 全绿、独立复审 APPROVED、非冲突 hunk 不变、原 founder 批准同 issue 且未撤回，才沿用批准。
4. QA 可沿用需内容证明；非测试冲突变化则新头 QA PASS 后继续，不能无证据跳过。
5. 多 PR 对齐、CI、复审并发，最终 main 写入串行；每次合入主动重查其它候选。
6. 达 engine_land_rework_cycle_limit 要可读、可靠投递的 Lead escalation。
7. 三种事故/反例形状、七组回归及隔离三 PR 重放必须有证据。

## 当前观察与纠偏
- 基线 b2f0c3e61。工作区开始时干净，本 issue 尚无文档。
- StateStore.openEngineLandConflictRework 的 already_open 查询 WHERE run_id；保留这一重复返工保护，不能粗暴删锁。
- StateStore.claimLandOperation 同时获得 project/__main__ admission；executor 在所有检查前取得它，这是需要缩短的串行区。
- plugin land tick 已 Promise.all，不能把加 Promise.all 当成本任务并发实现。
- 已有 clean_base_merge_tree_identity 与 carryover receipt，应扩展既有权威链，而不是建立平行的 approval 字段。
- 当前冲突返工会撤销下游 claim、废弃 gate/ship target 并回 implement；本单需要冲突专用准备路径，保留原 founder 根记录，失败再回旧路径。
- 事故次数/40 分钟来自本任务提供的记录，本节点尚未独立查询生产 DB 或重放，不宣称生产根因全部证实。

## 选择
采用受控 merge 最新 main（用户允许 rebase/merge）保持分支 fast-forward，不引入自动 force-push；体验称“自动同步主线”。内容证明处理文本冲突并严格保留所有非冲突区；不把整份冲突文件列为例外。独立复审与必要 QA 是冲突解决的质量闸。
拒绝：SHA 相等才有效（导致重按）；仅 patch-id（默认忽略空白）；仅文件级 conflict allowlist（能夹带修改）；全程仓库锁（把准备串行）；凭 Lead/Runner 声明铸造批准。

## 边界
不拆 plugin.ts、不改首次 founder 权限、不绕过旧流程。缺证据、文件集变化、非冲突改动、非 founder 根、未知结构冲突都走现有重新立卡流程。网络暂时失败是可重试等待，不反复向 founder 发卡。
