# FLY-1502 一次性切换(九步 stop-the-world) — 调研
Issue: FLY-1502 (https://linear.app/geoforge3d/issue/FLY-1502/v2批次3-一次性切换-九步-stop-the-world-gono-go-十条-旧系统冻结围栏)
日期: 2026-07-28
基于: exploration.md(brainstorm gate 六点裁定已并入)

## 0. Lead 裁定(brainstorm gate 2026-07-28,约束本单全部后续)

1. **范围=全机**退役旧 comm 基座;非 flywheel 项目派发短暂停用、恢复即走 v2、零残留。
   停用窗口预告由 Tadashi 在 roundtable 发,runbook 必须给出"预计停用时长"供引用。
2. **Bridge 拆薄**,不原样重启硬拦;围栏是兜底不是主刀。拆薄=禁用/不加载(配置或入口
   开关),**不物理删码**(删码归 FLY-1503),保 T1 回滚可逆。禁用清单逐项落 runbook。
3. cutover CLI:**dry-run 与真跑同一条代码路径**(仅目标路径参数不同),否则预演不构成
   证据;step ledger 每步输出"将做什么+爆炸半径"人话,founder 按步拍。
4. **围栏路径与新路径不相交升为 Go/No-Go 新增检查**(上电后旧路径零新写入);新
   namespace 选择写 runbook;旧 team 目录逐个归档+墓碑并入 step ledger。
5. 执行归属:Implement runner ship 后**现场操刀九步**,Tadashi 督导+转译,founder 明示
   每个不可逆步。1502 自己的 PR 走 legacy 手合(Tadashi 合,不重启)。A 段(设计→评审→
   工具+隔离预演→PR+评审+QA)全速;B 段窗口时刻等 founder 拍;**不许为赶时间跳过隔离预演**。
6. FLY-1520 §9 欠条:GitHub 探针留本单(上线阻塞);legacy 收养 API/列提升/generic
   task-effect lane/多 shippable **全部记入 FLY-1503 族账**(Tadashi 记),不另开 issue。

## 1. 新系统能力矩阵(已有 vs 缺口)

### 1.1 已有(批次 1-2 已 merge,全部有测试)
| 能力 | 位置 | 备注 |
|---|---|---|
| 20 表 schema + 迁移 0001-0008 | `packages/v2-kernel/src/migrations/` | 0008=退役表删除(上线前置) |
| WAL-safe 备份+校验 | `v2-kernel/src/backup.ts` `backupDatabase` | integrity_check+foreign_key_check+migration ledger 比对,临时产物清理 |
| 连接纪律 | `v2-kernel/src/connection.ts` | PRAGMA/busy_timeout/0600 |
| epoch 围栏库侧 | mailbox.cutover_epoch 列(0005)+ meta cutover_epoch(`v2-engine/src/sql.ts` initializeCutoverEpoch=1)+ transitions fence | |
| 消费循环/公平性/K=4/vipBurst | `v2-engine/src/consume-loop.ts` + `driver.ts` EngineDriver | Lead/runner 注册、heartbeat、single-flight |
| 注入垫片 claude/codex | `v2-engine/src/injection/` | claude=写 sessionRef 携带的 stock inbox 路径 |
| enqueue + canonical key | `v2-engine/src/enqueue.ts`(UNIQUE(source_kind,source_id)) | Discord canonical key 的落点 |
| DAG admission/dispatch/completion/gate/ship/rework | `packages/v2-dag/src/`(admitIssueDag/dispatchOnce/submitNodeCompletion/approveShipGate/executeShip/reconcileShipActions) | FLY-1520;角色合同来自数据文件 |
| actions 黑匣子 | `packages/v2-actions` + kernel actions.ts | |
| 重启风暴 gate + scheduler-once | `packages/v2-scheduler`(launchd backend)+ `scripts/install-v2-scheduler.sh` + `scripts/restart-storm-gate.py` | FLY-1501;stale lead 探测→launchd kickstart |
| merge actor 红线探针(可复用模式) | `packages/teamlead/scripts/verify-merge-actor-denied.sh` | FLY-350;probe 真实 gh actor 对 protected branch 的可合并性 |

### 1.2 缺口(=1502 接线交付)
| 缺口 | 说明 |
|---|---|
| **常驻宿主进程** | EngineDriver/dispatchOnce/mailbox 冷启动/heartbeat wake 四循环无宿主;launchd 无 v2 job;`~/.flywheel/flywheel-v2.db` 不存在 |
| **agent 侧访问面** | 设计要求"runner/Lead 侧访问经 kernel API,无直连 DB 裸写";v2 包无 CLI/HTTP。需要 flywheel-v2 CLI(kernel 单一代码路径进程内复用;SQLite BEGIN IMMEDIATE+busy_timeout 支持多进程写) |
| **Discord 入站→enqueue 适配** | Bridge 现写 comm.db lead_inbox;退役后入站必须改 kernel enqueue(P3 canonical key 归位) |
| **admission 入口** | 真 issue→DAG:v1=Lead 调 CLI 显式 admit(角色合同数据文件已定);Linear 自动 ingress 归 1503 族账 |
| **founder approval 入口** | Discord 批准→approveShipGate 的记录路径 |
| **GitHub lane 探针** | required-checks+non-admin actor,fail closed 保 v1 lane(FINAL-v2 §1.5/§4) |
| **九步 cutover 工具链** | 全部不存在(冻结/枚举/对账迁移/归档/围栏/实弹/Go-No-Go checker/T1 回滚) |

## 2. 旧系统盘点(被退役对象)

### 2.1 comm.db(源 1)
- 路径:`~/.flywheel/comm/<project>/comm.db`(资产盘点 2026-07-28:flywheel / geoforge3d /
  TestProject / bare-dag-qa / fire-test / fly1182-qa / flywheel-qa-1259 / flywheel-test-2 +
  顶层遗留 `~/.flywheel/comm/comm.db`、`~/.flywheel/comm/flywheel.db`;QA 目录按"归档不迁移"处理)。
- 23 张表(db.ts+lead-inbox-queue.ts):messages / sessions / lead_inbox / three_stage_turn /
  runner_declared_states / runner_phase_wakes / workflow_engine_park(_cursor) /
  receipt_* 族 / loop_owner / loop_heartbeat 等。
- **未读语义**(迁移器输入;Codex R1-6 修正):
  - `messages`:唯一终态是 `relay_state='terminal_disposed'`;`open` 与 `protected` 都算
    仍在途(protected=受保护待答,legacy 视为可回答),未读=`read_at IS NULL AND
    relay_state<>'terminal_disposed'`(expires_at 只是默认 72h 的过期标记,分类时单列);
  - `lead_inbox`:生产 claim 只消费 `carrier='inbox'` 行;`carrier='external'` 行是外部
    投递账,不属于"未消费信箱消息"。未读=`consumed_at IS NULL AND carrier='inbox'`,
    external/processed/disposed 各自单列分类。
- 实测现状(切换窗口前会再枚举):flywheel 库 sessions running=5、messages 未读=610、
  lead_inbox 未决=5;geoforge3d 全零。610 未读绝大多数是过期/收件人已终态的历史——
  迁移器必须做终局收件人处置分类,不是无脑搬。
- writer:**flywheel-comm CLI**(每个 Runner/Lead 的 gate/ask/stage/complete/progress/
  respond/park;本 pipeline 自己也是)+ **Bridge**(teamlead 包 118 个源文件触
  comm.db/CommDB;子系统级:GatePoller、run-dispatcher、LeadInboxRuntime/
  LeadEventDeliveryCoordinator、RunnerIdleWatchdog、LeadWatchdog、HeartbeatService、
  commdb-fsm-reconcile、complete-marker-reconciler、legacy-ack-drain、DirectEventSink、
  auto-qa-coordinator、founder-approval-projector 等——implement 节点以
  grep CommDB/comm.db 全量清单为准逐项归类)。

### 2.2 JSON 信箱(源 2)
- (a) stock Agent Team 信箱:`~/.claude/teams/<lead>/inboxes/<agent>.json` +
  `.flywheel.jsonl` sidecar(`agent-team-transport/src/path-helpers.ts`);
- (b) 结构化目录:`~/.flywheel/inbox-structured/<lead>/requests`、`<runner>/responses`。
- writer:Bridge(run-dispatcher sendRunnerWake / StructuredInboxRouter)、flywheel-comm
  send/wake 双写(FLY-168,`deriveRunnerMailboxIdentity` 为共享映射)、claude-code stock
  harness 自身(teammate SendMessage;vendor 二进制,不可改)。
- **未读语义**(Codex R1-6 修正):未读真值=inbox JSON 主文件条目的 `read=false`;
  sidecar `.flywheel.jsonl` 是写入 finalization/去重账,不是未读真值。**并非每条 JSON
  条目都有稳定 flywheelId**:best-effort 写会生成 surrogate id,vendor 自写(stock
  SendMessage)条目无 flywheelId——跨源对账必须区分"有 flywheelId 可与 comm.db 对齐"
  与"vendor-only/surrogate 条目"两类,后者单独分类处置(不能假设全量可对齐)。
  FLY-168 双写使同一逻辑消息可在两源各一份,同 key 去重后守恒式必须计 overlap:
  raw_comm + raw_json = unique_canonical + overlap_copies。
- 设计警告([R3-2]):旧 JSON writer `ensureFileExists` 递归重建目录,仅移目录挡不住,
  必须"父目录 chmod 500 + 同名只读占位"墓碑,重建即 EACCES fail loud。

### 2.2b 第三处 durable 账:Codex Lead journal.db(Codex R3-5 发现)
每个 Codex Lead 的 codex-lead/<id>/journal.db(SqliteJournalStore,WAL)持有已受理但
未完结的 Discord/mailbox 输入(listUnfinished():accepted/dispatching/dispatched/
model-completed/output-pending)。**不属于两源迁移架构,但必须证清干**:步② 纳入
manifest+停新入口,跑原生 recovery 后断言 listUnfinished()==0,非零阻塞窗口;WAL-safe
快照归档;Go/No-Go 每个非终态一条查询/fixture(plan §4.2 步② 与 §6.2)。

### 2.3 launchd 旧 writer 启动入口(步 3 停机 + 步 6/围栏 a 撤销清单)
`com.flywheel.*` 全量(2026-07-28 实测):bridge、bridge-liveness-probe、cmux-watcher、
daily-standup、quota-monitor、skills-update、token-usage-daily、updater、
growth-{improve,learn,report,retro}、sub-create-nightly、sub-daily-loop、
lead.*(17 个 Lead job)+ com.xiaohongshu-deep-learning.qa528。
归类原则(implement 节点逐项定档):
- **停+改后重启**:bridge(拆薄形态)、lead.*(Lead 回归,消费走 v2);
- **停+禁用到 1503 裁决**:凡直接写 comm.db/JSON 信箱的周期 job(cmux-watcher 的
  comm 依赖、daily-standup 等——逐项 grep 定);
- **不动**:与 comm 基座无关的(token-usage-daily、skills-update 等,逐项验证后放行)。
非 launchd 旧 writer:tmux 里活着的 Runner 会话(flywheel-comm CLI)、cmux pane 里的
Lead 会话、手工终端。步 2/3 的在途清零+进程枚举必须覆盖(pgrep + tmux list + cmux)。

### 2.4 Bridge 拆薄的子系统分类(裁定 2 的落地骨架)
主入口=`packages/teamlead/src/bridge/plugin.ts`(约 5000 行组合根)。
**但它不是唯一 composition seam**(Codex R1-3):Codex Lead 的 TUI/headless runtime 与
gateway 进程各自创建 `RestPollDiscordInboundSource`/`CodexDiscordGateway` 并各自打开旧
`LeadInboxQueue(config.commDbPath)`(CodexDiscordGateway.ts、codex-lead-tui-runtime.ts、
codex-lead-runtime.ts)——旧 writer 禁用必须按"进程/entrypoint"矩阵穷举,不能只分叉
plugin.ts。且 `FlywheelConfig` 是每项目 `.flywheel/config.yaml`,承载不了机器级
retirement 权威——总开关必须是机器级、原子可读、fail-closed 的 authority(见 plan §5)。
plugin.ts 内的三档分类:
- **A 保留**(thin Bridge):Discord I/O(bot 会话、HTTP /send、thread 管理)、
  dashboard/health、fleet console、publish-report 等非 comm 编排面;
- **B 换写点**(唯一新增权威写):Discord 入站 handler 从写 lead_inbox 改为调 kernel
  enqueue(canonical key=(discord, <channel/message id>));
- **C 禁用**(旧 comm writer 编排子系统,开关不加载):GatePoller、run-dispatcher、
  LeadInboxRuntime、LeadEventDeliveryCoordinator、RunnerIdleWatchdog、LeadWatchdog、
  HeartbeatService、commdb-fsm-reconcile、complete-marker-reconciler、legacy-ack-drain、
  auto-qa-coordinator、founder-approval-projector、edge-worker 旧派发面…(全量以
  implement 节点 grep 清单为准,逐项档案落 runbook)。
开关形态:**机器级单调 fail-closed authority 文件**(normative 规格见 plan §5;
per-project config 只作派生配置)。与 FLY-1456"不加新 flag"铁律的张力=Lead 已裁定
"配置或入口开关",且 authority 文件+全部检查点列入 FLY-1503 删除清单。

## 3. 九步 → 现有原语/需建工具映射

| 步 | 设计原文(v1/v2/final §4) | 已有 | 要建 |
|---|---|---|---|
| ①预演 | 隔离路径 standalone migrator 反复跑+抽样重放+对账清单(row counts/状态映射/FK/唯一性/业务 invariant) | backupDatabase、migrator | cutover CLI 本体(dry-run=同码路+隔离目标路径);对账报告 |
| ②冻结 | 关 admission、枚举在途、cutover intent、不能 drain 的在途落 durable checkpoint | — | freeze 子命令:Bridge admission 拒新+双源枚举器+**staging DB 独占创建/迁移+window/intent/epoch 写入**(plan §4.3)+authority pre→cutover CAS+停机前 service/filesystem 签名基线(plan §4.2) |
| ③停旧写者 | Bridge+Lead+runner CLI+巡逻全停,记 host epoch | launchd 清单(§2.3) | stop 子命令:bootout 清单化+**四面**进程零验证(pgrep/tmux/cmux/**lsof 旧 DB/WAL/SHM/inbox fd**) |
| ④一致快照 | SQLite online backup API 必含 WAL | backupDatabase(v2 库);sqlite3 backup(旧库) | 对全部 comm.db + 旧库做 WAL-safe 快照+integrity_check,与步② 基线互核 |
| ⑤迁移 | FK/CHECK/UNIQUE+integrity_check+foreign_key_check+业务 invariant | 迁移 0001-0008 | staging 导入+对账迁移(**normative 规格=plan §4.4**)+WAL-safe promote(plan §4.3) |
| ⑥安全重置 | 旧凭据撤销、目录 0700 库 0600、旧 token 拒绝清单 | connection.ts 权限 | 归档 chmod 只读;launchd 项撤销(围栏 a);delivery secret/token 处置清单 |
| ⑦epoch fence | v2 拒旧 epoch | cutover_epoch 列+meta+transitions fence | initializeCutoverEpoch 纳入上电序;实弹断言接线 |
| ⑧顺序启动 | kernel→dispatcher/projector→observer→runner supervisor | EngineDriver/scheduler | 上电序脚本:engine daemon→thin Bridge→scheduler→Lead 回归 |
| ⑨回滚点 | 首个 v2 外部副作用前原子回切;之后 forward-repair | — | T1 rollback 子命令(卸围栏→归档恢复原路径→重启旧栈);T2=main@37bcb8e2 整仓回退(仅旧路径本身坏才走) |

三重围栏:(a) 启动入口撤销=§2.3 清单 bootout+disable;(b) 原路径墓碑=父目录 chmod 500+
同名只读占位(覆盖:全部 comm/<project>/ 目录、inbox-structured/、旧 team inboxes 目录);
(c) epoch fence=已有列+meta。

## 4. 双源对账迁移规则

**normative 规格已收口到 plan §4.4**(单一权威;Codex R2-4):枚举域(protected 计入
未读、carrier='inbox' 限定、JSON 主文件 read=false 为真值)、canonical key 规则(含
vendor-only/surrogate 确定性 hash)、逐行分类映射表、守恒式
`raw_comm_unread + raw_json_unread = unique_canonical + overlap_copies` 与
`unique_canonical = migrated + dead + tombstoned + manual(=0)`、migration-only typed
kernel API。本节仅保留背景事实:在途清零后旧 Runner 收件人必然全终态,预期活迁移量
≈lead_inbox 未决 + 少数 Lead 向 messages;QA/测试目录与顶层遗留库只归档不迁移,
枚举报告单列供 founder 过目。

## 5. Go/No-Go 十条机器化(checker 输出逐条 PASS/FAIL+证据)

| # | 原文(逐字锚) | 机器检查 |
|---|---|---|
| ① | 旧 writer PID/tmux/daemon 全退出 | launchctl print 清单零命中 + pgrep 零 + tmux/cmux 无 runner/lead pane + **lsof 零 open fd(每个旧 DB/WAL/SHM/inbox root)** |
| ② | 旧 API token 与旧 capability 被拒 | **8a held-start 后**旧凭据真打 held 端点=拒(顺序见 plan §4.2 授权序);flywheel-comm CLI 对墓碑路径=EACCES |
| ③ | 每 active task ≤1 active attempt | v2 库 SQL(partial unique 本身+全表扫描断言) |
| ④ | (actions 映射)effect_key 唯一+invocation 派生合同 | v2 库 SQL:actions.effect_key UNIQUE 全表验证(schema 无 invocationUid 列;invocation→effect_key 派生合同以代码测试背书,Codex R1-7 修正) |
| ⑤ | (actions 映射)已启动 action outcome 已结算或诚实 intended | v2 库 SQL:状态∈{succeeded,failed,intended};intended 数=0(切换时点应无在途 action)|
| ⑥ | migrated gate 绑 exact head | 切换起点=零 open gate(在途清零推论);SQL 断言 gates 表空或全绑 tip |
| ⑦ | v2 DB 权限/integrity/FK/WAL backup | backupDatabase 全套 + stat 0600/0700 + 20 表+**migration manifest 全序核对(ID+checksum,止于 0009;R4-1)** |
| ⑧ | 双源冻结+未读按 canonical key 迁移对账 | 迁移器守恒报告全平(plan §4.4 三域)+ **命名子检查 journal 清账:每个 Codex Lead journal 在证据集且 listUnfinished()==0,歧义/死信单列;缺席或非零=8a 不可授权(R4-7)** |
| ⑨ | 旧信箱只读归档+原路径 fence 就位 | 归档 stat 只读 + 墓碑 stat(500/只读占位)逐路径 |
| ⑩ | 实弹测试 | §6 harness 三断言全过 |
| +新 | (裁定 4)围栏路径与新路径不相交;上电后旧路径零新写入 | 不相交=realpath 集合求交+祖先/后代+symlink 三类检查(拒绝 fence 目标为 v2 路径祖先);零新写=**步 8b 后 acceptance gate**(find -newer 基线=零;失败即停新入口+forward-repair,非 pre-GO 证据) |
| +探针 | GitHub required-checks+non-admin actor(FINAL-v2 §4 保持项) | probe 真读 target branch ruleset/required checks+token actor permission/bypass;403/空集/admin/bypass 命中=fail closed 保 v1 lane(verify-merge-actor-denied.sh 模式扩展) |

## 6. 实弹测试(步⑦后、Go/No-Go ⑩)harness 规格

受控真启动一次旧 writer 二进制:
- 旧 comm.db writer:以旧入口跑 flywheel-comm(如 stage set)指向原路径→断言进程非零
  退出+EACCES fail loud;
- 旧 JSON writer:触发旧 Bridge 传输路径的 ensureFileExists 重建尝试(隔离调用其写函数
  或以旧配置起一次 run-dispatcher 写点)→断言 EACCES;
- 三处零残留:原路径无新文件/-wal/-shm(find -newer 基线);新 mailbox 零旧 epoch 行
  (SELECT count WHERE cutover_epoch <> current)。

## 7. 上电后形态(runbook"预计停用时长"依据)

- **停用窗口**(全 fleet Discord Lead 不可用):步②-⑧,预估 30-60 分钟(migrate 数据量
  小,时间大头=停机核验与 founder 逐步拍板)。runbook 给 Tadashi 的预告口径:
  "全部 Lead 预计停用 ≤1 小时;Runner 新派发恢复后走新引擎"。
- 上电后:thin Bridge(Discord I/O)+ v2 engine daemon(Lead 消费/DAG 派发)+
  v2-scheduler(launchd)。Lead 回归聊天;flywheel 项目跑真 issue 全链验收
  (admission→DAG→runner→completion→gate→founder approval→ship)+ FLY-1507 swap 探针
  + founder page 探针。非 flywheel 项目派发恢复=在 v2 上 admit 其 issue(零旧残留)。
- StateStore(~/.flywheel/flywheel.db,Bridge 自域:Discord thread 绑定等)**不在本单
  退役范围**(冻结对象=comm.db+JSON 信箱两源;StateStore 收敛归 1503+ 裁)。

## 8. 风险清单

1. **610 条未读的分类噪声**:终局收件人处置规则(§4.3)把绝大多数归 tombstone/dead;
   报告必须让 founder 一眼看懂"活迁移 N 条、墓碑 M 条、DLQ K 条"。
2. **Bridge 拆薄漏网写点**:118 文件面大;围栏(b)墓碑兜底+实弹测试+Go/No-Go +新检查
   (上电后旧路径零新写入)三层网。
3. **claude shim 与墓碑相撞**:新会话身份 namespace 必须与被墓碑路径不相交(裁定 4);
   v2 会话 team 命名规约在 plan 定死,checker 做集合求交。
4. **stock harness 自身写 JSON 信箱**(vendor 二进制,teammate SendMessage):旧 team
   目录墓碑后,残存旧会话的 SendMessage 会 EACCES——在途清零保证无残存旧会话;实弹
   测试覆盖。
5. **停机窗口内外部事件丢失**:Discord 消息在 Bridge 停机期落在 Discord 服务端,重启后
   Bridge 拉历史(RestPoll baseline);Linear webhook 停窗丢失=恢复后由 Lead 对账(v1
   非目标不动 Linear 集成,admission 本就 Lead 驱动)。
6. **quota/杂项 daemon 的 comm 依赖误伤**:§2.3 逐项 grep 定档,宁停勿漏;停错了 T1 可逆。
7. **B 段窗口拖长**:每步 ledger 幂等可重入,founder 中途离场=停在步界,T1 随时可回。
