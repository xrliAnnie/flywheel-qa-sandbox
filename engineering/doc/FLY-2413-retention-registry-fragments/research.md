# FLY-2413 并行追加保留分类 — 调研
Issue: FLY-2413 (https://linear.app/geoforge3d/issue/FLY-2413/fly-2006-retention-registry-是并发热点任何加表的单都要改同一个测试文件同批-pr-必然互撞)
日期: 2026-09-14
基于: exploration.md

## 结论

采用按表拆分的声明式分类，保留独立 schema 观测和现有 fail-closed 检查。此次拆分必须联动维护脚本的摘要闭包与精确路径守卫，不能当作纯测试整理。

## 当前证据与消费者

基线 `579c79ed6`，检查日期 2026-09-14。

| 源码 | 已核对的事实 | 设计影响 |
|---|---|---|
| `scripts/lib/fly-2006-retention-registry.mjs:7` | 两库手写分类，冻结对象/数组；teamlead 228、comm 29 是当前快照 | 迁移逐 identity/classification 比较，数目仅一次迁移证据，不是永久断言 |
| 同文件 `:119` | overlap/unknown database 拒绝；strict API 忽略 retiredOptional 缺失 | 保留 API 和错误前缀；不允许最后写入覆盖 |
| `packages/teamlead/src/__tests__/fly-2006-database-retention-sweep.test.ts:346` | StateStore / MailboxQueue 临时建库后读取 sqlite_master，只检查实际表是已分类子集 | 该独立观测继续保留；不要谎称它证明完整生产 schema 相等 |
| 同文件 `:520` | 分类数量、追加具体 feature 名、全局 JSON fixture 同时更新 | 删除全局数量/当前总列表依赖；业务特有保护断言搬回独立 feature 测试 |
| `scripts/__tests__/fixtures/fly-2006-teamlead-production-tables.json` | 单一生产表名镜像，被上面测试读取 | 去掉该 fixture；不生成替代的提交内总清单 |
| `packages/teamlead/src/StateStore.ts:32632` | codex_quota_canonical_observation 在业务路径延迟创建 | 初始化观测不是所有生产表；保留 quota 专属保护测试，不为凑相等把表标成 retiredOptional |
| `scripts/lib/fly-2006-retention-engine.mjs:394` | engineSourceDigest 手列五个源文件 | 加入完整片段闭包及加载器源，保留其余既有依赖 |
| 同文件 `:411` | activation registrySha256 仅散列 registry.mjs | 拆分后该字段必须覆盖加载器及片段；旧凭证不可自动补签 |
| `scripts/lib/fly-2139-standing-policy.mjs:32` | standing policy 的 deleteTargets 从分类导出 | 保持结构；另外证明删除分类与 RETENTION_TARGET_POLICIES 键精确匹配 |
| `packages/teamlead/src/__tests__/fly2139-standing-policy.test.ts` | standing receipt、cap、janitor negative controls | 增加片段变更导致旧凭证及旧 manifest 拒绝的真实链路测试 |
| `packages/teamlead/src/__tests__/fly2396-authorship-boundary.test.ts:11` | 精确六个源文件允许命中；扫描不含 JSON | 替换 registry 路径为表片段，并让受控片段被扫描；不放宽为目录通配 |
| `packages/teamlead/src/__tests__/fly2398-narrow-boundary.test.ts:11` | 同类影子事实精确路径检测 | 从一个 registry 引用换成两张表的 exact JSON 路径 |
| `scripts/fly1645-receipt-residue-gate.config.json:42,116` | 两条规则固定 registry 行文本 | 分别换成 receipt_root_lineage / receipt_handle_requests 单文件 exact table 字段，匹配数不扩大 |
| `scripts/__tests__/fly1674-residue.test.sh:34` | registry 和旧 fixture 的 three_stage_turn 精确例外必须仍存在 | 替换为两个数据库的三阶段历史表 JSON 路径，移除旧例外 |

## 流程和持久化

片段是提交内策略数据；StateStore/MailboxQueue 是 schema 观测来源。清理入口 inventory 调用 schema guard，产生含 engine 摘要的 manifest；apply 验证摘要后再打开数据库。定期 janitor 另需 activation receipt 与当前 requirements 完全相符。后两者是不同证据通道，必须分别受片段变更影响。

JSON 目录发现不新增中心 import 表。固定两个数据库目录，排序后读取普通文件；拒绝符号链接、路径/身份不符、额外字段、无效分类、重复 identity、空数据库目录。缺任何目录报错，不能默默返回空分类。新文件不需要改 CI 路径枚举，因为新通用测试放进已发现的 teamlead Vitest 套件。

## 独立观测与缺表覆盖

真实初始化检查沿用单向 unknown guard，已知原因是历史/延迟建表。完整 missing 语义由 strict API 的固定微型 fixture 独立验证，并继续在真实 inventory 入口执行。不能用片段自身提供的全集喂 strict API 后声称获得独立 schema 覆盖。对 optional-retired，固定例子允许缺失且出现时仍分类；新增表不默认 optional。

不新增 AST/正则 DDL 扫描器；它会把 DROP 后的历史 CREATE、临时 `_next` 表和未执行分支混为实际 schema。未来全面迁移 inventory 是独立后续工作。

## 可复用模式与技术来源

仓库 milestones README 已采用“一事一文件”避免集中追加热点；此处采用同样的独立路径原理，但身份按数据库表而非 issue。JSON 由文件系统同步加载，使用模块相对路径，无网络、无运行时代码注入。

SQLite 官方说明 schema table 记录 tables/indexes/triggers/views，`sqlite_master` 是兼容别名。因此继续查询 `type='table'` 的实际系统目录：[SQLite Schema Table](https://www.sqlite.org/schematab.html)。

Node 官方提供 readdirSync 的 Dirent 及 lstat/readFile 能力，适合小型固定目录的确定性加载；不依赖新 glob API：[Node fs](https://nodejs.org/api/fs.html)。目录排序是本设计自己规定的确定性合同。

## 验证状态

初次 focused test 命令失败：checkout 没安装依赖，`vitest: command not found`；这不是测试通过。已安装本 checkout 的限定依赖；第二次收集仍因本 checkout 缺少 `packages/teamlead/dist/bridge/release-readiness/evaluate.js` 失败，Tests no tests。必要 workspace 包构建完成，随后限定 rebuild better-sqlite3 成功。最终 focused 测试为 2 passed / 29 skipped：真实临时建库覆盖检查与旧静态全集检查均通过。设计阶段不会把隔离测试结果称为生产验证。

## 计划要求

覆盖无冲突并集、unknown/missing/overlap 的正反两面、关闭守卫后负向测试本身红、片段 digest 变更、旧凭证/manifest 在写库前拒绝、现有 guard 精确例外迁移。HTML 需本地 Mermaid SVG、每卡评论、路径隔离的保存与复制回退；最终按显式 approved review receipt 后静默发布。

## 摘要专项复核

独立只读研究确认：engine inventory `:1120` 存 engine digest，apply `:1600` 在 `:1613` 打开可写库之前校验；`:1589` 已完成回执先返回，必须保留。janitor `scripts/flywheel-log-janitor.sh:2351` 缺凭证走 inventory-only，非法凭证失败。既有 `engineering/doc/FLY-2139-periodic-cleanup-index-audit/operations.md:27` 已规定 registry/engine 变化后重激活。本设计沿用这一失效语义，不代运维执行。

限定静态运行核对 `RETENTION_TARGET_POLICIES` 与两库 deleteTarget 集合：teamlead 21、comm 7，双向差集均为空，支撑计划中的集合合同。
