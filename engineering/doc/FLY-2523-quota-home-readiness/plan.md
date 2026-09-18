# FLY-2523 自动收尾与额度就绪 — 实施计划
Issue: FLY-2523 (https://linear.app/geoforge3d/issue/FLY-2523/部署-codex-额度自动切号子系统在宿主上收尾生成-readiness-receiptjsonapproved-homes-清单)
日期: 2026-09-17
基于: exploration.md, research.md

## 1. 交付合同

设计节点限定文档、审查、HTML、提交推送与交接。以下是 implement/QA 工作，不表示已执行。以 2026-09-18 05:53Z founder 裁定为准，不再等人寻找安静窗口。无新 launchd、cron、interval；不改变 R1–R5 或额度引擎决策，不登录、不写 founder canonical auth，不自动恢复被人关闭的 flag。

验收分为可独立交付的机制与跨单恢复依赖，两者不混称DONE：

- **机制交付判据**：注册派生inventory、safe anytime attempt、持久done/already-satisfied回执、逾期真实告警、全部home真实拓扑+同digest回执+真实readiness checker、正式activation守卫和反例测试均通过。implement可提交机制交付证据；设计节点的DONE只指审查批准、HTML交付、文档提交及phase_design_complete，不表示生产目标完成。
- **完整issue端到端判据**：在FLY-2729部署/独立验收后，才执行受控flag activation和isolated usage-limit恢复验证（包含daemon换代及新token生效）。FLY-2729 pending时，明确记录activation/recovery为dependency-pending并保持off，交接后持续保留该验收项；不得把它删掉或把机制交付写成全单生产DONE。FLY-2729不是唯一条件：还必须解决R1指出的roster分叉、无lease resident绑定和未知桌面reader；只有全部前置证据满足才可继续，详见§13。readiness ready=true只是必要条件，必须与全部home的当场拓扑和同digest满足回执共同通过。

## 2. 固定输入、身份与状态模型

在 repo 新增 `scripts/config/codex-quota-home-policy.json`，固定两条 Runner project/role（flywheel/eng_design、flywheel/implement），Lead 部分与真实readiness collector共享新增的 `packages/teamlead/src/codex-quota/credential-home-roster.ts` 中 `resolveCodexCredentialHomeRoster(projects, authority)`；它从受信任 projects.json 中 backend=codex-app-server 的已注册身份派生，并逐个调用 resident-codex-lead-recover --authority 解析 home。只纳入宿主存在且通过普通目录/注册身份验证的home；registered却缺失或authority失败必须fail loud，不能静默过滤后生成看似完整的清单。当前为以下五家。materializer 生成 `~/.flywheel/codex-quota/approved-homes.json` 的 `{home,ownership}[]` 给旧receipt脚本。新Lead纳入只能由已生效注册表授权，未知live home禁止自动收编并立即工程告警；删除entry必须确认无process/lease，未知不丢弃旧obligation。每次inventory改变计算新digest；未完成旧home保留原enrolledAt，新home记录注册/首次发现时间，重启不重置。新digest要求重新观察所有homes以取得当前digest回执，不能复用旧批准文件。拒绝../、symlink祖先、重复home/身份、非普通目录和未知backend。
| id（固定机器键） | user-root relative path | owner identity |
|---|---|---|
| flywheel/eng_design | .flywheel/codex-homes/agents/flywheel/eng_design | marker.project=flywheel, role=eng_design |
| flywheel/implement | .flywheel/codex-homes/agents/flywheel/implement | marker.project=flywheel, role=implement |
| flywheel/codex-infra-bot-lead | .codex-infra-bot | resident-codex-lead-recover --project flywheel --lead codex-infra-bot-lead --authority |
| growth/mufasa-lead | .codex-mufasa | 同入口，project=growth, lead=mufasa-lead |
| raya/raya | .codex-raya | 同入口，project=raya, lead=raya |

新credential-home roster只描述凭据归属，明确不使用codexResidencyPatrol/canSpawnRunners/companion作为名册筛选条件。`findResidentCodexLeadTargets`继续只供原resident巡检使用，不扩该巡检到Raya。修改bridge/plugin.ts的quota collector装配和materializer，使两者从同一个resolver结果取得完全相同的Lead tuple/home集合；resolver一次失败两边都fail closed。T5用Raya缺codexResidencyPatrol且authority可验证的fixture，断言派生Lead集合等于collector leadTargets，Raya active无Runner lease仍按Lead规则校验。

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

1. `bridge/plugin.ts` 现有 `onHealthTick` 的底层节拍实际为3000ms×20，约每60秒；不是每小时。新增同一callback内的独立 `maybeReconcileCodexHomes()`，持久lastAttemptStartedAt节流为3600秒，boot读同一timestamp，不因重启重置。30秒重复tick、并发boot、进程重启都不能额外启动；due告警用同一轮。updater/restart-window显式机会可以提前调用，仍受跨进程互斥；它们更新lastAttemptStartedAt避免紧接health重复。独立挂载此callback，不受codexHealthEnabled=!VITEST门控；原有reportCodexGlobalHealth继续保持自己的门控。测试注入clock/fixture collector，不能VITEST下意外触达生产。复用GatePoller节拍，不创建timer。单进程 single-flight，跨进程外置 locks；有限时子进程（每轮最多30秒，逐家处理，忙即退出），不 await 慢操作阻塞 GatePoller。无 quota flag 依赖——flag off 正是需要修复的状态。
2. `scripts/update-flywheel.sh:updater_run_launchd_then_cycle` 调同一 reconcile + deadline checker，放在 fetch/deploy/current return 之前。即使当天没有新代码，检查照跑。失败记收据/告警，不改变现有班车成败或自动加重启。
3. `scripts/restart-services.sh` build 成功后、Bridge restart 前做 managed bounded attempt；每席 Codex Lead 在上述真实停机点做 targeted attempt。后续正常启动恢复仍由既有 restart 控制。机制不为迁移强停任何活进程，不抢外来 admission pause。
4. 同一操作两个触发重叠：跨进程锁保护，第二次写 skipped/lock_busy；不能重复 backup/link。standalone updater 不依赖 Bridge 在线才能留证或告警。

## 5. 超时必须实际发到工程频道

deadline 以 config.enrolledAt（或可信更早 pendingAt）为基准，不以最后一次尝试刷新；`now >= dueAt && !currentSatisfied`，含完全没有 attempt/receipt 的 home。首次部署就加载当前派生清单的全部 obligation，因此“从没调用”也会被监控发现。N=1天默认，首次符合条件的下一个既有 cadence 触发；正常 Bridge 时最多约1小时延迟，Bridge 不在线由 updater 0/12点兜底。所有 cadence 均死时不声称能自我通知，沿用现有宿主监控。

新增告警 kind `codex_home_migration_overdue`，同步 `LeadAlertNotifier.ts`、shell allowlist 与 kind-contract。调用既有 `lead-alert.sh --lead flywheel-eng-lead --project flywheel --kind codex_home_migration_overdue --severity severe --strict-delivery`。**专用 kind 的 destination 从受信任 projects.json 中 flywheel/flywheel-eng-lead 的工程 alertChannel 解析并校验；不接受 caller 任意 channel，不让全局 unified override 悄悄改道。** 本轮配置观察该字段为1516209714097291335，值不是代码常量；QA 必须核实它仍是工程目的频道。未知/重复 Lead、无 channel 为 config_error，不退回 general/core 冒充送达。

扩展该 kind 的 deliveryChannelId 持久化与 queue drain，使重试仍发同一工程目的地。复用既有 sender 身份、HTTP、claims、重试队列与 meta-alert fallback，不新建告警调度器。dedupe signature=`inventoryDigest:homeId:dueAt:UTC-day`，每日重复直到满足。内容逐项列出全部未满足 home、逾期天数、最后原因、最近尝试时间、issue，以及该 home 的精确安全修复命令：`node /Users/xiaorongli/Dev/flywheel/scripts/codex-home-reconcile.mjs --approved-homes /Users/xiaorongli/.flywheel/codex-quota/approved-homes.json --state-root /Users/xiaorongli/.flywheel --source manual --home-id <精确id>`。实参由可信配置构建，正确shell引用，不拼接自由文本；命令仍会在忙时跳过，绝不是强制覆盖。不含账号秘密。

`sent` + transport message id 才是送达；duplicate 只关联先前实际 sent/queued 状态，不能凭 exit 0 写 delivered。queued_transient 记 pendingDelivery 并由已有 queue drain 恢复；dead_lettered/config_error 触发现有 meta-alert 并在下一 cadence 重试，不清 obligation。新 kind 的 strict 输出补充 message id，与既有返回兼容。告警发生与迁移成功是不同账，不用发告警代替完成迁移。

## 6. Receipt 与 flag 激活

**硬红：FLY-2729 未落地并证明相关 daemon 重载新 token 生效之前，codex_quota_auto_switch 必须保持 off。** 这是Lead对问题5b425684-55e5-42db-a2c9-90727afed7ec回复新增的正式前置条件。FLY-2523可以交付迁移/回执/告警及设计阶段，但不能把这些当作激活许可。

activation守卫新增 `daemonRecoveryDependencyReady`：从现有deployment_events取得FLY-2729对应merge SHA，验证当前实际deployed SHA包含该提交，且引用下述被独立QA正式提交并绑定tested head的daemon换代+新凭据后续请求成功证据；缺失、失败、陈旧构建或仅issue状态为Done均拒绝`dependency_not_ready:FLY-2729`。不接受命令行boolean或自然语言“已落地”覆盖。使用现有部署/QA证据读取入口，若没有可验证证据则保持off并报告，不在本单重写2729实现。证据合同由2729 QA生产、2523只消费，不能自行造成功回执：不可变JSON存于 `~/.flywheel/state/qa-evidence/FLY-2729/<testedHeadSha>/<sha256>.json`，file<=64KiB、0600、目录0700、禁止symlink/路径逃逸。schemaVersion=1，issueId=FLY-2729，testedHeadSha，qaExecutionId，observedAt，scenario=isolated_usage_limit，homes数组（homeId、daemonBefore/After的pid+startIdentity、targetAccountKey的非秘密标识、requestAfterReload.ok=true与requestId、leadPidUnchanged=true、threadUnchanged=true、windowUnchanged=true），result=PASS；全字段严格验证，daemon before/after不能相同。对应引擎接受的 `workflow_claims` 行必须predicate=qa_passed、subject_kind=git_head、subject_digest=testedHeadSha、issuer_execution_id=qaExecutionId，evidence.summary含精确机器标记 `FLY2729_DAEMON_EVIDENCE sha256=<digest> path=<bounded absolute path>`。读取并哈希文件，再和正式claim绑定比对；只有文件、只有PASS或只有issue Done都不够。使用正式PR/land证据连接QA testedHeadSha与merge SHA（squash不能假设祖先）；部署账本连接merge与deployed SHA。缺映射拒绝，不拿git当前branch猜。该生产合同已报Lead送2729执行；若2729未交此证据，保持off。

该检查和home/readiness检查一起在正式flag off→on入口执行，任何UI/CLI同门；off操作永远不受此依赖阻断。

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

inventoryDigest必须与现有生成器/collector逐字相同：`sha256(JSON.stringify(homes.map(({home,ownership})=>({home,ownership})).sort((a,b)=>a.home.localeCompare(b.home))))`。id、enrolledAt、owner与checkedAt全部排除；抽出同一导出函数给materializer/reconcile/receipt/collector使用，不引入第二个同名digest。跨实现测试用乱序、非ASCII绝对路径、额外metadata，断言三者digest完全一致。

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

修改 bridge/plugin.ts health callback、update-flywheel.sh、restart-services.sh；可提取 `scripts/lib/codex-home-reconcile.sh` 保持主脚本薄。现有bounded-run.sh不能证明后代已退出：direct child退出会提前杀watchdog，KILL步可能不运行，因此不直接当安全fence。新增本机制私有的 `scripts/lib/codex-home-reconcile-process.mjs` 一次性子进程管理器（不是scheduler），总预算30秒：spawn独立process group，保存PID/start identity与受控子进程集合；25秒发TERM、1秒后由父管理器独立发KILL（不随direct-child exit取消），余下4秒检查PGID为空、已记录PID/start全部dead；超时/无法确认产生exit_unproven并保持fence。进程逃逸新session/身份无法证明视为exit_unproven，不能正常释放。正常退出也执行后代检查。调用点用该管理器包住30秒总预算（包含child退出确认），显式捕获退出码：`if ! bounded_reconcile_attempt; then record_reconcile_failure_and_alert; fi`，语义等价有日志的`|| true`，不得让set -e吞掉后面的controlled-wave arm/bootstrap。T3硬红新增：helper非零、抛错、超时、child收到TERM不退出需KILL；确认child PID/start已终止且自有锁释放后，原arm+bootstrap恰执行一次。若连KILL后也不能确认child退出，保持迁移fence、报警并走既有restart失败恢复门，不可一边允许旧child写一边启动新daemon；不能把此不可证明状态伪称“正常恢复”。这属于安全失败的显式异常而非静默挂死。

新集成测试 `scripts/__tests__/codex-home-reconcile-cadence.test.sh`，验证 updater current/fetch-failed、Bridge health、Lead quiescence失败/成功、 detached Codex 仍活时、原流程恢复。不执行真实 launchctl，夹具 stub 显式记录 call order。运行相关 updater-trigger-policy、lead lifecycle 与 codex home launcher regression。

### T4 — 工程频道逾期告警

修改 `scripts/lead-alert.sh` allowlist、`carries_delivery_channel()`及`emit_result()`对新kind的message_id分支；`packages/teamlead/src/LeadAlertNotifier.ts` union；`bridge/alert-kind-copy.ts`的titleFor/bodyFor穷尽switch；`bridge/kind-contract.ts` KIND_CONTRACTS，owner=owning_lead、arc=human_by_design（按现有准确字段/枚举结构填入），以及queue destination consumer。新kind出站目的仍固定工程Lead；不能让owner推断更改已持久destination。新增 `scripts/__tests__/codex-home-migration-alert.test.sh`。使用 fixture projects/clock/claims/queue 与本地 HTTP接收器跑真实 shell sender：到N天恰收到一次对应工程 channel 的 POST；未到/已满足=零次；无任何 receipt 也会发。全局 unified channel 设置成另一个 fixture ID，仍必须工程 channel。429/5xx→queued且drain恢复到原目的地；403/config坏→不记sent，有failure与fallback；duplicate不能伪造送达。

**变异测试硬红**：在隔离源码副本把 `now >= dueAt` 变为永假（及 satisfied 取反），运行同一“无回执逾期”integration test必须失败，因为本地接收器POST数=0；保留变异diff、原pass与变异fail输出，不在主工作树遗留变异。测试不是仅 spy `.notify()`。

### T5 — ready与activation守卫

新增 check/activate wrappers，提取 collector options 单源，`packages/teamlead/src/bridge/flag-routes.ts` apply-requested之前的off→on守卫及`src/__tests__/flag-routes.test.ts` tests。复用 `scripts/__tests__/codex-quota-readiness-receipt.test.sh`；新增 FLY-2729未部署/无daemon生效QA证据但五家全ready仍拒绝on、off始终允许、missing-one receipt、old digest、pending残留、unapproved active home、unknown comm、错误build、wrong state root、flag revision冲突、kill-switch随后关回不重开。真实 checker+fixture collector，不能 stub ready=true 来证明完整路径。运行 teamlead 的 host-readiness、codex-quota-readiness、runtime、feature-flag 聚焦 suites。

### T6 — 交接与生产验收（后续节点）

PR静态证据 `git diff --name-status <base>...HEAD`：无新增 launchd plist、crontab、timer；`rg -n 'codex.home.reconcile|home.migration' scripts/update-flywheel.sh scripts/restart-services.sh packages/teamlead/src/bridge/plugin.ts`；源码扫描加 cadence call-order tests 共同证明。所有不相关生产目录未变。

授权部署后依次收集：实际deployed SHA及FLY-2729已部署/验收证据；派生清单当前五家归属；每家done/already回执（活跃且需要迁移则skip，已完整共享可只读already）；原auth备份的受限验证结果；marker清零；真实readiness JSON ready=true（仅必要条件，须合并全部拓扑+同digest满足回执）；flag before/off→after/on 的scope+revision审计。不要因持续活跃阻断监控或忘掉 obligation。

隔离 usage-limit 证据：运行同 deployed 模块的隔离 Bridge/StateStore、fixture canonical+pool+homes，注入唯一 test execution/root 的 usage-limit signal，经真实 ingest/coordinator→target_profile→install到fixture canonical→recover 流程，断言 incident 恢复及只重启隔离 execution；stub外部 transport 可替代真实登录，标注 fixture，不能声称生产已经自动切过账号。为生产开关有效性另收集 live consumer enabled/readiness 的只读结果。若现有入口不能做到不污染生产root，禁止向生产发合成事件，先完成隔离 harness；任务验收用用户允许的隔离信号，不动 founder 登录态。动态验收必须再证明相关 home daemon PID/start identity 换代、新进程实际读到目标账户的非秘密身份，并且一次后续请求成功。不能只看 target_profile 或 incident settled。Lead daemon 仅允许通过 `CODEX_HOME=<隔离home> codex remote-control stop --json` + 既有 supervisor ensure-daemon；Lead 进程、thread、窗口身份必须保持。不要把手工执行此命令补齐探针称为自动链已完成。现有自动链缺口归FLY-2729；其部署与daemon新token有效证据未通过前，2523不得激活flag，禁止在2523增加该恢复实现。PR同时贴生产配置证据与隔离动态证明，不能混写。

生产预检若实际存在不在注册派生清单内的live home或其它authority失败，报告精确阻碍，flag保持off；不得缩scope/伪造清单。完成真实验收前不报“自动切号已恢复”。

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

## 11. 审查反馈处置记录

首请求edf3b199 / d7ab6f48返回no_verdict（没有有效审查结论），以下只是可读raw反馈处置，不伪称findingKey或治理裁决。范围/DONE歧义已在§1分两段，完整生产目标仍保留；restart超时退出/恢复反例已加入T3；drained checker不足已显式补全部拓扑+回执；告警copy/contract/shell消费者已补T4。

MEDIUM Lead-launch-fence-blast-radius：现有三家Lead确实无需写入。建议“全部Lead永远只读”会改变本单safe-anytime契约及未来注册派生home的收尾能力，因此暂保留写入所需的startup fence，只在实际需要变更的home使用；已满足路径零触碰启动。此项报Lead确认是否进一步收窄；不把审查建议当已批准scope削减。

## 12. 有效审查R1与Lead范围裁定

2026-09-18本轮有效reviewVerdict=CHANGES_REQUESTED，request=d7ab6f48-fe2a-458b-9b31-95b9a1896a7e。HIGH raya-lead-roster-divergence：本单共享credential-home roster修复，原resident patrol名册保持不变，禁止通过给Raya盲加patrol=true回避；T5新增集合一致性测试。HIGH readiness-ready-unreachable-on-host：桌面Codex无CODEX_HOME、keyed resident进程无lease两类已知阻碍须明确归属后重审，不能只等待2729就宣布可开。

Lead问题0d98895d-f500-4375-afe1-65d7b82123f8明确保留Lead fence：已满足不等于不变量；fence在当前状态下no-op，保留用于未来漂移安全收敛。MEDIUM lead-launch-fence-blast-radius保留在审查记录，按此范围决定继续；该prose是设计范围指令，不冒充server review-ruling或抹掉finding。Lead正常结果只允许already-satisfied、skipped+原因、done+回执；I/O失败是外置attempt失败诊断，不触发第四种修复动作。本单绝不为了满足home而重启Lead/动Lead进程。daemon恢复实现归2729且只走remote-control stop+既有supervisor。

MEDIUM keyed-home-no-drain-window：不虚构当前implement的自然空闲频率，没有采到可支持SLO的数据。仅安全观察不能保证固定期限完成；持续忙则持续skipped并在N天告警，正是founder指定的行为。role级自动pause会改launch admission政策，未获本单授权，不暗加。可收敛条件写成可测的liveness：fixture连续busy三轮均零写入；第四轮真实idle后在下一受控机会完成，无人工重发命令。生产一直busy时保留未完成并按时告警，不声称已迁移。

## 13. R1 HIGH2：真实进程与home权威

### keyed resident无lease的只读一致性修复（本单）

正常启动 `packages/edge-worker/src/Blueprint.ts:993` 已走admitCodexAgentHome；lease缺失不是新正常语义。collector保持原lease匹配路径，新增只读且更严格的resident binding证据路径，既不造lease也不修改admission lease语义：
1. 从StateStore当前execution/runtime/workflow node绑定取得project/role/execution，和CommDB running或phase_keep_alive身份一致；不能以进程env自报代替。
2. `resolveExecutionCodexHome`（claude-runner/src/codex-home.ts:2308）核对持久session.json.codexAgentHome与期望project/role、marker及精确路径。
3. `readCodexLaunchSnapshot`（CodexTmuxAdapter.ts:398）校验该execution的持久launch状态。
4. `probeCodexDaemonEvidence`（codex-daemon-runtime.ts:314）通过确定性execution socket、持久daemon PGID、当前内核socket holder/PGID、PID start identity证明是该执行的活daemon。env与该证据矛盾则unknown；同execution的其它进程只在可证明同一持久launch或TUI child关系时覆盖，任一未覆盖Codex进程继续unknown。
5. 所有匹配成功才记该home active，并把该exec计入matched；缺lease诊断保留（不影响无写入原则），缺任一强证据仍unknown且报警。迁移操作仍看进程active而跳过，不能借此触碰在用home。

新增 `packages/teamlead/src/codex-quota/resident-home-evidence.ts` 作为上述窄adapter，从plugin注入真实StateStore/CommDB/launch/socket探针；host-readiness.ts和readonly readiness CLI共用；collector不得写任何home。T5新增真实fixture形状：无lease但全部持久+socket证据→active；env-only、错project/role、stale snapshot、PID复用、socket holder错组、未匹配CommDB或未覆盖process→unknown。若已部署旧resident连这些持久证据都缺，不能扩大兼容路径，按Lead90a807c5要求停下报精确边界，不修活daemon、不造lease。

### 桌面reader：已尝试的只读证据与边界

作者本轮lsof只读核查：PID1612 executable=/Applications/ChatGPT.app/Contents/Resources/codex，codesign身份OpenAI OpCo/2DC432GLL2；打开canonical目录下logs_2.sqlite、queue_1.sqlite与tmp/arg0/.../.lock。这些证明其使用该状态目录，但不独立证明其内存凭据来源/账号chain。SQLite还可经CODEX_SQLITE_HOME搬离CODEX_HOME；官方auth支持file/keyring/auto/ephemeral，不能仅凭路径或缺环境变量推凭据authority。源码目前没有desktop credential attestation adapter。未读取token、未给活app-server发RPC或重启。

向Lead问题aa341d63-0fb2-4982-acb6-44a95efe148b请求边界裁定：若必须新建desktop runtime正向证据producer，按90a807c5约定由Lead调整验收/另定归属；未裁定前维持全宿主checker unknown、flag off。禁止把“已证明五家”偷换成global ready。T5必须包含无CODEX_HOME桌面进程fixture，当前行为应可复现unknown；缺权威不能写成PASS。该条的最终处置必须得到Lead明确回答后才提交下一轮设计审查。
