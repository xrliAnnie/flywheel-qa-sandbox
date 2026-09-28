# FLY-2965 班车与窗口核对解耦 — 实施计划
Issue: FLY-2965 (https://linear.app/geoforge3d/issue/FLY-2965/病根-定时班车-restart-servicessh-的非生产-tmux-残留只读审计对-tmpcmuxsock-跑-list)
日期: 2026-09-27
基于: research.md

## 状态与交付范围

Status: DRAFT R3 — R2 CHANGES_REQUESTED已修订；Lead允许必要收敛重试， 必须有效 reviewVerdict=APPROVED 后交接 Implement。本文不是实现完成证据。
目标：修复错协议探测、无界输出收尾和逐Lead重复全局扫描；先记代码部署与恢复普通派工，仍保留全体窗口证明。R1“巡检接手全部Lead”前提已推翻。设计节点只提交文档、隔离调研证据和 founder HTML。不得重启生产，生产验证等下一班。

## 不变量

1. 不向未证协议的 Unix socket 发 tmux；不因持有描述符、ppid=1、进程名或 socket 存在推导服务端身份。
2. 现有只读 probe 的结束由受管子进程及本地捕获文件决定，外部 peer 持有输出描述符不能延长函数生命。
3. build/Bridge运行身份/voice等真实门失败不推进deployed-sha；窗口失败不延迟已成立的代码版本账本与普通owner派工恢复。重启锁仍保留至有界诊断结束，不宣称整个班车寿命完全解耦。
4. forward及rollback保留全部候选visible复核，包含7个未入部门巡检的Lead。仍双采样、最终carrier身份复验；不把未检查写为pass。
5. 保留merge_lead_visibility_failures与plugin-restart-pending恢复合同，healthy仍包含真实窗口证明；部门巡检只是补充，不能替代全体核对。
6. 不新加频道告警、定时器、watchdog、缓存、后台任务或依赖。

## 结构、身份与覆盖

当前17个班车候选全部保留，不按canSpawnRunners过滤。其中未入dept巡检的7个是：geoforge3d/cos-lead、growth/mufasa-lead、flywheel/flywheel-cos-lead、flywheel/codex-infra-bot-lead、flywheel/claude-infra-bot-lead、tidal-echo/tidal-echo-cos-lead、raya/raya；本次缺窗3个全部在这里。

| 事实 | 来源 | R3合同 |
|---|---|---|
| 代码部署 | Bridge identity、deployed-sha | 真实服务门后写，窗口失败不回退这个事实 |
| Lead上线 | leads-restart-status.json、carrier与visible结果 | 保留schemaVersion=1、healthy/failed等现有语义，不新增R1的not_checked/lead_patrol字段 |
| 窗口证据 | project/leadId、carrier identity、cmux/tmux generation、pane/render/receipt | 批次共享采集，逐目标稳定性判断 |
| 后续自愈 | PLUGIN_RESTART_PENDING | 缺窗/未知保留，原全局cmux缺席特例仍清除 |
| probe输出 | Anonymous TemporaryFile | 固定fstat长度、os.pread，不依赖EOF |

消费者点名：scripts/lib/updater-raya-deploy.sh:raya_rebind_flywheel要求healthy/failed=0/skipped=0/total=17并另做live verify；scripts/cutover/FLY-2264/verify-native-tmux-cutover.sh当前要求total=16（现场源码如此，非评审概述的17）。本单不改其期望值或healthy语义。Lead状态文件只在整批完成后写；代码SHA先变时旧状态文件SHA不匹配，消费者不得复用。

## Chunk 1：删除无部署职责的 socket 审计

改 scripts/restart-services.sh：
- 删除 audit_tmux_qa_residue_read_only 及 deploy_and_verify 的唯一生产调用，删除仅供它使用的变量/旋钮 truth 登记（先搜全仓确认独占）。
- 不搬到另一自动任务。明确同时退役tmux-qa-residue-flywheel-session severe告警，无替代消息；QA slot所有权/teardown责任不变，旧告警断言同步删除。
- 保留 tmux-server-rescue.sh source（其他功能有消费者时），绝不删除共享 rescue。
- scripts/__tests__/restart-storm-gate.test.sh 移除旧“restart 必须扫描陌生 socket”断言，替换为错误端点零访问反例；更新 codex-home-reconcile-cadence / legacy-swap-broadcast-retirement 的相应桩或提取边界。
- 本单不修改 QA 销毁逻辑，不杀任意生产 tmux/cmux，不用路径黑名单假装证明协议。

## Chunk 2：修复现有 probe 的输出捕获

改 scripts/lib/tmux-server-rescue.sh 的 _tmux_rescue_bounded_exec Python 片段：
- 使用标准库 tempfile.TemporaryFile 两个匿名捕获文件作为 stdout/stderr，替换 PIPE。
- 保留 stdin=DEVNULL、start_new_session=True、现有 requested/remaining budget 计算及 rc 124/125 语义。
- 用 proc.wait(timeout=timeout) 等待直接受管 child；到期保持当前 killpg(SIGKILL) 行为并回收该 child。之后fstat取固定长度并用os.pread(fd, min(chunk,n-offset), offset)分块回放，不调用无时限communicate、不seek/read共享偏移。提前EOF停止，不能追随增长。
- 回放正常/非零/超时前已产生的 stdout/stderr，负返回码映射仍为 128+signal。临时文件随上下文关闭，权限由 TemporaryFile 默认安全建立，不按用户输入拼文件名。
- 文件可能被不受管 peer 持有：只读收尾瞬间 fstat 的固定长度（可用限定长度循环分块回放），不能追随并发追加直到永远。peer 仍写的未来字节不属于已结束 probe 的输出。不杀 peer、不等它退出、不 truncate 它持有的 fd。
- 这修的是“结束条件依赖外部管道引用”的根因；不新增保底时限、不改 bounded-run.sh、不扩展成通用进程管理框架。
- 现有 budget 到期且 child 已退出/不存在，维持幂等收尾。tempfile/Popen/fstat/pread/回放等基础设施异常统一125，不能用Python默认1冒充has-session不存在而触发new-session。已spawn后异常仍清理受管child，不能杀peer；诊断不打印argv。
- 临时目录显式为非空TMPDIR，否则/tmp，传dir给TemporaryFile；不可用直接125，禁止自动回退cwd。文件0600且立即unlink。ps完整argv可能含token，相比内存PIPE存在短暂落盘机密面，不持久化复制；验收合成秘密值、权限、无残留。并发peer改已有字节不是原子快照，只保证固定长度与不扰动共享偏移。
- 精确验证信号/空输出/二进制/大输出/超时部分输出/外部留存fd；TMPDIR不可写、缺失、读写故障均125且不能new-session。保留锁 fd 关闭语义，相关 lock 测试必跑。

## Chunk 3：保留全部可见性证明与收敛等待，消除逐目标重复采集

不删除visible gate，不依赖覆盖不全的部门patrol。修复的成本来源是N个Lead各自重复两次W个workspace全局surface枚举。异步refresh尚未完成时的必要收敛等待必须保留，不能当作冗余。Lead在6b8154c1-6b34-4c1c-a79d-7c2e3b667293明确撤回删除重试要求。

### 每批两次共享采样，仅未通过目标进入下一批

scripts/flywheel-cmux-sync.sh增加--verify-agents-visible --target TITLE（可重复）--json；非空、合法key、重复拒绝64。现有--verify-agent-visible单目标接口和JSON不变。
从_verify_sidebar_once拆出已有共享采集与目标判断，不重写判据：
- 每个采样一次完整workspace/birth join、严格tmux inventory、roster/ledger/restored读取；所有目标复用同一采样的内存数据。隔现有5s后重新采集第二份，绝不跨采样/进程/班车缓存；现有CMUX_ATTACH_BIRTH_CACHE_READY每采样重置。
- 两次都遍历所有目标。目标authority/pane/read-screen不可用只影响本目标；全局输入损坏/generation不可得影响所有依赖者。不得遇到第一个目标失败便丢掉其他结果。
- 保留全局重复/歧义归属检查，不只按title过滤；同名或改名副本不能漏。保留本目标authority、roster行、source/view/pane、client、render非空、committed receipt/birth UUID及restored证据。
- 稳定性只比较本目标投影与cmux/tmux generation，无关Runner churn不污染其他目标；不能复用verify_sidebar_targets的全局evidence等值规则。
- 输出schemaVersion=1、results=[{target,status,reasons,report}]，每个输入恰一项，无额外目标。逐项pass/fail/inconclusive保持原单目标规则；整体rc有inconclusive为2，否则有fail为1，否则0。rc1/2仍解析各项，不能整批降成同一结果。缺失/重复/额外target、非法JSON/status或rc冲突→批次unproven，不静默drop。
- 批次外层超时rc124统一visibility_unproven，原因batch_timeout；无完整可信JSON为visibility_unproven/invalid_batch_result；不能凭被截断输出确认单项缺窗或沿用部分pass。当前单目标路径rc124映射fail/visibility_timeout不变。批次未完成无法分清慢采集与真实缺窗，因此新批次统计/既有告警使用unproven语义，仍保留marker。
- JSON用序列化，不拼未转义工具文本；工具路径、环境隔离沿用现有验证。
- 原单目标函数可复用分离出的采集/判定，但输出合同完全兼容。

restart_lead_visibility_barrier保留候选清单/原cmux preflight/统计：
1. 每批仅对pending目标用原4并发worker执行carrier轮，保存该批精确identity，carrier失败/未知不能由cmux页面抵消。
2. 对本批carrier通过目标调用一次batch visible；预算复用现有AV_CMUX_TIMEOUT_SECONDS=240，不加新超时或watchdog。batch不支持时unproven，不能fallback回N次全局扫。
3. 将visible通过者及其本批carrier identity放入success集合，从pending移除；只对尚未pass的目标重试。已pass目标不再运行目标判据/read-screen；后批全局清单仍需完整采集以发现重复归属，不能省成仅pending窗口清单。保留逐项最新结果，不在中间批次发终态告警、写degraded或改变marker。首批全绿立即停止收敛批次。
4. 保留既有1320s fleet deadline、sleep2及最终carrier预留，保留pending/next/MAX_ATTEMPTS测试钩子；无新预算旋钮/时限。复用原remaining > revalidation_reserve + 262的再试条件；每个采集子调用同时受deadline-reserve约束，batch取min(240, phaseRemaining-1)，carrier各worker也不得越过这个边界。剩余不够则保留未证明结果，不侵占最终carrier预留、不在超时后接着扫描。
5. 所有批次结束后按原carrier轮一次最终复验success集合，每项identity必须等于它通过那批的identity；变化或预算不足为unproven，不能保留早先pass。只对最终未收敛项合并失败与marker，最后批次的稳定缺失为fail，持续subject_drift/不可读/跨代为unproven。保留原三态、全局cmux缺席特例和非阻断返回。

调用次数验收：N=17，W=10/100/200，每批完整birth surface枚举为2W，不是2NW；第k批目标屏幕读取至多2N_k，N_k是本批pending中carrier通过的数量，已pass者不重复读取。批次数受既有deadline及每批5s双采样间隔/原sleep2约束；首批全绿恰一批，首批未收敛后批pass必须清marker。再测耗时；不能通过调小timeout声称性能改善。若真实17目标无法在现有240s内完成，诚实inconclusive并报成本来源，禁止擅自放大预算掩盖。

### 收尾顺序与恢复

forward deploy_and_verify保持build/Bridge identity/voice/Lead启动/watcher真实门；保留trigger_cmux_refresh。先record_deployed_range、写deployed-sha、update_project_shas，再按原restart_bridge条件resume_admission_best_effort，之后运行共享visible收敛批次、merge失败、写原Lead状态/重试marker/已有degraded结果。普通lease首次恢复失败时保留lease id；诊断结束后仅当ADMISSION_PAUSE_LEASE_ID仍非空且原owner允许释放时再调用现有幂等resume一次。成功会清空lease id，不重复恢复；再次失败沿用1800s TTL，不新增循环或EXIT恢复机制。restart_on_exit本身并无resume调用；诊断中途异常退出仍仅原TTL保底。函数返回0不是派工已恢复证据。cutover/迁移owner fence从不释放。

rollback_and_restart先完成旧代码/Bridge/Lead及必需voice恢复的安全边界，再按owner合同resume普通lease，之后同一共享批次收敛屏障合并rb_leads_failed。诊断结束后的同一次幂等resume补试也适用于rollback；异常退出仍只依赖原TTL。绝不写失败的新CURRENT_HEAD为deployed。voice失败保留原失败处理和普通lease清理，不留下新永久pause。

重启锁持续到同步诊断结束，不能手工提前拆锁。诚实取舍：代码版本和普通派工先恢复，全班仍等既有预算内的收敛诊断；不是完全异步。不存在后台新任务。

retry marker保持：failed=0清除（含原skipped-only语义）；carrier失败/目标visible失败或未知保留；原host-wide cmux absent且carrier健康特例清除；counts unknown保留。健康语义不缩小。

### 锁与耗时（Lead问题ebebee54的补充）

- 复核期间restart仍持有HOME/.flywheel/restart.lock.d；父update-flywheel同步等待它，仍持有SELF_SHIP_LOCK_DIR（默认HOME/.flywheel/self-ship-updater.lock.d）。如进入Raya维护周期，其RAYA_DEPLOY_LOCK_DIR也由父进程原生命周期持有。本单不提前释放任一部署互斥锁。
- 因此重叠的下一班/人工重启仍会按原互斥合同等待或no-op，不能宣称“绝不挡下一班”。但Bridge普通派工lease在复核前已请求释放；只有收到owner-qualified恢复回执才证明新Runner可派。恢复请求失败或cutover-owned fence仍在时，派工仍可能被合法暂停，不能把这些写为窗口核对已挡住派工。
- 今日16:01–16:21Z是Lead现场约20min区间；日志精确可见性段09:02:58–09:20:29 PDT=1051s（17m31s），整个admission暂停08:54:43–09:20:56=1573s。不能把两个区间混为同一测量。
- 已有FLY-2643单目标成功复合探测84/88/91/121/158s（包含两次全局扫描）是成本估算参考；每批共享双采样替代逐目标重复。预算目标为batch至多现有240s + 首末carrier各5批、当前每批约6s=60s + preflight至多5s，故首批全绿、正常资源条件下预计约150–305s再加本地记账/额外目标屏幕读取；这是待QA证实的规划区间，非已测改后结果。应以同一17目标和今日同量级workspace数据对照1051s，不把1051简单除17作为保证。
- **异常最坏预算仍是原全局1320s（22min）**，含首轮carrier、batch、末轮carrier，此外有入口preflight现有5s和本地清理。每个子调用只拿remaining预算，采集batch取min(240, remaining-reserve-1)，末轮无剩余则逐项unproven。若异步refresh迟迟不收敛，必要重试可能用到该上限；每批仍只采两份全局快照，只重试未pass项。部署关键路径不会再等这1320s才更新版本/尝试恢复派工，但重启锁在异常尾部仍可能持有这么久。
- 以上是既有调度预算，不是磁盘/内核永久不返回时的硬实时保证；不通过新增watchdog压数字。若已具备真实稳定窗口的首批全绿代表性复演仍接近1051s或耗尽1320s，则重复扫描根因修复未达性能验收，定位实际调用计数与耗时后返工，不以inconclusive快速退出伪装成功。延迟收敛反例独立记录refresh完成时间、批次数和最终结果，不能把必要等待掩盖成采样性能问题。

refresh不再靠长barrier保证寿命。已有5s/10s后台refresh是best-effort，watcher为收敛责任人；验收必须观察launchd清理形状下两者是否完成，中断后实际watcher及原事务/receipt能否恢复。不能只凭日志结尾说完成；若出现不可恢复半成品则阻断交付、补设计，不能再延长barrier或新造后台管理器。

## Chunk 4：验收与反例（Implement/QA 必须完成）

| 用例 | 真实执行范围 | 必须证明 |
|---|---|---|
| A 协议错配负例 | 私有临时 Unix socket + 本机真实 tmux -N；模型接受连接但不说 tmux | 旧客户端无结果；正确行协议 ping 能回；修后 restart 根本不向它连接 |
| B 输出 fd 逃逸 | 使用 recvmsg(SCM_RIGHTS) 在 peer 留存 stdout/stderr；真实 probe | 旧 helper 1s 后仍不返回直到 peer 关闭；新 helper 在原预算附近返回 124，peer 仍存活且 fd 未释放；不使用同一超时替身伪造成功 |
| C 正常与错误输出 | 实际 child /bin/sh + 捕获文件 | 原字节/退出码与 signal 映射相同，大输出不卡；固定长度读回不会追逐peer无限追加 |
| D 完整班车模型 | 调实际 deploy_and_verify 主函数、真实临时版本账本，现有外部 seams 隔离 build/launchd/Bridge/通知 | 从 admission pause→身份/voice成功→Lead启动→版本写入→admission resume→锁释放完整走通；陌生协议端点零访问；visible假端点不响应时版本/owner恢复已完成，最终有界返回unproven并释放锁 |
| E 真失败负控 | 同 D，仅把 Bridge identity 或 voice 改为失败 | 不写新 deployed-sha，走原失败/rollback；不得因重排漏掉真正门禁 |
| F rollback 与 Lead 部分失败 | 实际 rollback orchestration，外部动作隔离，carrier 失败桩 | 保留全部visible批次；准确失败与unknown，marker缺窗保留/全局缺席特例/unknown counts/skipped-only逐项断言，owner合同保持；首次resume失败、诊断结束后成功/再失败、异常退出只靠TTL、cutover owner不释放逐项断言 |
| G 独立窗口核对 | 529 或本机全隔离 HOME/socket/状态根；真实 verify-agent-visibility 与 lead-patrol-snapshot | 存在真实可读 pane+正确回执时 pass；缺窗口 fail；探测不可用 inconclusive；subject/身份漂移不能 pass；17候选含全部7个非dept Lead；代码/普通派工先完成，批次诊断仍在锁内 |
| H 非生产完整路径 | 529 或同 D 的可审计 dry-run/harness，保存完整调用序列 | 一班跑通、有版本写入与资源释放；单纯 --dry-run 只打印计划不算此证据 |
| I 下一班生产 | 独立 updater 自然窗口，QA/Lead 只读观测 | 记录开始/结束、版本、admission、17项窗口核对、retry marker和refresh恢复；本单禁止手动重启生产 |

设计阶段只运行了协议调查模型，没有运行修后 tests、529 或生产验收。验收 H 是替身隔离依赖的完整控制流证据，不冒充生产重启。

新增验收J：N=17、W=10/100/200每批调用计数2W而非2NW；首批全绿恰一批并与1051s实测比较；模拟refresh迟到/lease busy/subject迁移，首批未收敛后批pass必须清marker且不发中间degraded；已pass目标不重复目标扫描，最终carrier漂移仍拒绝pass；身份/receipt/generation漂移、同名改名副本拒绝pass，无关churn不污染；批次rc124、截断JSON均unproven且不消费部分pass。K：launchd退出后refresh/refresh-surfaces是否完成；中断时用实际watcher+receipt证明恢复，失败即阻断。L：pread不扰peer偏移、TMPDIR等基础设施错误125、无cwd回退或临时残留。

## 相关测试选择

在实现前按 local-test-policy/v1 记录 git grep -lF 对旧/新 literal、每个改动完整路径/文件名/父目录的匹配，形成 evidence/test-selection.md；逐个列排除项和理由，不能用目录/glob/整包 suite 代替。
保留至少：
- scripts/__tests__/tmux-server-rescue.test.sh
- scripts/__tests__/tmux-server-rescue-lock.test.sh
- scripts/__tests__/tmux-server-rescue-instrumentation.test.sh
- scripts/__tests__/tmux-server-rescue-real-tmux.test.sh
- scripts/__tests__/host-tmux-selection-restart-mounts.test.sh
- scripts/test-cmux-sync.sh
- scripts/__tests__/restart-storm-gate.test.sh
- scripts/test-restart-services.sh
- scripts/__tests__/restart-services-no-voice-bridge.test.sh
- scripts/__tests__/codex-home-reconcile-cadence.test.sh
- scripts/__tests__/legacy-swap-broadcast-retirement.test.sh
- scripts/__tests__/restart-deploy-consistency.test.sh
- scripts/__tests__/restart-deployed-range.test.sh
- scripts/__tests__/rollback-r4.test.sh
- scripts/__tests__/lead-patrol-snapshot.test.sh
- scripts/__tests__/agent-visibility.test.sh
每个 /bin/bash 单文件执行。新增 probe fd 回归放具体 shell 文件并接入当前 CI 清册、ci-structure 清册和 kill-path 清册（若含 kill），不能把新脚本只留本机。
保持 pnpm lint。计划会改packages/config/src/feature-flags/truth.ts退役独占旋钮；必须逐文件跑packages/config/src/__tests__/flag-truth.test.ts、packages/config/src/__tests__/feature-flags-drift.test.ts及其他literal命中，pnpm --filter flywheel-config exec vitest related src/feature-flags/truth.ts --run，pnpm --filter "flywheel-config..." build；exported API/type变更加依赖typecheck。禁止全仓/全包本地测试。全套证据只能来自 exact-head CI OK。

初查 literal audit_tmux_qa_residue_read_only 命中 3 个脚本测试；barrier 命中 scripts/test-restart-services.sh 与 restart-services-no-voice-bridge；helper 命中 tmux-server-rescue-lock。路径匹配另有 migration、packaging、shuttle 相关测试，不能现在预先排为无关；实现 diff 后逐项判断。

## 迁移、回滚、安全与风险

无 DB migration、无新后台任务、无新权限、无账户/provider 操作。匿名临时文件不得在失败时泄露敏感输出到另一个日志通道，只回放原调用方原有 stdout/stderr。报告以 textContent/value 写入用户评论，模板插值全部 HTML escape。

回滚通过标准 PR/ship 流程回退本单提交，下一班 updater 生效；不手动 reset 生产。回退会重新引入坏协议审计和同步 barrier，应在回滚说明中明示。共享 helper 变化需先通过锁与输出回归，不能只靠 restart 绿。

取舍：仍同步核对全部窗口，但代码账本与普通派工先恢复；锁会等有限诊断。修复重复采样根因并保留必要收敛重试，不能承诺所有cmux性能问题解决。R1的7/17覆盖缺口已撤回，所有visible合同与retry marker保留；退役陌生socket保留名告警，无替代告警。

## 交接门

提交并 push exploration/research/plan、证据与 founder HTML；设计 review 的有效结构化 verdict 必须 APPROVED。发布 HTML --publish-only，验证 HTTP 200、nonce/CSP、评论交互，再 ask --report 送实际 Lead。执行 complete --route phase_design_complete，然后 park；实现与 QA 由 DAG 调度。本节点不宣称问题已生产修复。
