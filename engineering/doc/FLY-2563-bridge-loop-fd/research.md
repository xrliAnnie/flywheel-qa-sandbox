# FLY-2563 Bridge 响应与连接寿命 — 调研
Issue: FLY-2563 (https://linear.app/geoforge3d/issue/FLY-2563/bridge-ship-judgment-modetick-每-3s-同步跑)
日期: 2026-09-14
基于: exploration.md

## 1. 输入游标与身份合同

StateStore.ts 的 session_events 为 `id INTEGER PRIMARY KEY AUTOINCREMENT`。closeout 时间格式含 SQLite datetime 与 ISO 字符串；不能以字面比较替代既有 julianday 的时间等价。closeout 原事件载有 rootKey/disposition，但不是一个可信的 run_id；必须保留项目、issue/alias、原 run/card 创建时间及 Linear observation 验证。

workflow_founder_gate_verdict为`verdict_id TEXT PRIMARY KEY`，source_event_id UNIQUE，原记录不可更新/删除，有run/question外键。它没有公开递增序号。正常增量用`(recorded_at,verdict_id)`稳定水位；晚到旧时间由每60秒≤16个源身份的持久化轮转核对捕获，已有outcome不再查holder。不得新增会使学习侧失败回滚权威verdict INSERT的trigger。隐藏rowid不用作新合同。

R1后复核：本单指定备份共有725条flywheel canceled closeout，按既有项目/issue/alias关联匹配到run的数量为0。零匹配是正常“不适用”，不是restore丢依赖证据；普通扫描推进水位且无pending/outcome/告警。恢复回放只由显式source身份和成功restore回执安排，不能由观察器猜测。

候选时间比较继续在PK点查SQL内用julianday，并输出UTC毫秒；不能把SQLite `YYYY-MM-DD HH:MM:SS`交给非UTC进程的Date.parse。后者会产生本地时区偏移；用非UTC TZ回归覆盖。

已有 outcome 身份必须保持：B2 为 `canonicalDigest(['b2',verdict_id])`；取消为 `source_id='<event id>:<question id>'` 及 `canonicalDigest(['closeout',source_id])`。`source_kind,source_id` 已唯一。新进度表仅记录处理位置，不重复储存审批判断，也不成为授权来源。

clarifications.sweep 已有 learning_cursor + outcome rowid，50 条页在同一事务提交；本单减少并计时每页，不能错误宣称此处也没有水位。它的既有 rowid 技术债不扩展到新源游标。

## 2. 为什么候选页必须先落地

SQLite 可重排 JOIN；外层 LIMIT 50 不约束此前的 JSON、关联和排序。选择两次独立 prepared statements：先索引取得≤32个 source id，再逐 id 验证；不依靠一个可被 planner flatten 的普通 CTE 达成边界。

新取消索引采用同形JSON安全谓词，键顺序为`(project_name,source,id)`支持向前查页。指定备份实际旧索引为`(project_name,source,issue_id,ts)`，R1后的EXPLAIN验证其用于id页时仍需TEMP B-TREE；不能用仅`(project_name,source)`的假设索引推断现场不需新索引。保留旧索引，启动前预算一次构建成本。该学习侧迁移失败须在StateStore捕获、标记observation unavailable并禁用observer，继续HTTP初始化；归档保守保留closeout，其他权威schema失败保持原行为。

SQLite 官方说明索引表达式匹配依赖同形表达式，部分索引需要查询谓词能推出索引谓词。来源：[partial indexes](https://www.sqlite.org/partialindex.html)、[expression indexes](https://www.sqlite.org/expridx.html)、[INDEXED BY](https://www.sqlite.org/lang_indexedby.html)。本设计推论：固定 SQL 标识和页获取测试比单看“新增索引”可靠。

## 3. CommDB 生命周期

`new CommDB(path,false)` 的 false 仅是不创建缺失文件；它仍可迁移和 purge，不代表只读。只读短查询用 `CommDB.openReadonly`，并在 finally 关闭。constructor 已在错误路径 closeAfterOpenFailure；不要重写成吞掉 generation/migration 错误。

保留所有mailbox/receipt幂等身份。短同步读取→close→网络→重新open并重新证明authority→短写入→close；不能拿旧授权快照写回。已有lease采用`commDbLeaseFactory {db,release}`，不关闭借用实例。两个裸new加finally关闭，notify保留createIfMissing=true；只读zombie对缺失库安静返回空。legacy每Lead常驻owner有界且shutdown关闭，保留它，不改成逐事件反复schema/migration/purge；其数量计入真实fd预算。

已检查 event-route 的各独立 db 块、founder-routing-response-route 的 finally、gate-poller 的 ensureCommDbMigrated/getPendingQuestions、founder-reply-deliverer 的 lease factory。两处裸 new 已确认，其他 104 个文本入口须在实现台账中归类为同步短作用域、显式租借或常驻。每类必须有异常/挂起的计数证据；不能只靠 GC 或无限连接池。

## 4. fd 与健康状态

wrapper/plist目前未声明fd软限。但Node自身会在PlatformInit提升RLIMIT_NOFILE，不能把launchctl的256等同于Bridge进程限制。wrapper保留尽力提升软限到8192，不降低更高值/硬限；失败仅warn继续启动，不能为无效的诊断条件使Bridge重启循环。进程有效limit才是F验收依据。

R1后隔离验证：同一子shell先设`ulimit -Sn 256`再启动Node v25.6.1，report仍为`{soft:1048575,hard:'unlimited'}`；未制造fd耗尽。此前不能把这个值的来源归为沙箱。Node主源码PlatformInit也明确调整resource limit。来源：[Node PlatformInit](https://github.com/nodejs/node/blob/main/src/node.cc)、[Node diagnostic report](https://nodejs.org/api/report.html)。这些证明Node行为，不是对真实Bridge PID的测量。

Darwin进程有效上限还受内核maxfilesperproc约束；取min(进程soft,kernel cap)，而不是仅用report.soft。Apple的[getdtablesize实现](https://github.com/apple/darwin-xnu/blob/main/bsd/kern/kern_descrip.c)体现该限制。reviewer报告宿主机kernel cap184320；本设计sandbox读取sysctl被拒绝，该现场值没有在本节点独立验证，不写成已确认Bridge状态。真实launchd Bridge的soft/cap/errno取证交给授权实施/QA，不能用237fd与256launchctl值确认历史EMFILE因果。ENFILE是系统全局文件名额问题，需独立记录kern.num_files/kern.maxfiles，不能混入进程分母。

本节点验证Node异步readdir('/dev/fd')可用。Darwin以/dev/fd、Linux以/proc/self/fd计数字fd，每30秒single-flight；超时2秒标unknown但直到原任务settle才释放flight。lsof只用于QA按comm.db分类。内核cap异步固定sysctl读取，2秒/64KiB限额，5分钟刷新、10分钟过期；必需cap未知不退回过大soft当作effective。health仅读缓存，不运行report/readdir/sysctl/lsof；不泄露完整report中的环境和路径。

现有 EventLoopAttribution 已用 monitorEventLoopDelay，单位转换纳秒→毫秒，30秒窗口，与 profiler 开关分离；复用它，增加窗口时间、采样状态与 lag_ms（最近完整窗口 max_ms 的别名）。来源：[Node perf_hooks](https://nodejs.org/api/perf_hooks.html)。health 既有字段保持兼容，不新增同步系统探测。

## 5. 同步 SQL 的完整覆盖

仅包 modeTick 开头计时会漏掉 await 后的同步段。`withSyncOpMarker` 目前只写/清定位标记，不计时。设计采用两层：marker 加 >250ms 警告；StateStore/CommDB 实例入口加统一 SQL 执行计时，涵盖 raw.prepare 后 all/get/run、exec、pragma、transaction 的锁等待、iterator.next/return；所有 timer 间接调用也覆盖。

新共享计时器放 flywheel-config，以结构类型接入，不引入 better-sqlite3 运行依赖、不改全局 prototype。记录稳定 sqlId（SQL 模板摘要）、方法、db 类别、durationMs、可选静态 operation 标签；不记录参数、payload、文件绝对路径。观察者日志失败不能改变原事务返回/抛错。安装入口包括 StateStore.openDatabase/恢复新连接，CommDB writable/readonly/maintenance 打开；下游 raw 连接与 statement 仍指向同一实例。`timer-sites.txt` 是覆盖核对输入，不是“已全部计时”的证据。

## 6. 归档的二级风险

当前 session/workflow/lead 三表资格过滤都位于 LIMIT 前。改为稳定时间/身份 keyset 获取候选元数据（≤64），再做原有资格、活动引用与 JSON 检查。检查按候选执行，未知/超大 payload 保留热行并记录 skip。每页≤25ms、每次≤50ms/2页；预算只能在同步操作之间协作生效，不能中断单条 SQLite，因此还要限制单条 SQL 的候选量与 payload 字节。

跳过的活跃行未来可能合格；不能永远跳过。持久化的是**已检查位置**，一轮到达冻结 cutoff 之后开启下一轮重查旧跳过行；重启续当前轮，不每次归零。cold insert+热行 delete+cursor advance 同事务；冲突不删源、不推进。closeout 未被观察或有 pending source 时不归档，避免模式 off/大积压时先移走证据。

## 7. 验证方法的可信度

设计阶段完成源码核对、只读 SQL 计划与旧查询测量。未写生产实现、未安装迁移，不能宣称 <50ms、CI 绿或 fd 泄漏已修。实现阶段需补齐 synthetic 非空/稀疏/重放 fixture、数据库锁争用、网络挂起和所有新处理边界；QA 再做指定备份副本及真实部署的时间窗口证明。
