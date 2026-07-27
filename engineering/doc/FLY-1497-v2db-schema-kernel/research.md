# FLY-1497 v2 权威库落地(批次1) — 调研

Issue: FLY-1497 (https://linear.app/geoforge3d/issue/FLY-1497/v2批次1-flywheel-v2db-权威库落地-17-表-schema-迁移-kernel-单写路径设计终版-1)
日期: 2026-07-27
基于: exploration.md

## 1. 实证 spike(scratchpad,SQLite 3.51.3 via better-sqlite3 ^12.8.0)

plan 里的每条 DDL 能力主张都先在真库上跑过(spike 脚本九项全绿):

| # | 能力 | 结果 | 对 plan 的影响 |
|---|---|---|---|
| 1 | 触发器 WHEN 子句里用递归 CTE(command_dependencies 禁环) | 环插入被 RAISE(ABORT) 拒 | 禁环可以做成**触发器**(设计 R3-4 要求),不必推给 kernel |
| 2 | EXPLAIN QUERY PLAN 输出形态 | detail = "SEARCH mailbox USING INDEX mailbox_pending_immediate_f (to_agent=?)" | 断言写法:detail 含 "SEARCH" + 目标索引名;反断言 detail 不含 "USE TEMP B-TREE" |
| 3 | detector SQL 的命中形态 | "SEARCH mailbox USING **COVERING** INDEX mailbox_pending_age" | 断言必须接受 "USING INDEX" 与 "USING COVERING INDEX" 两种,否则假红 |
| 4 | pa_one_running 双连接第二行 running | SQLITE_CONSTRAINT_UNIQUE | 并发拒测试判 error code,不判消息文本 |
| 5 | 连接2 在连接1 写事务期间 BEGIN IMMEDIATE | SQLITE_BUSY(timeout 后) | busy_timeout 生效路径可测;双连接交错测试真实可行 |
| 6 | verbose 回调能看到 "BEGIN IMMEDIATE" 语句 | true | 「全部写路径皆 IMMEDIATE」的审计测试有真实抓手(不是 code review 口头断言) |
| 7 | 自引用 FK 行(lineage_root_id=自身 id)在 foreign_keys=ON 下 | 插入成功 | tasks 首任务 lineage_root=自身 的设计可直接落 NOT NULL FK |
| 8 | FK 指向非 PK 的 UNIQUE 列(processing_attempts.message_uid → mailbox.message_uid) | 合法,违规被拒 | v9 DDL 原样可执行 |
| 9 | 事务内改 PRAGMA foreign_keys | **no-op**(仍为 1) | 迁移器必须在**事务外**管理 FK 开关;obligations 表重建按 SQLite 官方 12 步:OFF→事务内重建→foreign_key_check→COMMIT→ON |

## 2. better-sqlite3 API 事实(Context7 + 本机验证)

- 事务模式:`db.transaction(fn).immediate()` 即 BEGIN IMMEDIATE;嵌套调用自动变 savepoint。kernel 写入口用 `.immediate()`,并禁止嵌套写入口(骨架里断言)。
- busy_timeout:构造项 `timeout`(默认 5000ms,映射 sqlite3_busy_timeout);连接工厂统一显式设置(设计 §0.5b「连接工厂统一 PRAGMA busy_timeout」)。
- WAL-safe 备份:`db.backup(dest)` = SQLite Online Backup API,天然含 WAL 内容,返回 Promise;备份后对副本跑 `PRAGMA integrity_check` + 行数核对。
- 同步 API:整库单进程内同步执行,写事务「短」由代码结构保证(写入口回调里禁 I/O/await——回调根本不是 async)。

## 3. 仓库约定(落包方式)

- 包脚手架参照 `packages/token-usage`(最小形态):`package.json`(type: module,tsc build,vitest run)+ `tsconfig.json` + `vitest.config.ts` + `src/` + `src/__tests__/`。
- 依赖:仅 `better-sqlite3 ^12.8.0` + `@types/better-sqlite3`(root onlyBuiltDependencies 已含,零新增原生依赖)。
- lint = biome(根配置,`engineering/doc/**` 已排除);CI 要求全仓 `pnpm lint` + `pnpm -r build` + 测试。
- 库文件默认落点 `~/.flywheel/flywheel-v2.db`(目录 0700、文件 0600,同 v1 设计 §1.1);测试经参数注入临时目录,绝不碰真实路径。

## 4. 设计 → 落地的关键映射结论

1. **迁移链**(brainstorm gate 已批):`0001` 基础 15 表(obligations 取 R5 旧形,target_task_id NOT NULL)→ `0002` obligations 官方步骤表重建(终版形)→ `0003` activations + processing_attempts → `0004` mailbox 七索引家族。旧行保真测试走真实重建路径。
2. **索引口径**(Lead 纠偏后):设计里出现的每个索引都建、都验 = mailbox 7 + activations 2 + pa_one_running = **10 个物理索引**,另有 obligations episode_key partial unique、attempts 单 active partial unique、thread_bindings 单 active partial unique 与各 UNIQUE 隐式索引——全部入「存在性断言」清单,EXPLAIN 断言只针对设计 §1.2f 给了 SQL 原文的五条查询。
3. **SQL 原文出处已入库**:四条候选 SELECT = `doc/engineer/plan/v2/design-chain/design-v10.md` §1.2f;七索引 + activations/processing_attempts DDL = `design-v9.md`;detector = `design-v8.md`。plan 全文引用,实现原样复制。
4. **events append-only 的边界**:UPDATE 用触发器硬禁;DELETE **不能**硬禁(§1.3 归档协议要在 manifest 事务里删热区行)——DELETE 约束留给 kernel 单写纪律,plan 里显式记为诚实边界。
5. **generation fence 谓词族**(批次1 骨架范围):meta 表 lead_registry/consumer_registry 键空间的读取 helper + 「写事务内校验当前世代 + CAS 带 WHERE 谓词 + changes()=预期行数否则整体抛出回滚」的组合子。消费循环怎么用它是批次 2 的事;批次 1 交付谓词族本身 + 用合成写路径测「旧世代整事务被拒零残留」。
6. **synchronous 档位**:设计未钉;权威账本取正确性优先 → 连接工厂默认 `synchronous=FULL`(WAL 下防掉电丢已提交事务),留配置口。plan 里标为落地决策。

## 5. 结论

无未解风险项;全部能力主张已实证。可以进入 plan。
