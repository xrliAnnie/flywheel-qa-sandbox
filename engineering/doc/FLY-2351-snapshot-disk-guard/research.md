# FLY-2351 快照与磁盘护栏 — 调研
Issue: FLY-2351 (https://linear.app/geoforge3d/issue/FLY-2351/运维磁盘-满盘事故-9-5-0130patrol-repairs-库快照无上限127-份55gb-qa-体往-tmp-拷生产库不回收)
日期: 2026-09-08
基于: exploration.md

## 结论

现有代码能提供调度、执行身份与在线备份原语，缺的是统一的副本获取和回收合同。复用 Bridge 已有的 detached maintenance tick，不给只读巡检采集脚本增加删除职责。容量数据同时服务 HTTP 与巡检提示，新增值必须穿过两条投影。

本设计沿用任务明确授权的自主设计/正式 design-review 流程；本机旧 research/write-plan 技能的额外人工确认、旧文件目录与写完整实现代码步骤不适用于此有界 design 节点。采用其代码定位、约束审计、CEO 概览和精确实施任务形状。生命周期研究由只读子任务独立核对，其结果并入计划；不派发实现/QA/reviewer 节点。

## 证据目录（基线 ee113cab9）

| 源 | 已观察事实 | 对计划的约束 |
|---|---|---|
| `packages/teamlead/lead-rules-base/runner-patrol-rules.md:507` | 附录 A 创建 patrol-repairs，直接 sqlite `.backup`，名称固定带 FLY-2080 与 request id | 替换获取入口；修复目标 issue 必须由只读关联查询取得，不能继续用配方编号 |
| 同文件 `:685` | 附录 B 复用该备份配方 | 两个调用说明一起改 |
| `scripts/db-maintenance.sh:8,166` | archive/db-backups 是另一套 stopped-service 恢复合同；临时备份、完整性检查、旋转已存在 | 不把该归档目录混入 patrol 自动清理；共用空间测量可复用，保留期不替换 |
| `scripts/lead-patrol-snapshot.sh:1,1114,1706` | 六步独立事实采集，开头声明只读；STEP 5 gh/Raya 故障单独投影 | 磁盘事实必须独立采样，即使 gh 失败也输出；不在该脚本删除副本 |
| `packages/teamlead/src/bridge/capacity-snapshot.ts:53,204` | schemaVersion=1，null + unavailable 的容量合同 | 新增字段保持 version 1 兼容增量，未知不冒充 0 |
| `packages/teamlead/src/bridge/plugin.ts:1624,1716,10069` | 相同 deps/builder 服务鉴权 API 与巡检 tick | 只有一个磁盘读取源；继续保留 API token 行为 |
| `packages/teamlead/src/bridge/hook-payload.ts:744,943` | 严格校验 capacity 后格式化，失败会整个容量栏降级 | 增加磁盘格式化及边界校验，旧 envelope 没新字段也可读 |
| `packages/teamlead/src/bridge/plugin.ts:8239,8520` | 既有 heartbeat detached single-flight 维护回调，后段受 worktreeAutoclean gate 截断 | 存储维护放在该早退之前，独立异常隔离；不被 worktree 开关误关 |
| `packages/teamlead/src/bridge/close-runner.ts:61,612,891` | success 状态、crash-preserve 与常驻 phase 的关闭语义不同；身份删除需强死亡证据 | 不能只凭 completed 文本或没有 tmux 窗口删目录 |
| `packages/teamlead/src/bridge/lifecycle-closeout.ts:1182` | closeoutOneNode 先转态，再关闭，再确认进程状态，最后清通信记录 | 存储清理用共同 helper；不绕开现有节点状态/死亡守卫 |
| `packages/teamlead/src/bridge/lifecycle-sweep.ts:1` | 现有 sweep 负责工作树/分支、含长期保留与 founder authority | 不借其“目录长得像”规则删数据库；存储根另有严格归属 |
| `packages/flywheel-comm/src/commands/turn.ts:39` 与 `db.ts:7428` | `turn` 及 `resolveRunnerWorkflowActivation` 都依赖共享 worktree TURN | 不能当临时副本准入；R2 改用 StateStore `resolveCurrentWorkflowActivation:35162` 与普通 session fallback，只读 endpoint 共用 resolver，人工分析绑定自己的进程 |

## 副本生成消费者 sweep

扫描时间：2026-09-08；范围为本分支 `scripts/`、`packages/`、`.claude/`，搜索 `.backup`、copyFile/db、cp/teamlead.db、comm.db、patrol-repairs。没有读生产 DB 内容；文件大小来自 lstat。

| 消费者 | 判定/处置 |
|---|---|
| runner 巡检规则附录 A/B | 当前受管修复快照入口，迁移到统一 repair 子命令 |
| `scripts/fly-2006-retention-rehearsal.mjs:76,113` | 接受任意 rehearsal-dir 并拷两库；迁移 runner 模式至受管 exec 根，证据单独输出，finally 释放；数据库还原/压缩产生的衍生文件也计入预算 |
| `scripts/cycle-time/cycle-time-report.mjs:30` 与 `lib/collect.mjs`、`lib/extract.mjs:9` | 生产两库复制到 mkdtemp scratch，入口末尾没有 finally 清理；必须迁移且补 finally |
| `scripts/fly2396-retro-report.mjs:217,303` | 一库在线备份且已有 finally；仍需迁移路径/预算，保留 finally |
| `scripts/r4/snapshot-r4.sh:104` | 停服务的恢复 bundle，包含 comm refs 与 manifest；属于部署/回滚归档，保留原独立合同，不自动删除 |
| `scripts/fly-1648-hot-loop-closeout.mjs`、`fly-1995-session-events-residue-surgery.mjs`、`fly-2165-repair-torn-mailbox-identities.mjs` | 人工修复/显式 backupPath 合同；生产 patrol 用途必须通过统一 repair 获取；独立迁移凭据绑定备份不可悄悄移动/删掉 |
| `packages/flywheel-comm/src/mailbox-migration.ts`、`receipt-teardown-closeout.ts`、`commdb-open-gate.ts` | 迁移预映像/可回滚凭据/临时探针分别有语义；非 runner QA 副本，不按临时目录 glob 接管 |
| 单测 fixture 的 copyFile/cp | 来源是测试自己创建的小库，保留 mkdtemp + finally/afterEach；绝不为本 issue 从生产库复制 fixture |
| `packages/claude-runner/agents/codex-runner-contract.md` 与通用任务 prompt 注入源 | 新规则必须从源写入，覆盖 Claude/Codex implement+QA，不能只改本机 materialized AGENTS |

实施阶段重新运行同族 sweep，尤其检查 `collect.mjs` 的 manifest 路径：证据不能引用 closeout 会删掉的唯一数据库。保存小型计数/校验摘要至 doc/QA evidence，再回收副本。R1 复核明确上述三个分析脚本同时是人工/Lead 入口；R2 的 withOperatorSnapshots 保留无 exec 的原调用，随机 operator 身份不写入 runner 表，finally 和进程死亡扫描回收。

## 本机与上游验证

- 本机 Node `v25.6.1` 的 `fs.statfsSync('/System/Volumes/Data', {bigint:true})` 只读调用成功；2026-09-08 样本 `bavail*bsize = 85,622,145,024 bytes`。这个样本是开发时证据，不是持续健康保证。
- [Node 官方 fs 文档](https://nodejs.org/api/fs.html#statfsbavail)：可用 bytes 是 bavail × bsize。用 BigInt 比较阈值，接口输出 number/decimal string 前做范围校验；不能用 bfree 代替用户可写 avail。
- [SQLite Online Backup API](https://www.sqlite.org/backup.html)：在线备份完成后是一致数据库；直接 cp 活库可能漏掉 WAL（写入先追加的日志）。不把复制三个瞬时文件假装成一致备份。
- [Apple 平台安全：APFS](https://support.apple.com/en-euro/guide/security/seca6147599e/web)：系统与数据分卷，系统从受保护快照启动。运维磁盘检查明确用 Data mount；macOS 上缺少该路径时报 unavailable，不回退 `/`。
- 本机 `sqlite3`、`mmdc` 已存在。HTML 按 Apple-light 样式，Mermaid 在本机渲染为 SVG，托管时零远程依赖。

## 现有测试形状

- `packages/teamlead/src/bridge/__tests__/capacity-snapshot.test.ts`：注入读取函数，mock null/throw/非法值。
- `packages/teamlead/src/__tests__/capacity-route.test.ts`：鉴权、API 与 patrol envelope；不能只测 builder。
- `packages/teamlead/src/__tests__/patrol-tick-render.test.ts`：容量提示 sanitization、旧字段兼容。
- `scripts/__tests__/lead-patrol-snapshot.test.sh`：小型 SQLite fixture、假 gh/Raya、STEP 状态；新增磁盘 probe fixture 不碰宿主盘。
- `packages/teamlead/src/__tests__/fly369-patrol-rule.test.ts`：抽取最终 FINDING gate 执行；追加低盘量必须强制 FINDING 的阴性场景。
- `packages/teamlead/src/__tests__/event-route.test.ts` 与 `bridge/__tests__/lifecycle-closeout.test.ts` 等 lifecycle 族：使用持久事件/节点事实验证，不能只 spy helper 被调用。

## 待核对的决策

Lead 问题 `ec87d39f-aa63-49cb-b098-e96790a1077b` 已答复：同意 2GB 受管获取目录预算、issue/db kind/CommDB project 分组，以及 inventory+显式映射。明确要求映射不上的库一律不删。旧文件没有可靠唯一归属时只列 manual-only；报告未纳入数量和 bytes，不能把它算作已完成清理。
