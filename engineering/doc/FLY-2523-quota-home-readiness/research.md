# FLY-2523 自动收尾与额度就绪 — 调研
Issue: FLY-2523 (https://linear.app/geoforge3d/issue/FLY-2523/部署-codex-额度自动切号子系统在宿主上收尾生成-readiness-receiptjsonapproved-homes-清单)
日期: 2026-09-17
基于: exploration.md

## 代码事实与后果

| Source | 当前行为 | 设计后果 |
|---|---|---|
| scripts/codex-home-link-truth.sh:54–66 | inspect=already 提前返回 | 不会清掉正确 symlink 旁的 pending；需要修复早退条件 |
| 同文件:70–94 | ps 检测在 helper/锁外，跳过祖先进程 | 不适合直接作为 anytime 自家迁移；不得忽略调用它的 Codex 祖先 |
| packages/claude-runner/src/codex-home.ts:924–1059 | keyed migration 复用 admission .locks/role，锁内拒绝 leases；普通 home 靠 caller fence | 新迁移核心必须锁内重验进程；Lead 仅借受控 lifecycle fence |
| 同文件:880–913 | keepBackup 创建 0700 目录、0600 独占文件，fsync | 保留并强制 regular auth 先备份，禁止 canonical 写入 |
| packages/claude-runner/bin/flywheel-codex-link-truth.mjs:76 | already 不写 report；failed/skipped 无统一回执 | 外层增 attempt ledger，helper 的 report 不能当唯一验收 |
| scripts/codex-quota-readiness-receipt.mjs:103 | output=join(stateRoot,'codex-quota') | 正确参数 state-root=~/.flywheel，不是 ~/.flywheel/codex-quota |
| packages/teamlead/src/codex-quota/readiness.ts | 检查 active managed symlink；drained managed 不查 auth | 激活前必须额外重验四家拓扑与满足回执；直接复用 exported checker，不能用 runtime.readiness（flag off 时必 false） |
| host-readiness.ts | 校验 manifest digest；枚举 leases、所有 CommDB、进程、Lead authority | 四家 receipt 不自动等于 complete；其它 live home 必须报告，不扩大清单或伪造 complete |
| bridge/plugin.ts:8386 | collector 使用 findResidentCodexLeadTargets 与 commDbRootDir | 验收入口复用真实装配参数，禁止删掉 collector 的不匹配结果 |
| bridge/gate-poller.ts:778 | onHealthTick 首 tick 与每 healthCheckEveryNTicks，现有 cadence | 在此 callback 调 single-flight reconcile，不新增 timer |
| bridge/plugin.ts:12565 | health 回调现在 void report；boot 同样调用 | 独立捕获迁移/告警异常，既有健康探测不被阻断；迁移不受 quota flag off 限制 |
| scripts/update-flywheel.sh:640 | deployed 已最新时直接 return | 在 updater_run_launchd_then_cycle 前置 reconcile/overdue 检查，fetch/无更新/部署失败不能吞掉它 |
| scripts/restart-services.sh:2491–2523 | Lead 每席 bootout → quiescence → hard clear → arm → bootstrap | 插入在 hard clear 后、bootstrap 前，不声称全舰队同时停止 |
| scripts/restart-services.sh:3055/3139/3237 | Bridge 先重启，然后 Lead 逐席重启 | “班车天然保证所有 Codex 不活跃”不成立；每家仍须真实检测 |
| scripts/lead-alert.sh | strict-delivery 区分 sent/duplicate/queued/dead/config；默认统一频道 | 不能默认当工程频道投递；需要窄范围 fixed-kind 路由，重试队列保留目标 channel |

## 消费者 sweep

link-truth 现有消费者：codex-credential-cutover.sh（有 pause/drain，但不传 keep-backup）、flywheel-lead.sh（初始 preflight）、lib/lead-backend-migration.sh（inspect）、fixture shell suites。保留旧 CLI；新的 reconcile wrapper 强制 keep-backup，不更改旧显式 unlink 回滚语义。调整 inspect 的 already 条件及 migration clean-marker 必须覆盖这些回归。

readiness consumer：quota/runtime.ts、launch-binding.ts、bridge/plugin.ts。无本单引擎策略修改。approved manifest 是部署输入，不是从 inventory 扫描出来的自动授权。

告警 consumer：lead-alert.sh kind allowlist、LeadAlertNotifier 类型/kind parity、alert queue 的 deliveryChannelId reader。实现前沿新 kind 查找每一消费者；不复用含义不同的告警名称逃过注册。

## 隔离验证策略

fixture auth 仅伪造测试数据。每个测试提供独立 HOME、state root、projects、process collector、clock 和 transport，测试模式必须在入口显式指定并拒绝指向真实 HOME。不执行生产 link-truth、restart 或额度事件。源码扫描只证明没有新增调度器，还需 integration trace 证明接入既有 callback 和 updater no-update 分支。

## 尚未证明的事实

生产 flag 当前值、实时 process census、所有 runtime homes 是否恰为四家、真实告警送达与 usage-limit 恢复均留给 implement/QA 的授权生产验收。两个 Lead home 当前已满足是本轮文件元数据观察，不能据此宣布 readiness ready。

## Lead 新事实及恢复链审计

问题 e451c20d 的有效回复：2026-09-18 06:0xZ Lead 实测 .codex-raya、.codex-infra-bot、.codex-mufasa、eng_design 均 symlink→/Users/xiaorongli/.codex/auth.json；implement仍FILE+pending。前四项中三个属于Codex Lead，数量与旧四家清单不同，已另问清单范围。symlink不是登记回执。

Lead 2026-09-18 04:14Z Raya 观察：canonical换号后运行中daemon仍缓存旧token；remote-control stop后既有supervisor约10秒重建，daemon PID19743→31785，Lead/thread/window未变。此为Lead提供的生产证据，本设计不重演。

源码 run-recovery.ts 的recoverTarget对非runner直接return；verifyRunning仅查session running、credential binding generation/account/profile与liveness，未证明进程重新加载token。现有自动Lead daemon刷新不在该恢复路径，必须向Lead报缺口，不能以incident settled通过最后验收，禁止本单扩实现。

额外零写入反例：codex-home.ts:427–449 assertHomeIsPlainDirectory 会mkdir/chmod；migrateCodexAgentHomeCredential在锁/lease检查前调用。需要拆只读validator。

## 注册身份独立核查（2026-09-18 06:12Z，本轮只读）

来源不是Lead转述：读取实际 ~/.flywheel/projects.json 过滤backend为Codex，以及两家 .flywheel-agent-home.json；对三家Lead运行仓库 scripts/resident-codex-lead-recover.sh --project <project> --lead <agentId> --authority，三次exit0。输出仅身份元数据，无凭据。

| home | 注册依据 | authority结果 |
|---|---|---|
| agents/flywheel/eng_design | project=flywheel, role=eng_design, marker.version=1；repo .flywheel/agents/nodes/eng_design.md | keyed marker路径匹配；不是Lead registry entry |
| agents/flywheel/implement | project=flywheel, role=implement, marker.version=1 | keyed marker路径匹配；不是Lead registry entry |
| .codex-infra-bot | projects flywheel / agentId codex-infra-bot-lead / backend codex-app-server | home准确；label=com.flywheel.lead.flywheel-codex-infra-bot-lead；wrapper=flywheel-codex-lead-wrapper-codex-infra-bot.sh |
| .codex-mufasa | projects growth / agentId mufasa-lead / backend codex-app-server | home准确；label=com.flywheel.lead.growth-mufasa-lead；wrapper=flywheel-codex-lead-wrapper-mufasa-tui-fullaccess.sh |
| .codex-raya | projects raya / agentId raya / backend codex-app-server / codexProfile full-access | home准确；label=com.flywheel.lead.raya-raya；wrapper=flywheel-lead.sh |

全部找到注册/marker身份。mufasa不是依据launchd名字猜出，更不是rafiki：其authority把projects、manifest、plist、wrapper连成准确的mufasa tuple。Raya本轮另行readlink确认canonical共享、pending=false。Lead已明确批准五家并要求派生清单及unknown-home fail loud。

本地Mermaid两张图均首次和标准参数重试失败：Chromium MachPortRendezvousServer bootstrap_check_in Permission denied(1100)。按交付合同保留.mmd并显示DIAGRAM PENDING LOCAL RENDER；无远程渲染。

## 依赖归属更新

Lead已创建FLY-2729（FLY-2072下，High）处理Lead daemon换代/新token生效缺口。其回复5b425684要求：2729未落地不得on，已作为plan第6节正式flag写门和T5阴性测试。此节点不实现2729、不启动它。
