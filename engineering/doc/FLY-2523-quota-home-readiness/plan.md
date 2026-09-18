# FLY-2523 自动收尾与额度就绪 — 实施计划
Issue: FLY-2523 (https://linear.app/geoforge3d/issue/FLY-2523/部署-codex-额度自动切号子系统在宿主上收尾生成-readiness-receiptjsonapproved-homes-清单)
日期: 2026-09-17
基于: exploration.md, research.md

## 1. 交付合同

设计节点限定文档、审查、HTML、提交推送与交接。以下是 implement/QA 工作，不表示已执行。以 2026-09-18 05:53Z founder 裁定为准，不再等人寻找安静窗口。无新 launchd、cron、interval；不改变 R1–R5 或额度引擎决策，不登录、不写 founder canonical auth，不自动恢复被人关闭的 flag。

验收全链：五家 approved inventory → safe anytime attempt → durable done/already-satisfied receipts → deadline alert → fresh topology + real readiness checker → 一次受控 flag activation → isolated usage-limit incident 的 target_profile 与恢复证据。缺任一项仍未完成。

## 2. 固定输入、身份与状态模型

在 repo 新增 `scripts/config/codex-quota-home-policy.json`，固定两条 Runner project/role（flywheel/eng_design、flywheel/implement），Lead 部分从受信任 projects.json 中 backend=codex-app-server 的已注册身份派生，并逐个调用 resident-codex-lead-recover --authority 解析 home。只纳入宿主存在且通过普通目录/注册身份验证的home；registered却缺失或authority失败必须fail loud，不能静默过滤后生成看似完整的清单。当前为以下五家。materializer 生成 `~/.flywheel/codex-quota/approved-homes.json` 的 `{home,ownership}[]` 给旧receipt脚本。新Lead纳入只能由已生效注册表授权，未知live home禁止自动收编并立即工程告警；删除entry必须确认无process/lease，未知不丢弃旧obligation。每次inventory改变计算新digest；未完成旧home保留原enrolledAt，新home记录注册/首次发现时间，重启不重置。新digest要求重新观察所有homes以取得当前digest回执，不能复用旧批准文件。拒绝../、symlink祖先、重复home/身份、非普通目录和未知backend。
| id（固定机器键） | user-root relative path | owner identity |
|---|---|---|
| flywheel/eng_design | .flywheel/codex-homes/agents/flywheel/eng_design | marker.project=flywheel, role=eng_design |
| flywheel/implement | .flywheel/codex-homes/agents/flywheel/implement | marker.project=flywheel, role=implement |
| flywheel/codex-infra-bot-lead | .codex-infra-bot | resident-codex-lead-recover --project flywheel --lead codex-infra-bot-lead --authority |
| growth/mufasa-lead | .codex-mufasa | 同入口，project=growth, lead=mufasa-lead |
| raya/raya | .codex-raya | 同入口，project=raya, lead=raya |

每次处理 Lead 先比对 authority 返回的 codexHome，不能从 basename 或显示名推身份。independent 不作为默认修复方式；若后续真有独立账号授权，另变更 inventory 并重新走审查/独立 chain 验证。

控制状态放 `~/.flywheel/codex-quota/home-migration/`，0700，文件0600，plain/no-follow，原子替换+fsync。与所有 home、canonical auth、backups 分离。配置 `schemaVersion=1, enrolledAt, overdueDays=1, inventoryDigest, homes`；N 可配置整数1–30，错误值拒绝并告警而非禁用监控。enrolledAt 由首部署固化，重启/重试/升级不重置；本次迁移可保存可信旧 pending 时间作为更早基线（implement 原记录 2026-09-11T17:58:38Z；部署时核实）。缺配置或 corrupt 状态视为控制面损坏并立即告警，不能以 now 重建导致永远不过期。

每次 per-home attempt 原子写一条 `attempts/<attemptId>.json`，UUID 标识，至少包含：

```json
{"schemaVersion":1,"attemptId":"uuid","at":"ISO UTC","homeId":"flywheel/implement","home":"absolute path","inventoryDigest":"sha256","source":"health|updater|restart-window|manual","buildSha":"deployed 40hex","result":"done|skipped|already-satisfied|failed","reason":"closed enum","satisfied":false,"backupRef":null,"postcondition":null}
```

reason 枚举：active_process、active_lease、lock_busy、process_unknown、lead_authority_unknown、launch_fence_unavailable、unsafe_path、backup_failed、mutation_failed、durability_uncertain、receipt_failed、linked、marker_cleared、canonical_link_verified。结果不含 token、auth hash、环境全文。backupRef 是受限本地相对位置，不把备份内容/路径发到公开报告。

所有结果保留；最新一次 skipped 不删除先前满足证据。但 activation 只接受同 inventoryDigest 下的 done/already-satisfied、satisfied=true、durable receipt，加上当场五家文件拓扑重查。任一失败/漂移使其不能单凭历史通过。状态丢失不能用现有 symlink 伪造旧 done；下一次安全观察只能生成新的 already-satisfied。

## 3. 安全单次操作

新增 `scripts/codex-home-reconcile.mjs`（参数 `--approved-homes --state-root --source [--home-id]`）和可测试核心 `packages/claude-runner/src/codex-home-reconcile.ts`。wrapper 必须经 `scripts/codex-home-link-truth.sh --keep-backup` 的安全入口完成实际迁移；不另写 cp/rm/ln 替代底层。扩展 helper 的结构化 JSON 输出以传回准确 backupRef 与 postcondition，不解析自由文本。原 CLI 保持兼容。

算法：

```text
validate config and exact approved target with read-only lstat
reserve external durable attempt record (failure => no home mutation)
readonly canonical-link + no-marker + identity observation
  if fully satisfied: already-satisfied receipt only, even if active (no home writes)
readonly process + lease preflight for any required mutation; busy/unknown => skipped
acquire target admission mutex outside target home, bounded/nonblocking
  revalidate directory/marker/Lead identity and live processes under mutex
  any active lease/process (including caller ancestors) => skipped
  unknown process environment / ambiguous HOME / failed ps => skipped
  Lead: require launch lifecycle fence, authoritative job/process state
  if canonical symlink AND no pending marker: already-satisfied
  else invoke existing migration core with keepBackup=true under same fence
    regular original auth => exclusive durable backup BEFORE replacement
    canonical symlink + pending => only clear pending; no duplicate backup
    wrong symlink / unsafe object => failed, do not follow/write foreign target
  verify exact canonical target, no pending, directory durability
  persist durable done receipt before releasing fence
finally release only own mutex, finish external attempt receipt
```

“busy零写入”包含文件内容、mtime、ctime、mode、目录清单；允许外置 attempt/control lock 写入，目标 home 与备份区不得发生 chmod/mkdir。把 `assertHomeIsPlainDirectory` 的 read-only validation 与 provision 创建/chmod 拆开；reconcile 不调用 provision validator。活动 lease 即使 ps 为空也不删。process 查询必须匹配真实 Codex executable、规范绝对 CODEX_HOME；未知 Codex home 不解释成 idle；不把扫描自身或 shell 的命令字符串当 Codex。PID 复用用 start identity；证据异常 fail closed。

**Managed homes：**复用 `prepareCodexAgentHomeLock` / `withMkdirLock` 的现有 `agents/<project>/.locks/<role>`。把锁内操作提取成内部函数，避免 wrapper→helper 重入同一锁。正常 launch admission 在该锁内先持久化 lease 再启动；migration 在该锁内查 leases + process 并写回执。新增测试把 launch 插在初查和锁获取之间，必须拒绝迁移。

**Lead homes：**单独 ps 检测不消除 launch 竞争。新增外置每-home credential admission mutex，key=规范 home 的 SHA256，位于 `home-migration/lead-fences/`。复用现有 mkdir-lock/PID-start ownership 的机制，不发明锁抢占；全量接入支持的 Codex Lead child 启动入口：`packages/teamlead/src/lead-backends/codex/codex-lead-tui-runtime.ts`、`packages/teamlead/scripts/codex-lead-tui-home.sh` 的 ensure-daemon，以及 `scripts/resident-codex-lead-recover.sh`、`scripts/flywheel-lead.sh` 的启动路径。启动 under mutex 写外置 lease 再启动 child；lease 绑定 PID+start/owner generation，子进程退出或权威证明不存在才清理；未知/启动中 lease 不偷删。持锁迁移检验 lease 和全部 process，launch 不能越过迁移。启动失败只回收自身 lease。先部署并验证 fence 覆盖，再开启 Lead mutation；旧进程、旧启动器无法证明覆盖则跳过 launch_fence_unavailable，并按时告警。不添加新的自启任务。

已满足且active的Lead可只读记录already-satisfied（Lead问题83649a39最新裁定）；活跃且需要改变任何home内容/元数据时必须skipped。只读成功分支不调用link-truth/provision/chmod，回执明确activity=active及mutation=false。

Lead 首选实际 restart window：`restart-services.sh` 的 `lead_restart_wait_quiescent` 与 `lead_body_hard_clear` 后、controlled-wave arm/bootstrap 前调用一次，仍检查 same-home fence。任一 query/launchctl error 不当 unloaded。小时/手工调用也用同一 fence，空闲且 fence 覆盖完整可执行，不必等待全舰队空闲。普通 raw Codex 可被 census 检出；不支持绕过所有 Flywheel 启动入口的恶意并发写入，不以两次 ps 声称对恶意同 UID 进程有安全隔离。

备份或 fsync 失败不生成满足证据。auth 已换而 marker/receipt 失败，记 failed/uncertain；下轮重查可收敛，不重复覆盖原备份。使用 attempt intent 关联原始 backup，崩溃后不拿新的 canonical 内容伪装原始副本。崩溃在最终 receipt 前，激活失败，下一次重试留新的完整证据。禁止自动 --unlink 或恢复备份覆盖当前 auth。

## 4. 接入已有节律，避免再忘

1. `bridge/plugin.ts` 现有 `onHealthTick` 与 boot 检查并列调用 reconcile；复用 GatePoller health cadence，不创建 timer。单进程 single-flight，跨进程外置 locks；有限时子进程（每轮最多30秒，逐家处理，忙即退出），不 await 慢操作阻塞 GatePoller。无 quota flag 依赖——flag off 正是需要修复的状态。
2. `scripts/update-flywheel.sh:updater_run_launchd_then_cycle` 调同一 reconcile + deadline checker，放在 fetch/deploy/current return 之前。即使当天没有新代码，检查照跑。失败记收据/告警，不改变现有班车成败或自动加重启。
3. `scripts/restart-services.sh` build 成功后、Bridge restart 前做 managed bounded attempt；每席 Codex Lead 在上述真实停机点做 targeted attempt。后续正常启动恢复仍由既有 restart 控制。机制不为迁移强停任何活进程，不抢外来 admission pause。
4. 同一操作两个触发重叠：跨进程锁保护，第二次写 skipped/lock_busy；不能重复 backup/link。standalone updater 不依赖 Bridge 在线才能留证或告警。

## 5. 超时必须实际发到工程频道

deadline 以 config.enrolledAt（或可信更早 pendingAt）为基准，不以最后一次尝试刷新；`now >= dueAt && !currentSatisfied`，含完全没有 attempt/receipt 的 home。首次部署就加载固定五家 obligation，因此“从没调用”也会被监控发现。N=1天默认，首次符合条件的下一个既有 cadence 触发；正常 Bridge 时最多约1小时延迟，Bridge 不在线由 updater 0/12点兜底。所有 cadence 均死时不声称能自我通知，沿用现有宿主监控。

新增告警 kind `codex_home_migration_overdue`，同步 `LeadAlertNotifier.ts`、shell allowlist 与 kind-contract。调用既有 `lead-alert.sh --lead flywheel-eng-lead --project flywheel --kind codex_home_migration_overdue --severity severe --strict-delivery`。**专用 kind 的 destination 从受信任 projects.json 中 flywheel/flywheel-eng-lead 的工程 alertChannel 解析并校验；不接受 caller 任意 channel，不让全局 unified override 悄悄改道。** 本轮配置观察该字段为1516209714097291335，值不是代码常量；QA 必须核实它仍是工程目的频道。未知/重复 Lead、无 channel 为 config_error，不退回 general/core 冒充送达。

扩展该 kind 的 deliveryChannelId 持久化与 queue drain，使重试仍发同一工程目的地。复用既有 sender 身份、HTTP、claims、重试队列与 meta-alert fallback，不新建告警调度器。dedupe signature=`inventoryDigest:homeId:dueAt:UTC-day`，每日重复直到满足。内容逐项列出全部未满足 home、逾期天数、最后原因、最近尝试时间、issue，以及该 home 的精确安全修复命令：`node /Users/xiaorongli/Dev/flywheel/scripts/codex-home-reconcile.mjs --approved-homes /Users/xiaorongli/.flywheel/codex-quota/approved-homes.json --state-root /Users/xiaorongli/.flywheel --source manual --home-id <精确id>`。实参由可信配置构建，正确shell引用，不拼接自由文本；命令仍会在忙时跳过，绝不是强制覆盖。不含账号秘密。

`sent` + transport message id 才是送达；duplicate 只关联先前实际 sent/queued 状态，不能凭 exit 0 写 delivered。queued_transient 记 pendingDelivery 并由已有 queue drain 恢复；dead_lettered/config_error 触发现有 meta-alert 并在下一 cadence 重试，不清 obligation。新 kind 的 strict 输出补充 message id，与既有返回兼容。告警发生与迁移成功是不同账，不用发告警代替完成迁移。

## 6. Receipt 与 flag 激活

五家满足后封装现有生成器，不另造 schema：

```sh
node scripts/codex-quota-readiness-receipt.mjs   --approved-homes "$FLY2523_APPROVED_ABSOLUTE_JSON"   --canonical-home /Users/xiaorongli/.codex   --state-root /Users/xiaorongli/.flywheel   --build-sha "$FLY2523_DEPLOYED_SHA"
```

`FLY2523_DEPLOYED_SHA` 来自部署证据且与本次实际加载构建一致，不能用 feature HEAD 冒充。output 必须是 `~/.flywheel/codex-quota/readiness-receipt.json`，禁止双层 codex-quota。生成前校验全部 migration receipts 的 digest+postcondition；生成器仍对 managed home 的当前 symlink+pending 作检查。失败不替换旧有效 receipt；旧 receipt 不能覆盖当前 failed topology。

新增只读 `scripts/codex-quota-readiness-check.mjs`，复用 `checkCodexQuotaReadiness` + 与 bridge/plugin 同源 host collector options（提取窄工厂避免两套配置），输出 ready/failures、inventoryDigest、deployedSha、checkedAt。不得用 `CodexQuotaRuntime.readiness()` 做 flag-off 预检，它会因 flag off 恒为 false。不得用日志“没有报错”代替 JSON ready=true。发现其它 active home/未知 authority 时保留失败，报告 Lead，不扩 inventory。

提供一次 activation wrapper `scripts/codex-quota-activate.mjs`：与 reconcile 的状态锁串行；重新检查五家满足证据、symlink+无 marker、真实 checker ready、build identity；读取当前 flag scope/revision，记录 before；再调用既有 feature flag 正式写入口（不直接 SQL）。必须在该写入口针对 codex_quota_auto_switch 的 off→on 分支也执行同一个前置检查，覆盖 CLI/UI/API，不让裸 set 绕过“只有所有 home 满足才可开”。读取/检查与实际 set 在串行 activation 事务内，若 revision 变化则拒绝、重新读取，不覆盖新的 kill-switch 决定。任何周期检查都不自动 set on。

后续部署者命令语法以当前 CLI 为准：`node "$FLYWHEEL_COMM_CLI" feature-flags set --name codex_quota_auto_switch --to on --project '*' --reason 'FLY-2523 receipts and readiness verified'`；只有上段守卫通过才能生效。设计节点不执行。

## 7. 实施拆分与红绿验证

每任务先提交针对反例的 failing test，确认失败归因于缺失行为，再最小实现、聚焦回归、独立 commit。不要在本设计节点运行实现。

### T1 — inventory、时钟与 receipts

新增 config、`codex-home-reconcile.ts` 与 `test/codex-home-reconcile.test.ts`，导出纯 `isOverdue(enrolledAt,days,now,satisfied)` 和 receipt validator。外置路径拒绝 symlink，atomic+fsync，manifest 规范排序 digest。

测试伪代码合同：
```ts
expect(isOverdue(start, 1, start + 86400000, false)).toBe(true);
expect(isOverdue(start, 1, start + 86399999, false)).toBe(false);
expect(isOverdue(start, 1, start + 86400000, true)).toBe(false);
expect(validateReceipt({ ...valid, inventoryDigest: other })).toEqual(false);
```
覆盖无 receipt、全新未尝试、重启不改 enrolledAt、corrupt config、恶意路径、同路径身份变化、账本写失败。命令 `pnpm --filter flywheel-claude-runner exec vitest run test/codex-home-reconcile.test.ts`（先核 package name，仓库使用 flywheel-claude-runner）。

### T2 — 安全操作与底层修复

改 codex-home.ts、index.ts、bin/flywheel-codex-link-truth.mjs、scripts/codex-home-link-truth.sh；新 CLI wrapper。保留旧入口语义，仅安全收窄及 pending 修复。测试先拍 home 递归 lstat (inode/mode/mtime/ctime)、目录项、auth/pending bytes 和 backup count，调用真实核心再比对。

硬红：active fixture→skipped reason=active_process，全部 home 快照不变；caller ancestor→同样拒绝；lease活跃/进程采集失败→零 chmod；idle copy→done、原字节0600备份、symlink正确、pending消失；第二次→already-satisfied，home元数据与backup count不变；正确link+pending→done marker_cleared；wrong link→失败且foreign target不变；并发双调用只有一次迁移；写入中断/fsync失败不能 satisfied。

执行 `bash scripts/__tests__/codex-home-link-truth.test.sh`、`bash scripts/__tests__/codex-credential-cutover.test.sh`、`pnpm --filter flywheel-claude-runner exec vitest run test/codex-home.test.ts test/codex-home-reconcile.test.ts`。新增 shell reconcile suite 调真实入口而非只测纯 classifier。

### T3 — Lead launch fence 与节律

新增 `packages/teamlead/src/codex-home-launch-fence.ts`，将 TS 与 shell launcher 共同调用的窄 CLI 放 `scripts/codex-home-launch-fence.mjs`；接入第3节所有真实子进程启动 consumer。先用 barrier 测试 pause 在 spawn 前，另一进程 reconcile 必须 skipped，反向持 migration mutex 时启动不得 spawn。旧启动覆盖未知必须 skipped，不放行。

修改 bridge/plugin.ts health callback、update-flywheel.sh、restart-services.sh；可提取 `scripts/lib/codex-home-reconcile.sh` 保持主脚本薄。新集成测试 `scripts/__tests__/codex-home-reconcile-cadence.test.sh`，验证 updater current/fetch-failed、Bridge health、Lead quiescence失败/成功、 detached Codex 仍活时、原流程恢复。不执行真实 launchctl，夹具 stub 显式记录 call order。运行相关 updater-trigger-policy、lead lifecycle 与 codex home launcher regression。

### T4 — 工程频道逾期告警

修改 lead-alert.sh + LeadAlertNotifier kind + queue destination consumer，新增 `scripts/__tests__/codex-home-migration-alert.test.sh`。使用 fixture projects/clock/claims/queue 与本地 HTTP接收器跑真实 shell sender：到N天恰收到一次对应工程 channel 的 POST；未到/已满足=零次；无任何 receipt 也会发。全局 unified channel 设置成另一个 fixture ID，仍必须工程 channel。429/5xx→queued且drain恢复到原目的地；403/config坏→不记sent，有failure与fallback；duplicate不能伪造送达。

**变异测试硬红**：在隔离源码副本把 `now >= dueAt` 变为永假（及 satisfied 取反），运行同一“无回执逾期”integration test必须失败，因为本地接收器POST数=0；保留变异diff、原pass与变异fail输出，不在主工作树遗留变异。测试不是仅 spy `.notify()`。

### T5 — ready与activation守卫

新增 check/activate wrappers，提取 collector options 单源，`packages/teamlead/src/bridge/flag-routes.ts` apply-requested之前的off→on守卫及`src/__tests__/flag-routes.test.ts` tests。复用 readiness-receipt.test.sh；新增 missing-one receipt、old digest、pending残留、unapproved active home、unknown comm、错误build、wrong state root、flag revision冲突、kill-switch随后关回不重开。真实 checker+fixture collector，不能 stub ready=true 来证明完整路径。运行 teamlead 的 host-readiness、codex-quota-readiness、runtime、feature-flag 聚焦 suites。

### T6 — 交接与生产验收（后续节点）

PR静态证据 `git diff --name-status <base>...HEAD`：无新增 launchd plist、crontab、timer；`rg -n 'codex.home.reconcile|home.migration' scripts/update-flywheel.sh scripts/restart-services.sh packages/teamlead/src/bridge/plugin.ts`；源码扫描加 cadence call-order tests 共同证明。所有不相关生产目录未变。

授权部署后依次收集：实际deployed SHA；固定五家归属；每家done/already回执（活跃则正常skip并等自动机会）；原auth备份的受限验证结果；marker清零；真实readiness JSON ready=true；flag before/off→after/on 的scope+revision审计。不要因持续活跃阻断监控或忘掉 obligation。

隔离 usage-limit 证据：运行同 deployed 模块的隔离 Bridge/StateStore、fixture canonical+pool+homes，注入唯一 test execution/root 的 usage-limit signal，经真实 ingest/coordinator→target_profile→install到fixture canonical→recover 流程，断言 incident 恢复及只重启隔离 execution；stub外部 transport 可替代真实登录，标注 fixture，不能声称生产已经自动切过账号。为生产开关有效性另收集 live consumer enabled/readiness 的只读结果。若现有入口不能做到不污染生产root，禁止向生产发合成事件，先完成隔离 harness；任务验收用用户允许的隔离信号，不动 founder 登录态。动态验收必须再证明相关 home daemon PID/start identity 换代、新进程实际读到目标账户的非秘密身份，并且一次后续请求成功。不能只看 target_profile 或 incident settled。Lead daemon 仅允许通过 `CODEX_HOME=<隔离home> codex remote-control stop --json` + 既有 supervisor ensure-daemon；Lead 进程、thread、窗口身份必须保持。不要把手工执行此命令补齐探针称为自动链已完成。若现有自动链缺少这一步，标明失败依赖并报 Lead 另开单，禁止在2523增加该恢复实现。PR同时贴生产配置证据与隔离动态证明，不能混写。

生产预检若实际存在超出五家live home或其它authority失败，报告精确阻碍，flag保持off；不得缩scope/伪造清单。完成真实验收前不报“自动切号已恢复”。

## 8. 回滚、失败与观测

默认迁移开、flag保持原值。reconcile出错不阻断现有launch/restart（启动仍遵循原安全门），但不产生满足证据；告警独立。停止新自动迁移可通过机制配置 enabled=false（仍监控未完成obligation）；不会自动unlink已迁移home。flag出问题走现有正式off路径并记录revision，不被周期任务翻回。需要恢复原copy必须另有授权且home drained，备份仅恢复该home，绝不写~/.codex/auth.json。

每次尝试有外置证据，缺 receipt 超期照样告警。不可写控制目录时 stderr + 现有meta alert，禁止继续home mutation；磁盘故障时不声称能保证持久回执。bounded子进程超时先停止并确认退出，不能释放互斥后让旧child继续写；crash recovery用owner PID+start identity验证，未知不抢锁。

## 9. 要求对照与设计状态

| 用户硬红 | 证明来源 |
|---|---|
| active fixture零写入+skipped reason | T2递归元数据/字节快照+祖先/lease反例 |
| idle备份link清marker；重复无home写 | T2真实CLI与backup计数 |
| 缺receipt超过N天告警真发+变异红 | T4真实sender到本地HTTP+变异输出；生产目的channel验收 |
| 无新增launchd/cron | T3/T6 diff与既有cadence调用trace |
| 全五家满足→真实ready→flag→隔离incident恢复 | T5守卫与T6生产/隔离分列证据 |
| founder登录态不动、先备份 | T2 canonical快照、T6操作审计 |

effective reviewVerdict、审查questionId、最终HTML URL与发布核验放 progress.md / design-review.md，不能以本文自称批准。剩余部署与实现明确由后续阶段完成。

## 10. Lead 补充约束（问题 e451c20d 回复）

问题83649a39-783b-4b54-93d0-3dacd7fdd7cf已由Lead明确扩到五家，优先注册表派生。已逐一查询本机注册表、Runner marker以及Lead authority，全部有对应身份，详见research。当前五家managed；N=1天与state-root修正已获确认。旧四家上限被更新裁定取代，不是自动批准野生home。

共享 symlink 是双向的：daemon 的 OAuth 刷新会写穿到 canonical 凭据，对受管舰队是有意的单一真相源。必须写进manifest的说明与运维文档；测试slot绝不可链接真实canonical（FLY-2716），fixture canonical只可位于隔离临时根。迁移操作本身不写canonical，不能因此宣传以后daemon也不写。
