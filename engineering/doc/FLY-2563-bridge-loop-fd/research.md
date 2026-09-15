# FLY-2563 Bridge 响应与连接寿命 — 调研
Issue: FLY-2563 (https://linear.app/geoforge3d/issue/FLY-2563/bridge-ship-judgment-modetick-每-3s-同步跑)
日期: 2026-09-14
基于: exploration.md

## 1. 输入游标与身份合同

StateStore.ts 的 session_events 为 `id INTEGER PRIMARY KEY AUTOINCREMENT`。closeout 时间格式含 SQLite datetime 与 ISO 字符串；不能以字面比较替代既有 julianday 的时间等价。closeout 原事件载有 rootKey/disposition，但不是一个可信的 run_id；必须保留项目、issue/alias、原 run/card 创建时间及 Linear observation 验证。

workflow_founder_gate_verdict 为 `verdict_id TEXT PRIMARY KEY`，source_event_id UNIQUE，原记录不可更新/删除，有 run/question 外键。它没有可依赖的公开递增序号。选 `(recorded_at, verdict_id)` 作为稳定排序水位，另用插入触发器把晚到且排序位置已被水位越过的历史时间行放入**精确身份待办**，避免倒填时间永久遗漏。不能用隐藏 rowid 作为新合同（VACUUM 可重排未绑定 INTEGER PRIMARY KEY 的 rowid）。

已有 outcome 身份必须保持：B2 为 `canonicalDigest(['b2',verdict_id])`；取消为 `source_id='<event id>:<question id>'` 及 `canonicalDigest(['closeout',source_id])`。`source_kind,source_id` 已唯一。新进度表仅记录处理位置，不重复储存审批判断，也不成为授权来源。

clarifications.sweep 已有 learning_cursor + outcome rowid，50 条页在同一事务提交；本单减少并计时每页，不能错误宣称此处也没有水位。它的既有 rowid 技术债不扩展到新源游标。

## 2. 为什么候选页必须先落地

SQLite 可重排 JOIN；外层 LIMIT 50 不约束此前的 JSON、关联和排序。选择两次独立 prepared statements：先索引取得≤32个 source id，再逐 id 验证；不依靠一个可被 planner flatten 的普通 CTE 达成边界。

新取消索引采用与已部署索引相同的 JSON 安全谓词，键顺序改成 `(project_name,source,id)` 支持向前查页。迁移采用新名字并保留可能存在的应急索引，不在启动时先 DROP 旧索引。索引存在不等于定义正确；检验 sqlite_master/index_info 和 EXPLAIN（无 holder 起始扫描、无全量排序）。建索引为一次迁移开销，不计入常态观察函数；必须另记迁移时间和失败行为。

SQLite 官方说明索引表达式匹配依赖同形表达式，部分索引需要查询谓词能推出索引谓词。来源：[partial indexes](https://www.sqlite.org/partialindex.html)、[expression indexes](https://www.sqlite.org/expridx.html)、[INDEXED BY](https://www.sqlite.org/lang_indexedby.html)。本设计推论：固定 SQL 标识和页获取测试比单看“新增索引”可靠。

## 3. CommDB 生命周期

`new CommDB(path,false)` 的 false 仅是不创建缺失文件；它仍可迁移和 purge，不代表只读。只读短查询用 `CommDB.openReadonly`，并在 finally 关闭。constructor 已在错误路径 closeAfterOpenFailure；不要重写成吞掉 generation/migration 错误。

保留所有 mailbox/receipt 幂等身份。顺序应为：短同步读取→close→网络→重新 open 并重新证明 authority→短事务写入→close。不要拿跨 await 的陈旧授权快照直接写。确有 lease 的下游采用现有 `commDbLeaseFactory {db,release}` 合同；借用方不得关闭他人拥有的实例，所有权不能靠路径猜。

已检查 event-route 的各独立 db 块、founder-routing-response-route 的 finally、gate-poller 的 ensureCommDbMigrated/getPendingQuestions、founder-reply-deliverer 的 lease factory。两处裸 new 已确认，其他 104 个文本入口须在实现台账中归类为同步短作用域、显式租借或常驻。每类必须有异常/挂起的计数证据；不能只靠 GC 或无限连接池。

## 4. fd 与健康状态

wrapper/plist 目前都未声明 fd 软限。选择 wrapper 提升**软限**，不降低更高既有上限、不修改硬限；失败必须明确记录实际值。`ulimit -Sn 8192` 在启动新进程前生效，无法修复已运行进程。

Node 的 diagnostic report 含 userLimits；本机 Node v25.6.1 的受限测试进程实际返回 `open_files:{soft:1048575,hard:'unlimited'}`，证明可取数，**不是 Bridge 上限**。只取该字段，不输出 report 中环境变量/路径等内容。启动时读取并缓存；health 不运行 report/lsof，也不 spawn。来源：[Node diagnostic report](https://nodejs.org/api/report.html)。

Darwin 以异步 `execFile('/usr/sbin/lsof',['-nP','-a','-p',String(pid),'-F','f'])` 得数字 fd；去重并排除 cwd/txt/mem 等非 fd，失败/超时写 unavailable，不能变 0。Linux 异步读取 `/proc/self/fd`。每 30 秒采样一次，single-flight，超时 2 秒，输出≤1MiB；关闭退出。上限/采样未知时使用 null 与原因。

现有 EventLoopAttribution 已用 monitorEventLoopDelay，单位转换纳秒→毫秒，30秒窗口，与 profiler 开关分离；复用它，增加窗口时间、采样状态与 lag_ms（最近完整窗口 max_ms 的别名）。来源：[Node perf_hooks](https://nodejs.org/api/perf_hooks.html)。health 既有字段保持兼容，不新增同步系统探测。

## 5. 同步 SQL 的完整覆盖

仅包 modeTick 开头计时会漏掉 await 后的同步段。`withSyncOpMarker` 目前只写/清定位标记，不计时。设计采用两层：marker 加 >250ms 警告；StateStore/CommDB 实例入口加统一 SQL 执行计时，涵盖 raw.prepare 后 all/get/run、exec、pragma、transaction 的锁等待、iterator.next/return；所有 timer 间接调用也覆盖。

新共享计时器放 flywheel-config，以结构类型接入，不引入 better-sqlite3 运行依赖、不改全局 prototype。记录稳定 sqlId（SQL 模板摘要）、方法、db 类别、durationMs、可选静态 operation 标签；不记录参数、payload、文件绝对路径。观察者日志失败不能改变原事务返回/抛错。安装入口包括 StateStore.openDatabase/恢复新连接，CommDB writable/readonly/maintenance 打开；下游 raw 连接与 statement 仍指向同一实例。`timer-sites.txt` 是覆盖核对输入，不是“已全部计时”的证据。

## 6. 归档的二级风险

当前 session/workflow/lead 三表资格过滤都位于 LIMIT 前。改为稳定时间/身份 keyset 获取候选元数据（≤64），再做原有资格、活动引用与 JSON 检查。检查按候选执行，未知/超大 payload 保留热行并记录 skip。每页≤25ms、每次≤50ms/2页；预算只能在同步操作之间协作生效，不能中断单条 SQLite，因此还要限制单条 SQL 的候选量与 payload 字节。

跳过的活跃行未来可能合格；不能永远跳过。持久化的是**已检查位置**，一轮到达冻结 cutoff 之后开启下一轮重查旧跳过行；重启续当前轮，不每次归零。cold insert+热行 delete+cursor advance 同事务；冲突不删源、不推进。closeout 未被观察或有 pending source 时不归档，避免模式 off/大积压时先移走证据。

## 7. 验证方法的可信度

设计阶段完成源码核对、只读 SQL 计划与旧查询测量。未写生产实现、未安装迁移，不能宣称 <50ms、CI 绿或 fd 泄漏已修。实现阶段需补齐 synthetic 非空/稀疏/重放 fixture、数据库锁争用、网络挂起和所有新处理边界；QA 再做指定备份副本及真实部署的时间窗口证明。
