# FLY-2563 Bridge 响应与连接寿命 — 实施记录
Issue: FLY-2563 (https://linear.app/geoforge3d/issue/FLY-2563/bridge-ship-judgment-modetick-每-3s-同步跑)
日期: 2026-09-14
基于: plan.md

## 当前状态

Implement TURN epoch=2，activation attempt=1。工作开始时分支只有已批准设计，工作树干净。
实时 check `8b68f7f7-65a6-44b4-b6aa-319babf09006` 确认 R2 effective APPROVED。
本记录不是完成回执。T1–T7 尚未全部实施，不宣称事件循环事故已修复。

## T3 第一批：fleet 同步连接所有权

- 提取 `insertLeadInstruction`、`readZombieCandidates`；每次打开的连接均在同步 finally 关闭，之后才进入 zombie 异步 liveness probe。
- 通知仍创建尚不存在的库，保留发送者、目标和 dedupe identity；缺失 zombie 库返回空，已存在损坏库继续报错。
- 真实临时 CommDB 测试覆盖100轮通知及两个项目读取、真实 numeric fd 回到基线、重复 receipt、写入冲突、list 抛错、挂起 probe 前释放。
- RED：首次缺模块失败；另将两处 close 临时移除，3/4 tests 因未释放失败，随后恢复修复。未使用 GC。
- GREEN：fleet tests 4/4；与 gate-poller-health、lifecycle-routes 合跑 29/29；teamlead typecheck exit=0。
- 环境：`pnpm install --frozen-lockfile` 成功；修改前 `pnpm -r build` exit=0。安装时缺 dist 的 bin 警告经基线构建解决，未当作行为失败。
- 剩余：104处 ownership 清单全审计、legacy与默认backend lifetime夹具、跨网络 lease 审计。已发现 founder-reply-deliverer 在读取线程后持有 lease 跨 processFounderMessage/reaction await，下一批需验证有界性与authority再验证。

## T2 第一批：独立本地轮次与网络 lane

- modeTick 的本地 latch 在 Promise 回调执行前安装，finally 只清理本次 flight；verdict、cancel、clarification 之间使用 setImmediate yield，每次重新检查 off/stop。
- 网络 sweep 使用独立单飞 Promise 和 AbortController，15秒 deadline 传给底层，超时仍等待实际 settle 后才释放单飞；stop abort 并等待清理。mode=off 仅转换时结算历史。
- clarification 每页最多16条、25ms，cursor 仅推进最后已检查行；预算包含事务锁等待。未触及 authority 写入。
- RED：runtime 4项失败（含旧共用 flight 等待超时、off yield缺失）；clarification 16条上限/25ms游标测试分别失败。
- GREEN：runtime 10、runtime-collect 1、learning 26、fleet 4，合计41/41；teamlead typecheck exit=0。
- 真实 interval 入口验证3秒本地页继续、15秒abort传播、未settle不重叠；另覆盖stop等待清理与无网络依赖latch释放。
- T2仍待T1接入后的真实大库完整modeTick <100ms；目前取消/verdict旧SQL尚未替换，不能声称总耗时达标。SQL与off结算计时待T5。
- T3补充：缺失路径只捕获ENOENT；ENOTDIR/损坏库显式失败。新ENOTDIR用例先红后绿，避免existsSync把路径错误伪装成未初始化。

## 总体验收矩阵

## T1 第一批：迁移与取消源水位

- 新 migration `fly-2563-observation-budget-v1` 原子安装四个源/关联索引、两张cursor/pending表及due索引；保留应急旧索引。同名异定义明确schema_drift；DDL/初始化/receipt失败全回滚。
- StateStore在权威schema安装后单独捕获该学习侧失败，保留存储可用，observer getter拒绝旧SQL；健康getter仅返回静态状态码。实际Bridge health集成与告警仍待T4。
- 取消观察先从部分索引物化≤32个源ID，然后独立取≤16个run/holder候选；全轮≤16pairs/25ms，pending最多8身份且为新源保留半预算。未完成fanout持久化run/question位置；新实例继续。
- 无匹配的725个closeout可全量推进一次，后续连续三轮source/holderCandidates=0；35张superseded卡首次证据跨页全部记录，原卡未改/未删；outcome插入失败回滚cursor。
- 未来/非法时间不会堵后续源；future到期处理，invalid留明确pending。SQLite时间按round(julianday→UTC毫秒)比较，等时刻归因保持founder_verified。
- 源点查先读payload字节数，超过64KiB不加载/解析；JSON安全谓词只在索引源页使用，不在逐源元数据点查中重复解析大payload。
- 表分类为protectedCurrentOrReference；retention consumer从outcomes映射到新的observation-cursor，consumer gate ok=true/errors=[]。
- RED：新增迁移模块缺失、StateStore状态getter缺失；新增零匹配/fanout分页统计缺失失败。GREEN：迁移/取消/schema/runtime合跑55/55；非UTC时区下取消/迁移/schema45/45；teamlead typecheck成功。payload点查收紧后的额外验证回执见后续游标。
- 尚未完成：B2增量/晚到reconciliation、显式restore/replay、归档未消费源保护、cursor异常诊断与生产health/告警接线、1.7M大夹具及指定备份性能、全仓门与评审。此提交不是T1完成或事故验收完成。

## 验收状态（仍未完成）

## T1 第二批：B2增量与精确恢复回放

- B2从`(recorded_at,verdict_id)`索引取≤16个源身份，不先联holder；每轮共享16pair/25ms预算，独立pending预算。按PK核对项目/时间/payload大小后才读原holder；原verdict/outcome身份和归因保持。
- 每60秒最多16身份的reconciliation持久化位置和ceiling；已记录outcome先点查跳过，不重新查终态holder。为到期reconciliation预留4个pair，避免新源连续到达时饿死补读。
- 覆盖同时间较小ID、倒填历史时间、中轮重建观察器、在已越过位置后补入旧行并于下一轮发现；正常水位不倒退。future/invalid隔离，写失败回滚水位与结果。
- StateStore与运维restore调用方在原restore成功之后单独enqueue精确closeout源；返回附加observationReplay回执，失败明确`replay_enqueue_failed`，不伪造源未恢复或回滚已成功restore。idempotent restore可重试enqueue；零匹配回放正常结束，无依赖重试。
- 真缺依赖的pending每60秒重试，10次后next_attempt_at=NULL保留诊断。不会清空全局cursor或修改权威表触发器。
- RED：B2三项新增用例失败；restore三项因缺回放回执失败；依赖重试上界用例失败。GREEN：最终6文件79/79，含原归档21项及运维脚本4项；teamlead类型检查通过，teamlead构建通过；retention consumer gate通过。
- 仍需：T6归档未消费源/pending保护、T4健康与诊断告警、T3完整owner/lease审计、T5同步SQL计时及T7大库与完整门。上述源码通过不代表指定备份性能、生产15分钟/2小时QA或exact-head CI通过。

## 总体验收状态

| 项目 | 当前证据 |
|---|---|
| A 真实备份取消 <50ms | pending |
| B 15分钟 health/lag | pending 独立部署后 QA |
| C 增量水位、终态只消费一次 | pending |
| D 大夹具与 exact-head CI | pending |
| E 2小时 numeric comm.db fd | pending 独立部署后 QA；局部临时库回归不替代 |
| F 实际 Bridge fd.limit≥8192 | pending |
| 告警、SQL计时、归档预算/重启 | pending |
| Code review、PR、needs_review completion | pending |

## T6：有界归档候选与持久化游标

- 每页先按现有时间索引取最多64条元数据，再按主键执行原资格/JSON守卫；每调用最多2页，逐候选检查25ms页预算，保留50ms调用预算。payload上限64KiB、每页1MiB；active snapshot超过2000项整次保留并warn。
- 新workflow_terminal_archive_cursor与cold写入/hot删除同事务提交；持久化冻结cutoff、时间/身份位置及cycle完成状态。跳过行仍推进，完成后下一轮重查，重建连接可续跑。
- closeout未越过观察水位、精确pending存在、观察存储缺失/不可用时保留热行。新增scanned/skipped日志；运维drain按扫描进度继续，单次命令不重启已完成源轮次，零扫描且未完成显式报错。
- RED：缺持久化位置、误删未消费源、scanned字段缺失；另复现运维drain遇受保护前缀提前结束。GREEN：最终3文件35/35（归档26、运维5、restore replay4）；包含100k约1KiB payload稀疏候选夹具单调用<200ms与重建连接位置推进。既有lineage测试改为核对实际首批数及激活后零新增删除，适配逐候选预算。
- teamlead构建通过；retention consumer gate通过。尚未完成指定备份性能、T4/T5、完整连接审计、1.7M观察夹具、全库门、code review和PR；生产QA不由本阶段执行。

## T4 第一批：wrapper软限与现有lag缓存

- wrapper在source env后尽力只提高soft fd limit至8192；unlimited/更高值不降低，hard不足只WARN并继续exec。四分支隔离测试通过；真实无负载Node子进程从shell soft256启动后report为1048575，因此wrapper结果不作为F证据。
- 现有EventLoopAttribution缓存追加lag_ms（完整窗口max）、sampled_at、window_ms=30000、status；空/失败/不完整窗口不可用，超过60秒或停止后的有效样本标stale。沿用唯一采样器，profiler关闭仍采样，health仅取缓存。
- RED：缺新字段2项失败；GREEN：event-loop 7/7、HTTP health/event-loop选择5/5（其余34未执行），teamlead类型检查通过。wrapper新测试通过，原preflight5/5及fail-loud18/18通过；新脚本已显式登记CI，shell枚举门通过。
- T4尚未完成ProcessResourceMonitor、Darwin effective cap、fd使用率统一告警/恢复及实际Bridge接线证明；不把上述测试或隔离Node当生产验收。

## T4 第二批：fd监测缓存及HTTP接线

- 新ProcessResourceMonitor在startBridge生命周期单例，30秒异步数字fd去重采样，5分钟刷新进程report软限与Darwin固定sysctl子进程的kernel cap/system counters。effective取min；任一必要上限未知或超过10分钟不计算分母；fd超过60秒标stale。health仅读缓存，不fork。
- 2秒观察超时保留flight到所有探针实际settle；使用allSettled，单探针拒绝也不能提前放锁。stop停止调度并等实际cleanup；超时/失败不把旧count标fresh，不把未知count置0。snapshot只保留数字、时间和静态状态，不泄露路径/完整report/error文本。
- 核心压力状态机>80% warn、拒绝/异常回执下轮重试、<70%连续两次quiet resolve且拒绝则再试；unknown/失败打断低位连续计数。此批只完成可注入状态机，生产统一告警回调尚未接入，不能把warn当unified alert验收。
- RED：新module缺失及HTTP缺fd字段。GREEN：最终8/8（资源7+真实HTTP1），teamlead类型检查通过。HTTP反复读取未触发新probe，shutdown的ok/shuttingDown保持。
- 隔离原生Node探针输出used26、rlimit_soft1048575，但当前环境kernel_per_process_limit不可得，因此limit=null/status=unavailable。此为开发子进程，不是生产Bridge，不满足F；未修改主机配置或生产进程。
- 下一步：给bridge_fd_pressure注册kind/owner并接routedAlertSink持久化回执、同启动episode身份及恢复；增加AlertChannelHub/路由合跑，再做T5 SQL计时、T3剩余lease审计、T7完整门及性能、review/PR。

## T4 第三批：统一fd压力告警与恢复

- 新FdPressureAlert用machine项目、Bridge启动实例sessionKey和递增episode eventId绑定同次压力事件；重试复用完全相同payload。sent/queued/deadLettered为交付回执；duplicate必须另查StateStore的alert_delivery_receipts，尝试claim本身不算成功。
- bridge_fd_pressure注册kind、owner=claude、human_by_design及完整展示文案，经routedAlertSink进入现有值班路由；ProcessResourceMonitor回调在路由准备后绑定，提前采样不会虚报已通知。无自动restart/dispatch开关改动。
- 两个低位新鲜样本后按correlation+eventId安静resolve；失败保留原episode重试。Hub的fleet recovery纳入该kind，处理恢复之后才送达的同启动实例旧episode；其它启动实例或无效身份返回unknown，不跨实例误清。
- RED：新helper缺失；回执夹具初用无效queued枚举触发CHECK，改用真实queued_durable格式；类型检查指出新增kind缺展示分支，补齐后green。验证：kind/路由/helper组60/60；文案/Hub/fleet身份/helper组65/65；teamlead类型检查通过。包含真实StateStore回执和延迟Hub送达后恢复测试，无外部通知。
- 尚未宣告T4生产验收：当前开发探针kernel上限不可得，生产同PID/start identity、F及受控统一回执/恢复仍需部署后独立QA。剩余T5计时入口/计时器矩阵、T3完整lease审计、T7大夹具/指定快照/全库门、review/PR未完成。

## T5 第一批：实例级同步SQL计时及主要入口

- 新config.installSqlTiming以WeakSet限定连接实例，只输出databaseKind/sqlId哈希/method/durationMs，阈值严格>250ms。prepare/exec/pragma、statement run/get/all、iterator next/return/throw与事务执行均在finally计时；logger失败不替代原结果/异常。
- 保留真实statement身份/链式调用和事务default/immediate/deferred/exclusive。事务别名使用描述符复制及缓存，避免native nonconfigurable属性的Proxy不变量冲突。事务内SQL和事务总体可各自记录，重复安装不翻倍。
- 已接StateStore普通/maintenance/备份验证，CommDB writable gate/readonly/旧库adoption，CommDB恢复preflight/backup，MailboxQueue readonly及borrowed连接。withSyncOpMarker新增同阈值静态op耗时；不把Promise后续网络时间算为同步阻塞。
- RED：入口测试4条预期慢日志为0；marker新增慢同步断言失败。GREEN：config3/3；marker4/4；真实SQLite与原marker覆盖合跑9/9，扩展MailboxQueue后真实连接3/3；CommDB打开/FLY2268迁移24/24。覆盖真实锁等待后SQLITE_BUSY、原始错误/日志异常、6条连接/访问路径、yield后执行、native事务别名和iterator cleanup。
- config/comm/claude-runner构建通过，teamlead与config类型检查通过；新核心计时/marker文件Biome检查通过。测试中实际marker慢调用现已按静态标识输出日志，不隐去红/慢证据。
- T5仍未完成：剩余原生DB旁路/恢复/独立进程入口分类和timer-sites完整矩阵、补相应入口及覆盖。当前搜索找到67条原生new Database/BetterSqlite3文本命中（包含独立CLI及bin测试），不能把该搜索当完整执行覆盖。下一批先审计这些入口，随后继续T3剩余lease审计与T7大夹具/指定快照/全库门/review/PR。

## T5 第二批：原生旁路及timer入口矩阵

- 对三包非测试better-sqlite3构造点做AST清点：57处TS原生打开点均有实例计时；本批新增覆盖其中47处（32文件），另接运维归档/恢复命令5处连接。构造参数、readonly/timeout、事务及close归属不变；只增加原始实例的计时安装。
- timer-sites更新为40个实际AST调度调用（含typing adapter/调用两层），去掉类型/注释误计；timer-sql-matrix.md逐项映射StateStore/CommDB/raw/本地库入口，明确browser模板、guard worker、独立gateway和CLI边界。token-report/qa-framework独立工具不被误称为Bridge timer。
- 新增publication reader真实旁路回归，RED为缺慢SQL日志；GREEN为入口测试4/4。原生存储/reader组35/35，comm snapshot/lease组42/42，memory-distill51/51，归档/恢复运维5/5；comm/runner构建和teamlead类型检查通过。32文件Biome检查exit0，仅保留既有字符串拼接信息提示，未做无关修复。
- 清单是源码/连接级覆盖证据，不冒充生产每个timer的实际触发或15分钟健康验收；真实锁等待、async yield后SQL、readonly/borrowed与native事务/iterator行为由上一批及本批测试覆盖。
- 下一步T3剩余CommDB owner/lease审计（founder-reply-deliverer在外部await期间持lease仍待处理），然后T7 1.7M事件/500holder、指定快照与全库门、有效code review/PR。未执行生产写入/重启/QA派发。

## T3 第二批：接续 WIP，验证 founder reply 短作用域

- 本轮接续 `df5e3ceb8`，TURN epoch=4/implement；在线复核R2 effective APPROVED，未重开设计。Lead handoff `cbef1acb-619b-4f45-9251-e12a992415d3` 要求继续批准计划、审计WIP、非draft PR且review期间不push，已采纳。
- WIP的`openExistingWriter`只打开既有库，检查mailbox generation，不运行CommDB构造器的migration/purge，busy_timeout=0。founder回复按同步调用打开/释放，跨await只传递GateResponseDb方法包装；founder_review可信写仍在单一同步作用域内。既有ship handler在异步分类后核对当前session/question/head，写入仍走原可信writer。
- 首次继承验证43/47通过；4项旧测试仍要求整轮同一实例/仅release一次。改为核对可用的门读取结果、每次acquire与release一一配对，保留借用对象由owner关闭的断言。新增默认生产writer在Lead handoff挂起与reject时numeric fd回基线、拒绝时cursor不推进；生成检查拒绝连续20次也回基线，无GC。
- RED：临时使用WIP之前的deliverer运行3个生命周期回归，全部失败：learning await时live=1，默认路径numeric fd=17 vs baseline14。随后恢复当前源码；红回执`/tmp/fly2563-founder-scope-red.log`。测试初稿误写reject结果为retry，按现有ThreadScanOutcome的process_failed合同更正，cursor不推进断言保留。
- GREEN：founder deliverer49、ship handler29、factory5、fleet4、gate-poller-health10、lifecycle15，合计112/112；CommDB open-hardening含既有writer锁/缺失库/旧代拒绝；comm build与teamlead typecheck通过。仅本地定向证据，非全仓/CI/生产验收。
- 待续：T3完整owner清单与默认/legacy多项目寿命夹具；T7 1.7M性能、指定备份、全仓门、code review、非draft PR及needs_review完成回执。未派发QA、未重启/部署。

## T3 第三批：GatePoller 实际调用链释放

- 调用方审计发现GatePoller原先保留每项目readonly/writer两个连接，并给deliverer注入release空操作。上一批默认deliverer局部证据不能证明此生产组合已释放。
- 新回归在真实GatePoller pass的投递入口挂起；RED为numeric fd21、baseline16。现改为同步物化各Lead的pending数组并关闭两条项目连接，然后才yield/构造任务/异步投递；移除借用writer覆盖，deliverer使用上一批的既有库短作用域。保留每轮扫描预算、顺序、水位、逐Lead读取失败隔离和可信写回验证。
- GREEN：扫描预算6、调度9、report排除3、ship grace5、deliverer49，共72/72；teamlead typecheck通过。未将此定向证据表述为全仓或生产验收。

## T3 第四批：多项目 runtime 初始化失败与 admission fd预算

- 新真实SQLite `commdb-lifetime.test.ts`：两个项目后续transport构造失败，RED为numeric fd26 vs baseline16。LeadInboxRuntime现在在项目初始化失败时清理已登记的loop/admission/runner adapter/queue/lease reader，保留原异常；重复close路径仍可执行。
- 空闲默认backend预算原本通过；触发question revalidate后RED为额外14fd>6×2=12。定位到QuestionAdmission每Lead惰性缓存CommDB。现为两次eager读取的同步短作用域，使用已迁移库`openExistingWriter`，关闭后仅保留question/是否pending；既有eligibility/materialization/receipt语义未改，无连接池。
- 原FLY-1601防退化测试断言缓存实例，已改为直接证明两轮revalidate未调用migration或purge，且每个scope返回的连接已关闭。33项admission原语义覆盖通过；该变更不恢复每条消息全量migration或5秒锁等待。
- legacy runtime保留每Lead常驻连接；两个项目各一Lead、100轮共200次实际deliver的numeric fd保持不变，重复shutdown回基线。默认backend空闲/触发question检查的两个项目均满足≤6P。此为隔离进程numeric总fd增量，不能替代生产按comm.db分类的2小时证据或推断所有部署拓扑满足E。
- GREEN：lifetime4 + admission33 + LeadInboxRuntime39 =76/76；teamlead typecheck通过。没有外部网络发送。lead-inbox-runtime主要diff为给原有项目初始化循环添加try/catch造成的缩进；`git diff -w`可核对功能范围。
- 后续仍需T3全量owner矩阵，尤其MailboxQueue自身constructor失败的原生连接清理与其他factory/lease；T7性能/指定快照/全仓门/有效review/非draft PR。当前所有chunk尚未宣称完整通过。

## T3 第五批：MailboxQueue 构造失败

- 真实损坏schema复现owned MailboxQueue安装失败泄漏3个fd；注入pragma异常复现readonly与底层writable打开失败各泄漏1个fd。借用原生连接失败仍保持可用。
- owned Queue在连接返回后的所有初始化异常关闭连接；openCommDbWritable的最外层清理覆盖计时安装/pragma与receipt rename等返回前失败，保持原异常与既有stale-receipt正常返回语义。
- RED：4项中3项fd未回基线；GREEN：open-lifetime4、open-hardening4、queue-schema12共20/20，queue23+FLY2268 migration22共45/45；comm build通过。无GC/生产数据库操作。

## T7 第一批：真实大库性能与独立CI项

- 新`observation-performance.test.ts`使用文件型完整StateStore，1,700,000事件、500 holder、2,729 canceled closeout，其中50源各匹配500 holder。补读从cursor=0开始，完整清空后得到25,000 outcome；三次以上无新增输入时source/holderCandidates/outcomes均为0，末端再追加取消事件证明继续推进。
- 每组保留5个完整调用样本；造数/建索引单列约10–12秒、数据库约434MB，关闭后删除临时库。modeTick测真实本地verdict/cancel/clarification轮次及yield，两种mode均执行，不mock观察器或放宽阈值。
- CI新增`Unit (observation performance)`固定任务，继承单worker环境，不跳过失败。常规teamlead shard仍包含此测试。
- 所有结果在`performance-runs.jsonl`：run1 FAIL（backlog最大27.083ms、steady0.252ms、tail154.543ms；auto64.449ms/dry72.367ms）；run2源码未变PASS；run3增加CPU/GC观测PASS（backlog21.803ms、steady1.266ms、tail4.924ms、auto9.916ms/dry31.822ms）。不删除或筛掉首轮失败，不将后来PASS当作首轮尖峰的归因或豁免。run3取消窗口无GC重叠，不能反推run1原因；首轮尖峰仍未定位，需结合exact-head CI及后续证据判断。
- 诊断插入脚本首次匹配失败，run2实际为未改源码重复运行，已明确记账。性能assert始终为取消<50ms/modeTick<100ms，5次全部纳入max/p95。源码缺陷尚未由run1单点证明，不为追绿改变生产行为。
- 初步AST owner discovery现有102处Bridge CommDB打开点，其中19处factory/常驻owner需跨函数追踪、31处包含await；该清点只是定位，不宣称完成完整owner audit（临时输出`/tmp/fly2563-owner-discovery.json`）。指定事故快照、全仓门、代码评审和PR仍pending。
- 本批teamlead typecheck通过；shard/真实Vitest分区9/9通过（包含实际子进程分片约89秒）；CI枚举检查通过318项shell分类和61项Node登记。曾误调用不存在的`check-ci-shell-tests.mjs`，该调用exit1，不是有效门；随后运行仓库真实`ci-shell-suite-enumeration.test.sh`并通过。

## T3 第六批：voice 工厂跨函数泄漏

- 102点AST清单追到plugin的voice openCommDb factory；原factory返回新CommDB，voice-routes写入后无close，且跨异步post-write hook持有。新openVoiceCommDb先验证已有库并释放，再返回与founder文本路径相同的同步GateResponseDb包装；每次方法调用重新开/关，不保留裸句柄，原route绑定/可信writer/hook语义不变。
- RED：用原factory等价实现测得17fd vs baseline14；GREEN：新scope2项 + 原voice routes26项=28/28，teamlead typecheck通过。覆盖异步间隙fd基线、下一轮读取看到另一连接的新response及缺库factory拒绝。没有向真实voice/Discord发送请求。
- 跨函数追踪已核对review coordinator的inspect/respond（write之后close，后续hook在外）、terminal-commdb-sync（每项finally-close后yield）、commdb-probes调用者finally-close、account-switch-consumer每次wake的finally-close；其余factory/await清单仍需收束，不能以此宣称102点全部完成。

## 指定快照前置状态

- 事故备份仍存在，约1.6GB；原文件未写入。当前执行无managed snapshot目录。
- 官方`node scripts/flywheel-snapshot-control.mjs runner --source ~/.flywheel/comm/flywheel/comm.db --kind comm --project flywheel`返回`{ok:false,reason:snapshot_owner_unavailable,retryable:true}`。只检查env键是否存在：exec与Bridge URL有，TEAMLEAD_API_TOKEN无。controller在owner HTTP之前即拒绝；未读取额外凭据、未覆盖identity、未伪造.owner.json。
- 已发非阻塞Lead问题`c870e05f-1086-4107-badd-0bdec19e9fc3`，补充诊断report`fcaf00dc-a633-4274-b69c-e654803816b5`。等待提供合规owner获取能力或QA路线期间继续其它工作；不是整个任务blocked。

## 全仓门启动

- 首次`pnpm lint` exit1：7个error均是本单文件import排序（config index/sql-timing测试、fd/health/resource/timer测试、plugin）。定向整理这些文件后`pnpm lint` exit0，保留19条warning，无生产语义改动。
- `pnpm -r build` exit0，包含9份phase protocol projection检查和全部包构建。
- 已启动`pnpm test:packages:run`；汇总结果尚未到达，日志`/tmp/fly2563-package-gate.log`，exec session26020。不可将启动/定向green记成aggregate green；继续轮询这个具体handle，不重复启动。
- Lead对snapshot问题的正式答复（response `fcaf00dc-a633-4274-b69c-e654803816b5`）：runner不注入TEAMLEAD_API_TOKEN是最小权限设计，禁止绕过；Lead提供只读comm快照`~/.flywheel/patrol-repairs/FLY-2563__comm-flywheel__2026-09-15T07:27:01.539Z__5aa3e82a-8dbe-4d48-9a1f-52b01ca86886.db`。已用CommDB.openReadonly验证generation，listSessions返回50条后close；未写此文件。
- 按Lead指示一次性请求teamlead上下文，question `b07d0b86-d375-4dab-b37a-9ed4e3fde5f4`：需指定9-14原事故备份的隔离可写副本/合规benchmark执行路线，原因是完整observer会安装索引并提交outcome/cursor。未用当前comm快照冒充事故teamlead验收。已用DONE report `778c21bf-586f-4375-93ef-c49d764a185a`回执Lead指令。
- aggregate gate最近一次poll确认session26020仍运行，正在claude-runner测试；结果尚未到达。此turn分类为progress + verified wait，而非完成/blocked。
