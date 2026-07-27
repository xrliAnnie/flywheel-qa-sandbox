# FLY-1497 v2 权威库落地(批次1) — 探索

Issue: FLY-1497 (https://linear.app/geoforge3d/issue/FLY-1497/v2批次1-flywheel-v2db-权威库落地-17-表-schema-迁移-kernel-单写路径设计终版-1)
日期: 2026-07-27
基于: 无(上游输入 = `doc/engineer/plan/v2/design-FINAL-v2.md`,Codex R13 APPROVED 设计终版)

## 1. 任务理解

Flywheel v2 全量重建的第一块地基。批次 1 只交付**数据层地基**:

1. **flywheel-v2.db 的 17 张表全量 DDL**(可执行 SQLite,含 CHECK / FK / 触发器),经真实迁移器从零建库;
2. **9 个命名索引**(mailbox 七个 partial + activations 两个),且设计 §1.2f 的四条候选 SELECT + detector SQL **原样**入迁移测试,逐条 `EXPLAIN QUERY PLAN` 断言命中(实现不得改写 SQL);
3. **kernel 单写路径骨架**:唯一写库入口、`BEGIN IMMEDIATE` 写纪律、连接工厂统一 PRAGMA(busy_timeout 等)、CAS 影响行数=1 否则整体回滚的不变量校验、generation fence 谓词族;
4. **迁移与备份合同**:schema_migrations 记账、WAL-safe backup 钩子、全部迁移测试在 `PRAGMA foreign_keys=ON` 下执行。

**不在本单**(批次 2-3):消费循环 / dispatcher / 探针 / 告警 / 注入垫片 / 切换手册执行。本单不接线任何现有生产路径——纯新增包,零行为变化。

本 session 是三段式的 **Design 节点**:只产设计文档(exploration / research / plan / founder HTML),不写实现代码;Implement 节点在同一分支接手。

## 2. Codebase 审计发现

| 发现 | 证据 | 对本单的含义 |
|---|---|---|
| better-sqlite3 ^12.8.0 是仓内既定同步 SQLite 库 | `packages/flywheel-comm`(comm.db)、qa-framework、inbox-mcp、teamlead(claims)、token-usage 均用;root `package.json` onlyBuiltDependencies 已含 | v2 kernel 直接用 better-sqlite3,零新依赖 |
| sql.js(WASM)是病灶路径 | `packages/teamlead/StateStore.ts` + `packages/edge-worker`;FLY-663 已实证 WASM 损坏 | v2 就是要替掉的世界,不碰不学 |
| repo 内**不存在** obligations 表 | 全仓 grep 零命中 | obligations「重建迁移」是 v2 迁移链**内部**的两步(先建 R5 旧形 → 再重建成终版形),不是从生产表迁移 |
| comm.db 有成熟连接/schema 模式 | `flywheel-comm/src/db.ts`(SCHEMA 常量 + 迁移函数) | 风格参照,但 v2 迁移器按设计合同独立实现(带 schema_migrations 记账) |
| 测试栈 = vitest,pnpm monorepo | 各包 `"test": "vitest run"` | 验收测试用 vitest;并发交错测试用双连接 better-sqlite3 |

## 3. 关键输入的定位(SQL 原文)

设计终版(FINAL)是压缩并稿,**不含**精确 SQL 原文;原文分布:

- 七索引家族 + activations DDL + processing_attempts DDL:`design-chain/design-v9.md`(§1.2f / §1.6 / §1.2d)
- 四条候选 SELECT(F1/F2/N1/N2)全文:`design-chain/design-v10.md`(§1.2f)
- detector SQL + 基础表列形:`design-chain/design-v8.md`(§1.2f)、`design-chain/design-v1.md`(§1.1)、`design-chain/design-v2.md`(§1.1)、`design-chain/design-final.md`(R5 基础版,§1.1-1.2)
- mailbox 终版 DDL(无 claimed 态、无租约):`design-chain/design-v6.md`(§1.2)

已全部归档进 `doc/engineer/plan/v2/`(commit e39abe20),/tmp 丢了也不影响后续批次。

## 4. 需要在 plan 定稿的落地决策(带倾向)

1. **包落点**:新包 `packages/v2-kernel`(暂名),不接任何现有包的运行路径。倾向:独立包 + 只被测试引用,批次 2-3 再接线。
2. **迁移链结构**(倾向):`0001` 基础 15 表(obligations 用 R5 旧形:target_task_id NOT NULL)→ `0002` obligations 表重建(nullable + 新列 + 恰一目标 CHECK + episode_key partial unique + depth≤1)→ `0003` activations + processing_attempts → `0004` mailbox 七索引。这样「obligations 迁移五测」里的**旧行保真**是真实的表重建路径,不是摆拍。
3. **9 索引口径**:命名 9 个 = mailbox 7 + activations 2;此外还有约束性 partial unique(pa_one_running、obligations episode_key、attempts 单 active、thread_bindings 单 active)与 UNIQUE 隐式索引——验收断言「9 个命名索引存在且 EXPLAIN 命中」,**不是**「全库恰 9 个索引」。
4. **thread_bindings PK 具体化**:R5 文本"canonical_key PK"与"partial UNIQUE 每 canonical_key 至多一行 active"并存,后者蕴含允许多行(含 archived 历史)。倾向:rowid 表 + `UNIQUE(thread_id)` + partial unique `(lineage_root_id) WHERE state='active'`,忠实实现两条约束语义。
5. **库文件落点**:`~/.flywheel/flywheel-v2.db`(0600,目录 0700),路径可注入(测试用临时目录);连接工厂统一 `journal_mode=WAL` + `busy_timeout` + `foreign_keys=ON`。
6. **触发器清单**(设计要求的全部):tasks 禁 rework_of 自引用;obligations depth 校验(child.depth=parent.depth+1 且 parent.depth=0)+ task 终态 tombstone(只作用 target_kind='task');command_dependencies 禁 self-edge/环;events append-only(禁 UPDATE/DELETE 热区行为由 kernel 纪律 + 触发器兜底,plan 里定)。

## 5. 风险与边界

- **设计已 R13 APPROVED,本 plan 不重开设计**:plan 的职责是把 §1 + §0.5b 展开成可执行 DDL/模块/测试清单,凡设计给了原文的一律原样;凡设计只给要点的(gates/capabilities 等列形),按设计链最近版本忠实展开,展开处在 plan 里逐条标注出处。
- 并发交错测试(pa_one_running 双连接、activations 双 active)必须用**真双连接**跑真 SQLite,不 mock。
- ship 走 founder gate;merge 前 verify-approval(基线规则,不在设计文档里重复)。
