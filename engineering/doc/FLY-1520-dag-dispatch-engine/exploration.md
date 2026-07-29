# FLY-1520 DAG 派发引擎 — 探索
Issue: FLY-1520 (https://linear.app/geoforge3d/issue/FLY-1520/v2上线批次-dag-派发引擎-派发器只认-dag-节点完成合同运行时-generic-ship-执行器-三层模型1498-设计的实现)
日期: 2026-07-28
基于: 无(上游为 FLY-1498 已批设计,见下)

## 1. 一句话

给 v2 装上心脏:实现 FLY-1498 已批设计中的 DAG 派发引擎——派发器只认 DAG 拓扑、
节点自带完成合同(运行时)、generic ship 执行器(三条通用前置)、三层模型
(task→attempt→session)。设计方向锁死,本单只做「已批设计 → 已合代码」的映射细分。

## 2. 设计权威(不重开)

- `doc/engineer/plan/v2/design-chain/fly-1498-gates-dispatch.md`(详设,463 行)
- `doc/engineer/plan/v2/design-FINAL-v2.md` §0 前提条款 / §1.4-1.7 / §2.5 / §2.12
- `engineering/doc/FLY-1498-gate-dispatch-model/v2-final-approved-extract.md`(founder 裁定摘录)
- FLY-1500 修正案映射(agent-first actions 黑匣子):
  `engineering/doc/FLY-1500-dispatcher-outbox-probes/mapping-v2final.md`

## 3. 代码审计(2026-07-28,本分支 = main 9455a2b8)

### 3.1 已有(可直接消费)

| 部件 | 来源 | 现状 |
|---|---|---|
| flywheel-v2.db 17 表 + kernel 单写路径 | FLY-1497 (`packages/v2-kernel`) | `Kernel.write` BEGIN IMMEDIATE 同步事务 façade + CAS + fence;迁移 0001..0007 |
| tasks / task_dependencies / attempts | 0001 | attempts 有 `UNIQUE(task_id,generation)` + 每 task 至多一 active attempt 的 partial unique + terminal_reason |
| activations / processing_attempts | 0003 | attempt↔session 绑定 + 双 partial unique(attempt/session 各至多一 active) |
| agents(generation + last_poll_at 心跳列) | 0005 (FLY-1499) | generation 单调不回退 trigger;heartbeat 列即设计说的「FLY-1499 建列,调度读取」 |
| mailbox + 消费循环 + 注入垫片 | FLY-1499 (`packages/v2-engine`) | enqueue/poll/settle;`registerAgentTx` 要求 runner 的 activation **先存在且 active** |
| actions 黑匣子 | 0006 (FLY-1500) + `packages/v2-actions` | `intended→succeeded/failed`;logical_key 一根 + supersedes 链;`runRecordedAction` 带 `prepare(tx)` 钩子(intent 事务内可注入校验) |
| capabilities 表 + `FENCE.capabilityConsume` | 0001 + FLY-1500 保留 | 占位注释明确写「留给 FLY-1498 批次接手,第一个 call site 归接手方」 |
| v2-scheduler(看库→拉进程宿主) | FLY-1501 | 目前只有 stale-Lead heartbeat 修复循环;launchd kickstart + 内存水位 + restart gate |

### 3.2 零实现(实证,非推断)

grep 全 packages(排除 tests/migrations):

- `task_dependencies` 消费者:**0 个**;
- `gates` 读写者:**0 个**;
- `capabilities` 消费者:仅 FENCE 占位 SQL(无 call site);
- `span_tip` / `writer_chain` / `canonical_worktree`:**0 命中**。

唯一接近 DAG 的现存代码:v2-engine settlement 的 `Effect kind:"task"` 只会 INSERT
单个 task 行(旧形状,带 lineageRootId),不建边、不派发、不完成。issue 的审计结论
成立:**表已建,引擎零实现**。

### 3.3 同批边界(FLY-1518,并行施工)

FLY-1518 改 `packages/v2-engine` 的 command-effect 路径(sql.ts insertCommand /
poll-loop-v2 / settlement-v2 → actions 语义),并新增迁移 DROP
commands/command_dependencies/obligations。**本单不碰这些文件、不加迁移**。
本单对 v2-engine 的依赖限于包级 import(enqueue/registerAgentTx/类型),这些面
不在 1518 改动范围(mailbox 面保留)。FLY-1521(events 归档)已移出上线批次。

## 4. 核心设计问题(映射圈,方向不动)

### Q1 schema 差距怎么落地 —— 已报 Lead 裁定

已批设计(design-chain §8)要求 schema owner 前向迁移:tasks 重建(新增
`contract_json`/`writes_repo`,删 rework_of/lineage_root_id)、gates 重建为
issue-scoped、thread_bindings 重建、create actions + drop obligations,「四项同一
PR 原子交付」。现实:actions 已由 1500 单独交付、obligations drop 已归 1518——
「四项一 PR」的字面已被批次拆分先例取代;剩下 tasks/gates/thread_bindings 三项
无主,而本单铁律是「不加新迁移,需要 schema 变更先报 Lead」。

两条路线(均保 1498 语义,差别在结构落点):

- **路线 A(推荐)零迁移映射**:
  - `contract_json`/`writes_repo` 承载于 `tasks.payload` canonical JSON
    (admission API 是唯一写入口,fail-closed:缺失/非法即拒,绝不按 kind/节点名猜;
    读侧同样 fail-closed——payload 解析不出合法合同的 task 拒绝派发/完成并发 typed event);
  - issue-scoped current gate 的唯一性承载于 meta 键空间
    (ship_gate:{issue_id} 单键 CAS = 「同 issue 至多一个 open|approved」的结构闸),
    gates 表行保留为审计载体,task_id 列按设计允许的「emitter provenance」用法填写;
  - span_tip/writer_chain/canonical_worktree 本就是 meta 键空间(设计 §1.0 原文);
  - thread_bindings 不在本单验收链上,不动。
  - 代价:NOT NULL/partial-unique 从 DDL 层降到 kernel 单写路径层(admission/gate
    API 是仅有写入口,不变量仍然单点强制);后续可由 1502 或独立 schema 单机械提升为列。
  - 收益:与 1518 并行零迁移冲突;不动 checksum 台账;上线批次风险最小。
- **路线 B schema-owner 迁移**:本单(或并入 1518)交付 tasks/gates/thread_bindings
  重建迁移,DDL 层字面对齐设计 §8。代价:与 1518 的迁移序号/顺序耦合,两单从
  「并行」变「串行」,上线批次拉长;收益:结构不变量在 DDL 层。

### Q2 actions 形状映射(1498 详设 vs 已合 0006)

1498 详设写的 actions 形状(prepared|executing|canceled、action_attempt_no、
gate_id/target_head 列、policy snapshot 列)与已合 0006(FLY-1500 修正案形状:
intended|succeeded|failed、logical_key/effect_key、supersedes 链、actor generation
触发器)不同。本单按**已合形状**映射,不改表:

| 1498 详设概念 | 已合 0006 落点 |
|---|---|
| effect identity github_merge:{repo}:{pr}:{head} | logical_key(一根 partial unique) |
| action_attempt_no 2..N | supersedes 链(actions_one_successor + retry_basis 强制证据) |
| prepared→executing CAS + capability consume | `recordActionIntent` 的 `prepare(tx)` 钩子内:三条谓词校验 + FENCE.capabilityConsume CAS + gate 状态 CAS,同一 intent 事务 |
| executing(在飞窗口) | intended 且无 outcome(诚实的 unknown 窗口) |
| succeeded/failed 结算 | recordActionOutcome(actor generation 触发器保证旧世代不能迟到改写) |
| ActionReconciler 对账 stale executing | 只读 GitHub probe:对 stale intended 的 github_merge,exact merged→由当前世代 agent 落观察性结算;不确定→保持 + 去重告警,不猜失败 |
| gate_id/target_head 列 | action payload(canonical JSON,digest 固化)+ capability subject_digest 双绑定 |

### Q3 派发循环宿主与「拉起 runner」边界

引擎逻辑(eligibility 查询 + 派发事务)与进程操作(spawn tmux/launchd)分离:
新包导出 `dispatchOnce(kernel, ports)` 纯逻辑,ports 注入 spawn 适配器(仿
v2-scheduler 的 LaunchdPort 模式)。生产接线(常驻循环谁调用、间隔、与
v2-scheduler CLI 合体与否)归 FLY-1502 切换单;本单 E2E 直接驱动 dispatchOnce。
派发事务内预建 attempt+activation(session_ref 由派发器预分配,兼容
registerAgentTx 的「activation 先存在」约束),commit 后才 spawn——崩在中间 =
attempt 挂着无进程,由 heartbeat/收割路径按既有设计归因,不留双写窗口。

### Q4 完成合同运行时的 git 观测边界

所有 git 读取(HEAD、merge-base、diff --raw manifest)在事务外;事务内只有
expected value/version/CAS(设计 §1.7 原文)。新包内做 manifest 构造与
test/docs/product 分类(严格按详设 §2.2 的 status/mode/path 白名单,超限拒)。

## 5. 提议的包结构

新包 `packages/v2-dag`(名字最终以 plan 为准),只依赖 flywheel-v2-kernel、
flywheel-v2-engine(包级 import)、flywheel-v2-actions:

- admission:issue→DAG 建图(tasks+edges+合同+canonical worktree+span 锚定)
- dispatch:唯一 eligibility 查询 + 派发事务 + spawn port
- completion:manifest 构造(事务外)+ 完成事务(合同证据+终态+span 推进+gate refresh 同 commit)
- rework:同 task 新 attempt 原子换装(release 先于 acquire)
- gate:maybe_refresh_ship_gate + founder approval(capability mint 点 1)
- ship:generic ship 执行器(三条谓词 + runRecordedAction + GitHub merge expected_sha)
- reconcile:只读 GitHub probe(stale intended 对账 + 有界再武装 = capability mint 点 2)

## 6. 验收映射(issue 验收条 → 设计承接)

| 验收条 | 承接 |
|---|---|
| 纯 PRD 单 ship 畅通零 code review | derived(空/docs-only diff)=无 code review 义务;ship 谓词恒三条 |
| QA 单合同 = verdict | declared verdict + test-only diff 不派生 code review |
| 零按场景特例 | 引擎零 design/implement/qa/template 字面量(静态 grep 验收) |
| 三节点全链 E2E + crash 点重放 | E2E 驱动 admission→dispatch→逐节点完成→approve→ship;每个 kernel 事务边界注入 crash 重放 |

## 7. 风险与边界

- 与 1518 并行:唯一共享面是 v2-engine 包导出与 actions 语义;若 1518 改
  enqueue/registration 导出签名(不在其范围内,但需盯),rebase 时对齐。
- GitHub 世界侧:v2 merge lane 的 required-checks/non-admin 探针是 1502 激活
  Go/No-Go 事项,本单只实现探针可调用的形状,不做激活。
- thread_bindings/告警 3.x 族/events 归档:不在本单。
