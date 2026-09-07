# FLY-2396 founder 门 exact head 与作者事实 — 实施证据
Issue: FLY-2396 (https://linear.app/geoforge3d/issue/FLY-2396/2309b2-founder-门判决绑-exact-head-新增是否-founder-本人字段authority-是权限不是作者p0)
日期: 2026-09-06
基于: plan.md

## 1. 实施结果

- 新增 append-only `workflow_founder_gate_verdict`：每条新判决都强制保存非空、格式合法的
  `(repo_slug, pr_number, head_sha)`；`UPDATE` / `DELETE` 触发器、外键、CHECK、索引与迁移 receipt
  在同一事务安装。
- exact-PR `land` approve、普通 feedback、carryover，以及可解析 exact binding 的 operator rework，均在原状态迁移事务内同步写 verdict；
  founder-message 引用无法唯一解析 holder / ship target / PR 时 fail closed，不产生半条 rework 或 supersede。
  无 founder-message 引用的 operator 路径只在 exact binding 已存在时机会式记账；旧的非 land / 无 PR recovery 继续执行且不产生 verdict，
  因而既保留原授权合同，也保证所有新 verdict 100% 绑定 exact head。
- `founder_authored` 与 `authority` 完全分离。新 operator 输入只接受经 Bridge 核实的 Discord message URL
  或 `(channel_id, message_id)`；不提供引用记 `0`，引用经 canonical founder、thread、时序核验后记 `1`。
  系统从不读取、匹配或正则猜测 `founder_feedback_verbatim`。
- operator replay receipt 已版本化；稳定 digest 不含 `verified_at`。旧 receipt 无引用可重放，附引用则冲突，且两者都不产生新 mutation。
- 新表进入 FLY-2006 retention registry；只新增事实，不被 merge / ship / auto-allow 读取。

## 2. TDD 与聚焦验证

所有行为先写 RED、确认预期失败，再做最小实现并回归 GREEN。最终已通过：

- `pnpm -F flywheel-teamlead typecheck`；
- 12 个直接改动 suite 共 217 tests；
- `StateStore.workflow-rework.test.ts` 全文件 59/59；
- `StateStore.workflow-engine-transition.test.ts` 76/76；
- `workflow-engine-dispatcher.test.ts` 95/95；
- `StateStore.engine-invariant.test.ts` 8/8；
- founder-message route 21/21、Discord helper 18/18、write-gate-response 35/35、projector 15/15、
  retro report 13/13、founder verdict 16/16；
- retro deployed fixture 同时包含两条未记账与两条已记账判决；汇总只保留前者的
  `2 = 1 approval + 1 rework`。mutation proof 分别破坏两个 `NOT EXISTS` 关联时，测试会报成
  `3 = 1+2` 与 `3 = 2+1` 并按预期失败；恢复真实关联后 13/13 全绿；
- 首轮 code review 指出的三组兼容性回归文件已从 12 fail 修到 25/25 全绿：
  `StateStore.workflow-source-projector.test.ts`、`workflow-engine-runner-ship-probe.test.ts`、
  `fly-1648-hot-loop-closeout.test.ts`。

本单没有新增 `scripts/__tests__/*.test.sh`。

## 3. 只读生产副本证据

执行：

```bash
node scripts/fly2396-retro-report.mjs \
  --db ~/.flywheel/teamlead.db \
  --pre-deploy-cutoff 2026-09-06T20:00:00.000Z
```

runner 使用 SQLite `.backup` 取得 WAL-safe 快照，在同一个只读 sqlite session 内执行 `quick_check`、
外键基线核验、TEMP 人工 attestation 与 `retro-bind.sql`。2026-09-06 实测输出：

```text
PRE-DEPLOY EVIDENCE
FOREIGN KEY BASELINE: 7 FLY-2006 registered / 0 outside baseline
repro_gate_execution_null: 427 / 427
repro_rework_join_execution: 0
rework_spec55: total 55 / bound head 54 / bound (repo, pr, head) 53
rework_legacy_all: total 63 / bound head 62 / bound (repo, pr, head) 61
founder_verdict_unrecorded_post_cutoff: total 3 / approvals 3 / reworks 0
founder_authored_legacy: total 63 / attested 5 / undetermined 58 / guessed 0
controls: c8f001a6=1, 3f9f9f1c=1, 5ae599c6=0, 54f0d683=0, f5bd6f2b=0
```

其中 `founder_verdict_unrecorded_post_cutoff` 无论是否为零都会显式输出，并附带
`missing exact-head ledger = unknown` 原因。当前三条逐项 identity 为 approval claim
`892`、`894`、`897`；它们处于实现尚未部署的 pre-deploy 观测区间，报告不会把缺行静默解释成“没有问题”或作者否定。

两条无法完整绑定的遗留事实也被逐条报出：`f9529033` 的历史 head 是 64 字符，不满足 Git SHA-1；
`bbaf0439` 有 head、但没有 PR 绑定（repo 为 `xrliannie/flywheel`）。这不会被伪造或补猜。

规格冻结复现值仍是 **358/358 与 0**；设计取样时数据库已增长到 421/421，早期实施验收为
424/424，最终只读复跑增长到 **427/427 与 0**。SQL 使用同一语义复现增长后的全集，并同时保留规格冻结值，
未把 live drift 冒充规格变化。

## 4. FLY-2006 基线裁定

首次在 live WAL-safe 副本运行 `PRAGMA foreign_key_check` 时发现七条既存、同形的 FLY-2006 mailbox
archive FK 违规。实施节点通过 question gate 上报后，Lead 裁定：这七条是已知生产基线，不改生产数据；
runner 必须精确接受这七条，任意新增、删除或内容变化都 fail closed，并报告
`7 FLY-2006 registered / 0 outside baseline`。当前实现与实测符合该裁定。

## 5. 全仓门结果

- `pnpm lint`：exit 0；仅打印既存、非本单 warning。
- `pnpm -r build`：exit 0。
- `pnpm test:packages:run`：精确命令已多轮执行。产品相关 suite 全绿；非零项只来自未改动的 legacy
  fixture / wall-clock 测试在当前 resident host 负载下失败，而且失败会在不同轮次漂移。修复后的第一轮在
  `runner-config-writer.test.ts` 创建临时 symlink 时遇到残留路径 `EEXIST`，隔离复跑 21/21；第二轮该包
  772/772 全绿并继续执行到 `flywheel-comm`，随后 `cli.test.ts` 的 runner-stopped 用例超过固定 5 秒，
  隔离复跑为 54/54（目标用例 424ms）。更早各轮还见过 FLY-1981 / FLY-1455 repository scanners、
  FLY-1686 real-Git fixture，以及 Vitest 单 worker 完成 45/45 files、1086/1086 assertions 后的
  `onTaskUpdate` RPC timeout；这些对应用例隔离复跑也全部通过。没有修改测试阈值、断言或生产代码来掩盖宿主机抖动。

## 6. 锁定边界

- 未修改 merge 授权合同；新字段没有放行读者，G14 source sweep 通过。
- 未从反馈文本推断作者；遗留 63 条只有五条人工 attestation，其余 58 条保持 NULL。
- 未补写或清洗既存生产行；回溯脚本只读并 fail closed。
- 回溯 SQL 的 rework 臂明确只覆盖 `source_node_id = 'founder_gate'`。只读线上实测
  `workflow_gate_holder` 为 `founder_gate|409`，bundled registry 的全部当前 graph 也都使用
  `founder_gate`；自定义命名 approval gate 不在该臂覆盖内，不能把本报告外推成对它们的全集证明。
- 未触碰 `CLAUDE.md`，未新增 secret、daemon、timer 或部署动作。

## 7. Code review 修复轮

首轮 review 在 exact HEAD `092e24a80989bcb1918eba5a3e08d471412363f5` 上判定
`CHANGES_REQUESTED`：审批写账被无条件应用到既有 `runner_ship`、`engine_terminal` 与非 engine 路径，
导致 12 个确定性兼容回归。修复后仅 exact-PR `land` holder 强制写 approval verdict；其余路径沿用既有行为且无 ledger row。
同轮 advisory 也已落实：operator no-reference 改为机会式写账、gate node 从 pinned manifest 推导、最终 run CAS 使用 typed
sentinel 回滚整笔事务、GitHub slug 比较忽略大小写、replay 按 `source_event_id` 直接查询。所有修复都由上述 RED→GREEN
回归测试覆盖。R2 在 exact implementation head `a2fafc9602b91d84cbe80e7c9775a16ea10ccc12` 返回 `APPROVED`；
Lead 随后把“post-cutoff 非 land / 遗留路径缺行不可见”提升为本轮必修。报告现增加始终打印的 `unrecorded` 汇总与逐项明细，
测试覆盖零桶及 `2 = 1 approval + 1 rework` 的非零桶。R3 在 exact head
`c038a7d69d3d4d1ac335af745d5b34a7e540d848` 返回 `APPROVED` 后，Lead 要求把 reviewer 的 recorded-row
负向对照 advisory 同样纳入本轮；两个分支各有一条已记账排除样本及上述 mutation proof。其余 feedback 对称性与 land 后
message 引用仍按 Lead 裁定留作 follow-up。
