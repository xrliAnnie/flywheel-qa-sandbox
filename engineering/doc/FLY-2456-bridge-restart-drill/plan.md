# FLY-2456 529 房真机重启演练(2352 reown)— 实施计划
Issue: FLY-2456 (https://linear.app/geoforge3d/issue/FLY-2456/529-房演练-2352-真机重启演练slot-里起-2-3-具-codex-体-重启-slot-bridge-测-reown)
日期: 2026-09-10
基于: research.md

**Status**: draft(v5:吸收 Codex R3 七条 —— start/rework 收养绑 `workflow_start_reservation.idempotency_key` 与 `operator_rework_requested` event_uid、intent/adopt 覆盖 deploy/adoption/park/QA-fail/decoy 且副本要新于 adopt、cycle 先只读捕获再原子写 intent、comm-scan 只扫物理表且哨兵改为 `mailbox/sessions/three_stage_turn/runner_workflow_activation`(`messages` 是 poison view)、liveness 用只读 evidence wrapper、gate 收养与 `getOpenGatesByRunner` 同 SQL、fleet needs-attribution 需 identity sidecar、terminate 收养按前置/兜底分类;v4:吸收 Codex R2 七条 —— adopt 改为「先落 intent、再向权威状态收养」四态协议、liveness 用产品探针语义、换体链按真实 payload 因果关联、room-info 恢复 no-clobber、零影响工具三处 fail-closed 具体化、replacement 声明集只从不可变回执推导、exploration §4 同步;v3:吸收 Codex R1 九条 —— reown 资格硬门、§7 硬前置按路书原样、launch-commits 改 bounded-delta、事件查询改 id/seq 下界、零影响三组对照矩阵、每轮 manifest 与 adopt-before-execute、room-info 失败路径、dry-run 用真 scanner 语义、形状校验拆两层;v2:吸收 Lead `249cfa43` —— 宿主机步骤与 hermetic 分离)
**分支**: `flywheel-FLY-2456`(共享分支;交付物是宿主机路书 + hermetic 工具 + 证据 + 报告,**不含产品代码改动**)

## 0. 一句话

Lead 在宿主机按一份「每步一条可复制命令 + 期望输出 + 停手条件」的路书,在 slot 4(修前 = `origin/main`)与 slot 1(修后 = `origin/main` ⊕ PR #1128 头的一次性本地 merge)各起一间真 Codex 房,起三具体:B1(rework 唤醒过的多 activation 靶体,持 open gate、是 TURN holder)、B2(单 activation、持 open gate、TURN holder 的正对照)、B3(停驻但 TURN 已交给 QA 的阴性对照);用 `test-cycle-bridge.sh` 只重启房内 Bridge;实现节点交付路书和一套不连真库、可自测的工具;唯一夹具是隐藏 `room-info.json` 以解除 FLY-2211 对 529 房的 reown 排除(Lead 裁定 `aa0f4fe9`),另加一个「开一个 `gate --no-block` 问题」的形状夹具让体进入生产事故同款的 `gateHeld=true` 资格。

## 1. 已验证的前提(不再重复调查)

| # | 事实 | 证据 |
|---|---|---|
| P1 | generalized 房里 Codex 体被 `isCodexReownExcluded` 整体排除;Bridge 侧唯一读者是该 predicate,read-on-use | exploration §2.2,`codex-session-reown.ts:356`、`plugin.ts:7862` |
| P2 | #1128 头 `b3ed3cc97` 不含 FLY-2454;与 `origin/main` merge clean(tree `3a4fc804f`) | exploration §2.3 |
| P3 | 多 activation 的唯一生产者是 rework wake(同一 execution 再 admit `mode='wake'`);wake 后 session 明确转回 `running` | `workflow-rework-coordinator.ts:606-651`;`holder-wake-activation.ts:101-130` |
| P4 | `test-cycle-bridge.sh` 只 TERM Bridge 链、同合同重放;daemon 独立 pgid 活过重启;boot pass 在 heartbeat 之前 | research §1.6 |
| P5 | 修前判据:drift 文案前缀 + `codex_recovery_capabilities_prepared` 0 条 + `episode_exhausted` + `last_error='Codex recovery exhausted after 2 attempts'`;修后判据:`reown_revive_succeeded` + `codex_recovery_capabilities_prepared payload.attempt=2` | research §2.2 |
| P6 | 生产 comm.db 活库不可逐字比对;改为 slot 标识行 = 0(Lead 裁定) | exploration §2.4 |
| P7 | 房内 `TEAMLEAD_STUCK_INTERVAL` 被合同 sweep 清除,维护 tick 固定 5 分钟 | research §1.6 |
| P8 | FLY-2455 不在 main;`--no-lead` 房型 Bridge-only 不需要它;Lead 不是演练对象 | Lead `249cfa43`;C4 回执 |
| P9 | Lead 在 C4 已实证的零影响方法:严格基线 = 拆房前一刻的 `ps` 快照;消失 PID 逐个归属 SLOT / NONSLOT;`prod_runner_windows` 前后计数;残锁 `diagnostic-evidence-pending` 只能靠显式 `test-teardown.sh N` 释放 | C4 回执 |
| **P10** | **reown 资格分派**:`liveness=='alive' && !gateHeld && !isParked` ⇒ 只记 `reown_watch_started`,不 claim;其余进 `beginRecovery`;recovery 内 `readTurnHolder(session) !== execution_id` ⇒ parked 体记 `reown_skipped_not_turn_holder`,running 体记 `reown_fence_lost`(都退还 attempt)。`gateHeld` = CommDB `getOpenGatesByRunner(exec)`(`type='question'` 且无 response)非空 或 gate-hold latch | `codex-session-reown.ts:462-527, 627-649`;`plugin.ts:7906-7913`;`flywheel-comm/src/db.ts:4109-4115` |
| **P11** | generalized dispatch **一定**把每个 execution 写进宿主 `$HOME/.flywheel/state/launch-commits/<executionId>`(路书 §7 登记的 unconfined consumer) | `run-dispatcher.ts:210-212,1644-1653`;`workflow-engine-dispatcher.ts:255-263` |
| **P12** | `session_events` 列为 `id,event_id,ts,execution_id,issue_id,project_name,event_type,severity,payload,source`(无 `created_at`);`workflow_run_event` 列为 `id,run_id,seq,event_uid,kind,node_id,edge_id,execution_id,payload,at` | `StateStore.ts:4922-4935, 24753-24766` |
| **P13** | FLY-913 护栏是组合语义(P1 launchctl+标识、P2 kill 族+进程标识、P3 executor 首 token+`run-bridge`);纯函数 `scan_block(cmd)` 无副作用,`main()` 命中后才写审计 | `flywheel-restart-guard.py:872, 1131-1160` |
| **P14** | session 级终止 = `POST /api/actions/terminate` body `{execution_id, reason?}`(Bearer master token),**不接受任何幂等键**;run 级 `/api/runs/:runId/terminate` 会终止整个 run,**本演练禁用** | `actions.ts:createActionRouter` case `terminate`;`runs-route.ts:540-600` |
| **P15** | 产品 daemon 活性探针 `probeCodexDaemonLiveness(executionId, env)`:读 `session.json` 的持久化 PGID → `kill(-pgid,0)` 判进程组 → socket 存活 → 至少一个 socket holder 的进程组 == PGID 才 `alive`;PGID 缺失 / 组不存在 / holder 不属于该组 ⇒ `unknown` 或 `absent`。`lsof -t <sock>` 只证明有人持 socket,不等价 | `codex-daemon-runtime.ts:115-215` |
| **P16** | 换体链事件的真实 payload:两条 drift `reown_revive_failed` 带 `episodeId`;`episode_exhausted` 行只带 `reason, attempts`;`execution_dead_rolled_back` 记在**旧** execution 上,payload `newExecutionId, launchOrdinal`;`rework_replacement_materialized` 记在旧 execution 上,payload `requestId, newExecutionId, launchOrdinal`;`rework_replacement_launched` 记在**新** execution 上,payload `requestId` | `codex-session-reown.ts:583-592`;`StateStore.ts:34625-34668, 34968-34990` |
| **P17** | `flywheel-comm gate` CLI 不暴露 `--question-id`(底层 `gate()` 支持);重复执行会再插一行 question。产品的 open-gate 谓词是 `getOpenGatesByRunner`:`FROM mailbox_message_projection q WHERE from_agent=? AND type='question' AND checkpoint IS NOT NULL AND relay_state != 'terminal_disposed' AND superseded_at IS NULL AND NOT EXISTS(response with parent_id=q.id)` —— 收养与资格检查必须用**同一条 SQL** | `index.ts:2076-2096`;`gate.ts:191-197`;`db.ts:4104-4119` |
| **P18** | run-start 的幂等权威 = append-only `workflow_start_reservation(idempotency_key PK, selection_digest, run_id UNIQUE, node_id, attempt, execution_id UNIQUE, created_at)` + `workflow_start_stage(idempotency_key, stage)` + `workflow_start_response(idempotency_key, response_json)` | `StateStore.ts:26112-26146` |
| **P19** | rework 三表:`workflow_rework_request(request_id, run_id, source_event_id UNIQUE, authority IN qa/founder/engine/lead, source_node_id, source_attempt, …)`,目标在 `workflow_rework_route_revision(request_id, revision, target_node_id, target_attempt, preferred_actor_execution_id, …)`,状态在 `workflow_rework_delivery(request_id PK, state, hold_count, …)`。operator rework 的 replay 权威 = `workflow_run_event.event_uid = 'operator_rework:<runId>:<clientRequestId>'`、`kind='operator_rework_requested'` | `StateStore.ts:25860-25931, 40660-40745` |
| **P20** | slot CommDB 的 `messages` 与 `lead_inbox` 是**故意指向不存在对象的 poison view**(`fly1572_poison_*`),`mailbox_message_projection` 是 view;物理表为 `mailbox, mailbox_identity, mailbox_log, mailbox_terminal_archive, mailbox_migration_meta, loop_owner, loop_heartbeat, receipt_alert_outbox, content_ref_gc_outbox` + `sessions, three_stage_turn, runner_workflow_activation, runner_*, turn_*, workflow_engine_park*` 等 | `mailbox-schema.ts:297-300, 425-429`;`db.ts` CREATE TABLE 清单 |
| **P21** | `probeCodexDaemonLiveness()` 公开返回只是 `"alive"\|"absent"\|"unknown"`;详情在未导出的 `inspectCodexDaemonOwnership()`,且它也不返回 holder PIDs。导出的路径 helper:`resolveDaemonSocketPath(executionId, env)`、`codexSessionStateDir(executionId, env)` | `codex-daemon-runtime.ts:73, 87, 155-222` |
| **P22** | `qa-result` 每次进程内 `randomUUID()` 生成 requestId / clientRequestId,重跑不是同一请求;其效果的权威痕迹 = QA activation 的 submission credential 被消费 + `workflow_rework_request(authority='qa', source_node_id='qa', source_attempt=1)` + route revision + delivery | `qa-result.ts:563-609`;P19 |

## 2. 分工边界(Lead 指令 `249cfa43`)

- **宿主机步骤只由 Lead 执行**:装房 / 拆房 / cycle / 起体 / 代 runner 推进 / 开 gate / 藏与还原 room-info / 生产快照 / daemon liveness 探针。实现节点不在 sandbox 里跑这些;路书每步 = 命令 + 期望输出 + 落盘 + 停手。
- **实现节点可自测的部分(hermetic)**:manifest、资格与形状断言、事件下界与谓词、终局归类、零影响三组对照、报告拼装、dry-run(真 scanner 语义)—— 输入一律「文件路径」(`VACUUM INTO` 副本 / 文本快照 / JSON),不连活库、不 spawn。
- 接缝:宿主机每步只产生文件;工具只读文件;Lead 把工具输出原样贴回,报告器再拼。所有宿主命令用 **绝对路径 `<tested-checkout>/scripts/...`**,每轮开头核 `git -C <tested-checkout> rev-parse HEAD` 等于 manifest 里的 HEAD;hermetic 工具可来自 FLY-2456 checkout,但它不调用任何 primitive。

## 3. 交付物(最小)

### 3.1 `engineering/doc/FLY-2456-bridge-restart-drill/host-runbook.md`(路书,Lead 用)

按 §4 顺序逐步编号;每步四段:**命令**(单条,可复制,绝对路径)、**期望输出**(逐字或正则)、**落盘**(文件)、**停手**。所有有副作用的步骤前先 `manifest intent`,执行后 `manifest receipt`;恢复或重跑时先 `manifest adopt`(§3.2 四态:replay / adopt-existing / execute / conflict),`conflict` 即停手。对生产只读(`mode=ro` / `immutable=1` / `VACUUM INTO`);不 `rm -rf`;证据根 `~/.flywheel/qa-evidence/FLY-2456/<round>/`(既有 QA 归档根);不把 `ps -Eww` 抠出的 token 原文写进任何证据文件(runner env 一律从 slot 路径重建,research §1.4 法 2)。

### 3.2 `scripts/qa-fly-2456-drill-tools.mjs`(hermetic 工具,Node + better-sqlite3)

| 子命令 | 输入 | 输出 / 判据 |
|---|---|---|
| `manifest init --round r1\|r2 --checkout <abs> --slot N --issues …` / `manifest intent --step <id>` / `manifest adopt --step <id> --db <teamlead 副本> --comm <comm 副本> [--fs <slot-dir>]` / `manifest receipt --step <id> --file <json>` | 证据根 + 权威状态副本 | 原子写 `manifest.json`:tested checkout 绝对路径 + HEAD、slot、每具体 issue/label、**预生成并持久化**的 `idempotencyKey`(run-start)与 `clientRequestId`(rework)、沙箱分支名 / PR 号、cycle 序号、每次 cycle 前的事件下界与 old Bridge identity。**协议(每个有副作用的步骤)**:① `intent` 原子落盘「将要做」;② 执行;③ `receipt` 落「已做 + 输出」。恢复 / 重跑时 `adopt` **不看本地 receipt 有无**,而是向权威状态查,返回四态之一:`replay`(receipt 在且与权威一致 ⇒ 只重放输出)/ `adopt-existing`(intent 在、receipt 缺、权威状态显示副作用已发生 ⇒ 用权威状态补写 receipt,不再执行)/ `execute`(intent 在、权威状态显示未发生)/ `conflict`(权威状态与 intent 不符 ⇒ 停手)。**副本新鲜度合同**:`adopt` 只接受由宿主机在本次 adopt 之前**新生成**的 `VACUUM INTO` 副本,副本旁必须有 `<副本>.meta.json {observedAt, sha256}`,`observedAt` 晚于 intent 写入时刻且早于本次 adopt 调用不超过 10 分钟,否则拒绝(旧副本会错误返回 `execute`)。逐步的权威查询(全部按真实 schema):**deploy** 按 `room-info.json`(schemaVersion/slot/buildSha==manifest HEAD/runnerMode=real)+ `/health` 双 SHA + `bridge.pid` 存活;**adoption** 按 `${HOST_REPO}/.flywheel/menus/adoption.yaml` 含 `simple_code`;**start** 按 `workflow_start_reservation.idempotency_key == intent.idempotencyKey`,并校验 `selection_digest`、`run_id/node_id/attempt/execution_id` 与 `workflow_start_stage` 一致;同 issue 存在**别的** reservation / active run ⇒ `conflict`(P18);**park 三段**分别收养:marker commit 按沙箱远端分支 HEAD 含 intent 记录的 marker 文本(`git ls-remote` + `gh api` 读 blob),PR 按 `gh pr list --head <branch> --state open`(恰 1 条且 title 等于 intent),`complete` 按 `sessions.status='ship_parked'` + `workflow_engine_park` 有 `park_opened` + `workflow_run_node(implement,1).state='done'`;**QA fail(默认路径)** 按 QA 的 `runner_workflow_activation` submission credential 已消费 + `workflow_rework_request(run_id, authority='qa', source_node_id='qa', source_attempt=1)` 存在 + 其 route revision `target_node_id='implement'`、`preferred_actor_execution_id==B1` + delivery state(P22;`qa-result` 的 requestId 每次随机,**不得盲目重跑**);**operator rework(备选)** 按 `workflow_run_event.event_uid='operator_rework:<runId>:<clientRequestId>'` 且 `kind='operator_rework_requested'`,逐字段核 payload,再以 requestId join request / route revision / delivery(P19);**gate** 用与 `getOpenGatesByRunner` **完全相同**的 SQL 加 `to_agent='flywheel-test-<N>'` 与固定 content:0 行=`execute`,恰 1 行=`adopt-existing/replay`(收养 questionId),多行或任一字段不符=`conflict`(P17);**terminate** 分两类:前置演练的 terminate 必须看到 intent 之后 `status='terminated'` 且 `session_events` 有对应 terminate 动作/`reason` 才算 `adopt-existing`,目标在 intent 前已自然进入 completed/failed ⇒ `conflict`(前置目的没达成);QA 兜底的 terminate 见到任一不可恢复终态 ⇒ `adopt-existing-noop`,receipt 与报告写明「未执行 terminate」;**decoy** 按生产默认 tmux `list-windows` 恰 1 个 `fly2454-decoy`;**room-info** 按两文件存在性 + hash;**teardown** 按 slot 目录缺失 + `qa-evidence` 归档存在;**cycle** 顺序固定为「只读捕获完整 pre-state(old PID / old `lstart` / listener PPID 链 / `bridge.log` 偏移 / 事件下界)→ 原子写含全部 pre-state 的 intent → 执行」,intent 缺任一字段 ⇒ `conflict`;收养判「已完成」(new PID ≠ old 且 old 不存活且 spec 相同)/「未开始」(old 仍在)/「冲突」(哨兵 `cycle-failed`、或 PID 变了但 spec 不同)—— **绝不因 receipt 缺失自动再跑 cycle** |
| `bounds --db <teamlead.db 副本> --runs <id>…` | 副本 | `{sessionEventsMaxId, runEventMaxSeq: {runId: seq}}` 写入 manifest(每次 cycle 前调用一次) |
| `activation-parse --db <副本> --exec <id>` | 副本 | 通用解析:该 execution 全部 binding(`attempt,mode,activation_id,run_id,node_id,bound_at`)+ node 最新 attempt 的 execution;只描述不判 |
| `campaign-shape --db <teamlead 副本> --comm <comm.db 副本> --liveness <json> --body B1=<exec> --body B2=<exec> --body B3=<exec>` | 副本 + 宿主机路书里的**只读 evidence wrapper**(P21:公开探针只返回字符串)生成的 liveness JSON:每体 `{executionId, verdict}` 来自 `probeCodexDaemonLiveness(exec, {env})`,`socketPath` 来自导出的 `resolveDaemonSocketPath`,`persistedPgid` 从 `codexSessionStateDir(exec, env)/session.json` 读,`groupState` 由 `kill -0 -- -<pgid>` 退出码得出,`holderPids` 由 `lsof -t <socketPath>` + `ps -o pgid= -p <pid>` 得出;wrapper 前后各读一次 `session.json`,`persistedPgid` 必须不变。整段 wrapper 是路书里一条可复制命令,在 slot 合同 env(`FLYWHEEL_CODEX_SESSION_DIR` / `FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT` 指向 slot)下只读运行 | **本 campaign 精确门**:B1 恰 `(attempt1,spawn)+(attempt2,wake)`,activation_id 唯一、attempt 连续、run/node 相同、`workflow_run_node(implement,2).execution_id==B1`;B2 恰一行 spawn;B3 恰一行 spawn;`sessions.adapter_type='codex-tmux'`;**资格**(P10):B1、B2 `status='running'`、`verdict=='alive'` **且** holderPids 中至少一个 `pgid==persistedPgid` **且** 前后 persistedPgid 相同(工具复核,不只信 verdict 字段)、`three_stage_turn.holder_exec_id==exec`、open gate ≥1(用 P17 同一 SQL);B3 `status='ship_parked'`、holder ≠ B3(阴性对照)、`verdict != 'unknown'`;run 全部 `active`。任一不符 ⇒ 非零退出并逐项列出 |
| `observe --db <副本> --bounds manifest --bodies …` | 副本 | 只取 `session_events.id > 下界` 且 `source='bridge.codex-session-reown'`、`workflow_run_event.seq > 下界` 的行,按 execution 分组,输出 `id,event_id,ts,event_type,payload` / `seq,event_uid,at,kind,payload`;**因果链按真实 payload 关联(P16),不给任何行人造 episodeId**:两条 drift 的 `payload.episodeId` 必须等于该 execution 在 `recovery_claim` 的 `episode_id`;`episode_exhausted` 以同 execution、id 顺序在两条 drift 之后、`payload.attempts=2`、claim 状态关联;`execution_dead_rolled_back` 以旧 execution + run + node 关联并取 `payload.newExecutionId/launchOrdinal`;`rework_replacement_materialized` 以旧 execution + 同 `newExecutionId/launchOrdinal` 关联并取 `requestId`;`rework_replacement_launched` 以新 execution + 同 `requestId` 关联。终局按 §4.3 |
| `verdict --round --manifest --shape --observe --zero-impact --fixture` | 上述 JSON | `verdict.json` + `verdict.md`(零表格,ship report 骨架段落);轮通过条件见 §4.4 |
| `fleet-identity --prod-statestore <副本> --prod-sessions-dir ~/.flywheel/state/codex-sessions --out identity-sidecar.json` | before 时刻的生产 StateStore 快照 + 生产 codex-sessions 目录(只读) | **不可变 identity sidecar**:每个生产 execution ↦ 其 resolved daemon socket 路径(`resolveDaemonSocketPath` 同算法:`~/.flywheel/cdx-sock/<sha1(exec)[:16]>.sock`)与精确 tmux window identity(`sessions.tmux_session` + `tmux_window` 的 `session|window_id|window_name`);写入后只读。fleet 行到 execution 的映射**只认这份 sidecar 的唯一命中** |
| `fleet-diff --before --after --mode live\|post-teardown --declared-sockets <list> --decoy fly2454-decoy [--sidecar identity-sidecar.json --prod-statestore <after 副本> --kill-ledger <dir> --window <from,to>]` | fleet-snapshot 输出 | `live`:after − before 只允许出现声明过的 slot socket,不允许任何 before 行消失;`post-teardown` 三态:`pass`(diff 为空)/ `needs-attribution`(只有 before 行消失,且每一行 ①在 sidecar 里**唯一**映射到一个生产 execution、②该 execution 在 `[window]` 内有终态事件(`session_events` 或 `sessions.terminal_at`)、③slot kill-ledger 无该 socket / window 目标 —— 三者同时成立 ⇒ 输出逐行归因清单,由 Lead 贴入报告)/ `fail`(出现未声明新增、或任一消失行无法唯一映射或无法归因);decoy 每份都在,否则 `fail`。不靠名称猜测 |
| `proc-attribution --baseline <ps> --after <ps> --slot-dir <SLOT_DIR> --checkout <abs> [--mode live\|post-teardown]` | `ps -axo pid=,ppid=,lstart=,command=` | 消失 PID 分 `SLOT` / `NONSLOT`;NONSLOT 非空 ⇒ 待解释清单(C4 回执同款);`live` 模式还列出新增 PID 并要求全部归 SLOT |
| `comm-scan --db <comm 副本> --slot N --exec <id>… --lead flywheel-test-N` | `VACUUM INTO` 副本 | schema-driven:只枚举 `sqlite_master.type='table'` 的**物理表**(view 一律不扫;`messages` / `lead_inbox` 是 poison view,查询必报错,P20)→ `PRAGMA table_info` 取 TEXT/JSON 列 → 每列 `LIKE` 扫 slot 标识;**哨兵**:必须存在物理表 `mailbox`(列 `from_agent/to_agent/type/content`)、`sessions`(`execution_id`)、`three_stage_turn`(`holder_exec_id`)、`runner_workflow_activation`(`execution_id`)、`mailbox_terminal_archive`、`mailbox_log`;另断言 `messages` 与 `mailbox_message_projection` 以 `type='view'` 存在(schema 版本哨兵);任一哨兵缺失 / 空库 / 查询错误 ⇒ 非零退出,绝不报 0 |
| `launch-commits-delta --before <ls> --after <ls> --manifest manifest.json` | 目录清单 + manifest | **bounded delta**:新增 basename ⊆ 声明集,且无未归属项 ⇒ pass。声明集 = manifest 里的 B1/B2/B3/QA/前置一次性体(由各自 start receipt 记录)**+ replacement 集**;replacement 集**不接受手工追加**,只能由 `observe` 从本轮下界后的 `execution_dead_rolled_back`(旧 execution=B1、run/node 匹配)与 `rework_replacement_materialized`(同 `newExecutionId/launchOrdinal`)因果对自动收养 `newExecutionId`,再由同 `requestId` 的 `rework_replacement_launched` 确认。报告披露这些宿主回执拆房后保留(P11) |
| `prod-statestore-check --db <生产 teamlead.db 在线快照> --exec <id>…` | 由宿主机 `sqlite3 "file:$HOME/.flywheel/teamlead.db?mode=ro" "VACUUM INTO '<snap>'"` 生成(生产库是 WAL,复制主文件或直接 `immutable=1` 开活库都会漏 WAL),工具再以 `immutable=1` 开快照 | `session_events` 中 `source='bridge.codex-session-reown'` 且 execution 属房内的行 = 0;`sessions` 无房内 exec;快照缺 `session_events`/`sessions` 表 ⇒ 非零 |
| `alert-dirs-attribution --before <清单+内容 sha> --after … --slot-lead flywheel-test-N` | `~/.flywheel/meta-alert/`、`~/.flywheel/alert-deadletter/` | 新增 / 变更文件按**内容里的 `leadId`** 归属;slot lead 归属的 = 污染清单(FLY-2182 已知会漏死信),交 Lead 隔离;生产 lead 归属的按真死信留 |
| `runner-windows --before <n> --after <n>` | `tmux -S /private/tmp/tmux-$(id -u)/default list-windows -a` 过滤 `runner-flywheel` 计数 | 相等,或差异由生产 StateStore 事件解释 |
| `room-info hide-precheck\|hide-postcheck\|restore-precheck\|restore-postcheck --slot-dir --manifest` | `room-info.json` | `hide-precheck`:原名存在、hidden 不存在 ⇒ 记录 sha256 / mode / inode / mtime 到 manifest;`hide-postcheck`:hidden 存在且 hash 一致、原名不存在;`restore-precheck`:hidden 存在且 hash/mode 与 manifest 一致 **且原名不存在**,否则非零退出、**不允许任何 mv**;`restore-postcheck`:原名存在且 hash 一致、hidden 不存在。宿主机的 mv 一律 `mv -n`(no-clobber),顺序固定 precheck → `mv -n` → postcheck;两名并存 ⇒ 两份都留、报 Lead |
| `dry-run --runbook host-runbook.md` | 路书 | 逐步抽取真实命令串,交给 `python3 -c 'import …; scan_block(cmd)'`(P13,零副作用);任一命中 ⇒ 非零;并检查四段齐全、绝对路径、`manifest adopt` 前置 |

### 3.3 `scripts/__tests__/qa-fly-2456-drill-tools.test.mjs`(hermetic,`node --test`)

- `campaign-shape`:按 P12 真实列名建最小表;通过例(B1 两行 spawn/wake、B2/B3 一行、资格齐);失败例:B1 一行;三行 `(replacement,wake,wake)`(通用解析器接受、campaign 门拒绝);attempt 2 指向别的 execution;B1 running 无 gate(⇒ 预期 watch,不合格);B3 是 holder(⇒ 不是阴性对照);
- `observe` + `verdict`:修前样本(2352 exploration §3.1 逐字五行,配 `id/ts` 与 `episode_id`)⇒ `drift_exhausted`→`replaced`;修后样本 ⇒ `succeeded`;边界样本:cycle ① 的事件 id 低于下界不得混入 cycle ②;错误列名(`created_at`)⇒ 必红;0 行 ⇒ `excluded_or_ineligible`;`reown_watch_started` ⇒ `watch_only`;`reown_skipped_not_turn_holder` ⇒ `skipped_not_holder`;
- `comm-scan`:fixture 用**当前 CommDB schema**(`MAILBOX_SCHEMA` + poison views)建库;含 / 不含 slot 标识各一例(标识放在物理 `mailbox` 与 `sessions` 两张不同表)⇒ 命中 / 0;钉住 `messages` 为 poison view 且不被扫描;缺表 ⇒ 非零;
- `proc-attribution`:用 C4 回执的 SLOT/NONSLOT 行做 fixture,归属结果与回执一致;`live` 模式新增 NONSLOT ⇒ 非零;
- `fleet-diff`:`live` 声明 socket 通过 / 未声明 socket 拒绝 / before 行消失拒绝;`post-teardown` 空通过 / decoy 缺失拒绝;
- `launch-commits-delta`:新增全属声明集通过;多一个未归属拒绝;
- `manifest adopt` 四态:每种副作用各一组「intent 在、receipt 缺、权威状态显示已发生」⇒ `adopt-existing` 且不执行(deploy:room-info + health;adoption:yaml 含 simple_code;start:`workflow_start_reservation` 命中 intent 的 idempotency_key;park 三段:远端 marker / open PR / ship_parked+park_opened;QA fail:credential 已消费 + `authority='qa'` request/route/delivery;operator rework:`operator_rework:<run>:<clientRequestId>` event_uid;gate:P17 同 SQL 恰 1 行 ⇒ 收养 questionId;terminate-前置:intent 之后的 `terminated` + 动作事件;terminate-兜底:任一终态 ⇒ `adopt-existing-noop`;decoy:恰 1 窗口;room-info:hidden 已在;teardown:目录已缺 + 归档在;cycle:old PID 不存活且 `bridge.pid` 为新 PID 且 spec 相同);「权威状态与 intent 不符」⇒ `conflict`(start:同 issue 别的 reservation;cycle:哨兵 `cycle-failed` 或 intent 缺 pre-state 字段;gate:两行 pending 或 relay_state=terminal_disposed / superseded 的旧行;terminate-前置:目标在 intent 前已自然 completed/failed);receipt 与权威一致 ⇒ `replay`;副本 `meta.json.observedAt` 早于 intent 或缺失 ⇒ 拒绝;
- gate 反例:`relay_state='terminal_disposed'` 或 `superseded_at` 非空但无 response 的旧问题 ⇒ 不算 open,`campaign-shape` 拒绝、adopt 返回 `execute`;
- liveness wrapper 输出 shape 测试:fixture 为真实命令输出(verdict 字符串 + 独立取证字段),缺 holderPids 或前后 persistedPgid 不同 ⇒ 拒绝;
- `fleet-identity` / `fleet-diff needs-attribution`:sidecar 唯一映射 + 窗口内终态 + ledger 无目标 ⇒ needs-attribution;映射不唯一 ⇒ fail;
- `campaign-shape` liveness:holder pgid ≠ persistedPgid ⇒ 拒绝,即使 verdict 字段写着 alive;B3 `unknown` ⇒ 拒绝;
- `observe` 因果链:fixture 保持 P16 的真实 payload(exhausted 无 episodeId、launched 记在新 execution),链能串起;人为改 `newExecutionId` 不一致 ⇒ replacement 不被收养;
- `launch-commits-delta`:手工往 manifest 塞 replacement id ⇒ 被忽略并报错,只认 observe 收养的;
- `room-info`:端到端命令序列测试(临时目录):正常 hide→restore 通过;原名与 hidden 并存且内容不同 ⇒ restore-precheck 非零且两文件字节不变;hash 失配 ⇒ 非零;
- `fleet-diff post-teardown` 三态:空 ⇒ pass;消失行有生产终态事件且 ledger 无目标 ⇒ needs-attribution;未声明新增 ⇒ fail;
- `comm-scan` 哨兵:空库 / 缺 `three_stage_turn` / `mailbox` 缺 `from_agent` / `messages` 不是 view 四例均非零;
- `prod-statestore-check`:缺表非零;
- `dry-run`:对路书与工具自身零命中;钉住三条官方 primitive(deploy / cycle / teardown)ALLOW,以及 P1 / P2 / P3 各一条反例 DENY。
登记进 `.github/workflows/ci.yml` 的 script-tests lane,`ci-shell-suite-enumeration.test.sh` 认得它。

### 3.4 文档

- `drill-report.md`:两轮 `verdict.md` 拼装(零表格,ship report 骨架:一句话 → 修前 → 修后 → 生产零影响 → 夹具与盲区 → 建议),由 Lead 投 FLY-2352 thread;
- 同文件夹 `founder-design.html`(设计节点产出)、实施后的 `founder-report.html`;
- `doc/qa/framework/529-room-playbook.md` §7 追加三小节:「reown 演练必须隐藏 room-info(FLY-2211 排除,豁免见 FLY-2487)」「reown 资格:gateHeld 或 parked,且是 TURN holder」「严格基线 = 拆房前一刻;launch-commits 是 bounded delta 不是零」。

### 3.5 Lead 裁定(question `aa0f4fe9`,2026-09-10)

- 本演练走方案 A(隐藏 `room-info.json`),两轮同夹具,plan / 报告显式标注并引用 `isCodexReownExcluded`(`codex-session-reown.ts:356`);
- 方案 B 已另立 **FLY-2487**(blocked-by FLY-2456,`dependency discover` parent_op `bde9fea0`);
- 生产 comm.db 判据 = `VACUUM INTO` 快照 + diff 无 slot 标识 + fleet-snapshot diff 为空;报告说明活 WAL 库不可逐字比对。

### 3.5a Lead 裁定记录(question `ae9c9345`,2026-09-10,设计评审安全阀)

- Codex 三轮(R1 9 条 → R2 7 条 → R3 7 条)后按安全阀上报;Lead 裁定 **A**:R3 七条全部吸收为 v5,**不新增范围**;跑**一轮**有界 R4,范围只限核验这七条。
- 出口:(1) R4 APPROVED ⇒ 照常发布 + `phase_design_complete`;(2) R4 只剩 LOW/MEDIUM ⇒ 写进本 plan 的「follow-up」段,`ask --report` 引用 request id 申请 leadAcceptance,不跑 R5;(3) R4 出现新 HIGH/BLOCKER ⇒ 停手不改,带精确 finding key 报 Lead。
- 演练形状冻结:隐藏 room-info 夹具、两轮同夹具、修前轮 `--no-lead`、宿主机步骤 = 复制命令 + 期望输出、PID 归属的非 slot 进程对照。
- 自此只追加 commit(不 amend / 不 force-push);此前一次 amend+force-push 已自报(report `8627230a`)。

### 3.5b 修订轨迹

| 版本 | 触发 | 主要变化 |
|---|---|---|
| v1 | 审计 | 三具体 / cycle 原语 / 隐藏 room-info 夹具 / 五面零影响 |
| v2 | Lead `249cfa43` | 宿主机路书与 hermetic 工具分离;PID 归属对照;`--no-lead` 理由;残锁陷阱 |
| v3 | Codex R1(9) | reown 资格硬门(gate + TURN holder,B3 阴性);§7 硬前置原样;launch-commits bounded delta;id/seq 下界;三组零影响对照;manifest;room-info 失败路径;dry-run 真 scanner;形状校验分层 |
| v4 | Codex R2(7) | adopt 四态向权威状态收养;产品 liveness 语义;换体链真实 payload 因果;no-clobber 恢复;WAL-safe 生产快照 / fleet 三态 / comm 哨兵;replacement 只从事件收养;exploration §4 同步 |
| v5 | Codex R3(7)+ Lead `ae9c9345` | start/rework 权威改 reservation / operator event_uid / qa 三表;intent/adopt 覆盖 deploy/adoption/park/QA-fail/decoy 且副本新鲜度;cycle 先捕获后写 intent;comm-scan 只扫物理表(`messages` 是 poison view);liveness 只读 wrapper;gate 同 SQL;fleet identity sidecar;terminate 收养分类 |

### 3.5c Follow-up(Codex R4 APPROVED 时留下的 3 条 MEDIUM 实施精度残留;实现节点必须落实,不改设计)

1. **start 收养的 stage 语义**:只有 `workflow_start_stage.stage='responded'` 且 `workflow_start_response` 存在并与 intent 一致才算 `adopt-existing`;中间 stage(`materialized / admitted / commdb_registered / launch_committed`)走产品自身的 exact-key re-drive(同一 idempotencyKey 重发 `/api/runs/start`)或 fail-closed `conflict`,不得视为完成。QA-fail 的「凭据已消费」不在 CommDB(`runner_workflow_activation` 只有凭据值):先用 CommDB `activation_id` 定位,再查 StateStore `workflow_submission_credential.activation_id / consumed_at`,该 join 固定进 effect-missing fixture。
2. **liveness wrapper 落地写法**:`node --input-type=module` 下用 `import { readFileSync } from 'node:fs'`(不能 `require`);`session.json` 的 PGID 字段取 `daemonPgid ?? daemonPid`;probe、两次 `session.json`、lsof/ps holders、groupState 合并成**一条**真正输出完整 JSON 的命令;测试执行该实际命令而不是喂手造 JSON。
3. **fleet identity sidecar 的 tmux 数据源**:StateStore `sessions` 只有 `tmux_session` 没有 `tmux_window`;实现选用只读 live tmux inventory(与 `listTmuxWindowsByExecutionId` 同字段:`@flywheel_exec_id|session_name|window_id|window_name`)并要求每个 execution 唯一命中;若改用 CommDB 的 `tmux_window`,必须把 WAL-safe 的 CommDB 快照列为 `fleet-identity` 的显式输入。

### 3.6 不做

- 不改 `packages/`;不改 `test-deploy.sh` / `test-cycle-bridge.sh` / `test-teardown.sh` / 护栏 hook;
- 不给 #1128 分支提交;不推 merge commit 到 origin;
- 不动生产 Bridge / Lead / launchd / `.env`;不跑 `restart-services.sh` / `request-restart.sh`;不用 run 级 terminate;
- 实现节点不在 sandbox 里起房、起体、cycle。

## 4. 宿主机路书骨架(实施节点据此写 host-runbook.md;Lead 执行)

### 4.1 前置(一次)

1. **检出**:`/private/tmp/fly2456-r1-main`(`origin/main` detached)与 `/private/tmp/fly2456-r2-fix`(research §4 本地 merge;`git diff origin/main...HEAD --stat -- packages/` 只多 #1128 的 5 个文件);各 `pnpm install --frozen-lockfile && pnpm -r build`;`manifest init` 记 HEAD。
2. **残锁**:`cat /tmp/flywheel-test-slot-{1,4}.lock/pid 2>/dev/null` 期望无;若为 `diagnostic-evidence-pending` / `cycle-failed`,只能 `test-teardown.sh <N>` 释放(P9),不手删。
3. **路书 §7 硬前置(原样;每个副作用同样 intent/adopt/receipt)**:① [intent] 生产默认 tmux `new-window -d -n fly2454-decoy` 并 `list-windows` 确认恰 1 个;② `fleet-snapshot --out pre-before.txt`(decoy 必须已在)+ `fleet-identity` sidecar;③ [intent] 起空房 slot 4(同参数)→ [intent] 起**一具一次性体**(FLY-202,reservation 收养)→ [intent] `POST /api/actions/terminate {execution_id}`(**前置类收养**:必须看到 intent 之后 `status='terminated'` + 动作事件;若体在 intent 前已自然终态 ⇒ `conflict`,换体重做)→ 等 **≥2 个维护 tick(≥10 分钟)**;④ [intent] `test-teardown.sh 4`;⑤ `fleet-snapshot --out pre-after.txt` → `fleet-diff --mode post-teardown` 为 `pass`(或 `needs-attribution` 且逐行贴出);⑥ 核 `~/.flywheel/qa-evidence/slot-4/<ts>/` 归档存在且 `kill-ledger` 无 `isolation_boundary` 拒绝。任一不满足 ⇒ 不进 R1。一次性体的 execution 记入 `launch-commits-delta` 的声明集。
4. **Codex 额度**:隔离 `CODEX_HOME` 拷贝 `codex doctor` exit 0。
5. `~/.flywheel/state/complete-failed/` 为空;三张沙箱 issue 可读(FLY-202 / FLY-145 / FLY-146)。

### 4.2 每轮(R1 slot 4 @ r1-main / R2 slot 1 @ r2-fix;串行;每步先 `manifest adopt`)

```
snapshot before      # fleet-snapshot / codex 分桶 / comm VACUUM INTO / launch-commits ls / prod health / ps 全量 / runner-flywheel 窗口数 / 生产 teamlead.db 在线快照(mode=ro + VACUUM INTO,不复制主文件)/ alert 目录清单+内容 sha / fleet-identity sidecar
[intent] test-deploy.sh <slot> --generalized --codex-runner --no-lead --expect-head <sha> [receipt]
[intent] verify-room + adoption 热加 simple_code [receipt]      # /health 双 SHA;room-info.runnerMode=="real";六条 binding
[intent] spawn B1 FLY-202 ; spawn B2 FLY-145 ; spawn B3 FLY-146 [receipt]   # 用 manifest 里的 idempotencyKey;收养按 workflow_start_reservation;四证齐;socket 路径记入声明集
[intent] park B1 ; park B3 [receipt ×3 段]    # marker commit → gh pr create(先 gh pr list --head)→ complete --route needs_review --pr;每段各自 intent/adopt
[intent] wake B1 [receipt]   # QA 判 fail(代 QA env;收养按 credential 消费 + authority='qa' 三表);失败改 POST /api/runs/<runId>/rework(manifest clientRequestId;收养按 operator_rework event_uid);等 wake_delivered
[intent] gate B1 ; gate B2 [receipt]   # 代 runner env:flywheel-comm gate question --lead flywheel-test-<N> --exec-id <exec> --no-block "FLY-2456 drill hold";收养用 P17 同 SQL
liveness             # 路书里的只读 evidence wrapper(P21)写 liveness.json(verdict / socketPath / persistedPgid ×2 / groupState / holderPids)
VACUUM INTO 副本 → campaign-shape(硬门:形状 + 资格;B3 必须是非 holder 的停驻体)
pre-state 只读捕获(old PID / lstart / PPID 链 / log 偏移 / bounds)→ manifest intent cycle-1(原子,含全部 pre-state)→ cycle ①(room-info 未藏)→ receipt → 60 秒后 VACUUM INTO → observe   # 期望 B1/B2/B3 皆 0 行(正对照,证明排除生效)
[intent] room-info hide-precheck → mv -n room-info.json room-info.json.drill-hidden → hide-postcheck [receipt]
pre-state 只读捕获 → manifest intent cycle-2 → cycle ②(必须在 wake 后 ≤5 分钟;超时:[intent] POST /api/actions/terminate {execution_id:<QA attempt-1>, reason}(兜底类收养)→ 重跑 campaign-shape、确认 run 仍 active、重算 5 分钟窗)→ receipt
每 60 秒 VACUUM INTO → observe --until <R1: replaced | R2: succeeded>;上限 15 分钟(可延 30,写进报告)
snapshot live-after  # 房与体都还在:fleet-diff --mode live(只多声明的 slot socket)+ proc-attribution --mode live + comm/launch-commits/prod-statestore/alert-dirs
snapshot pre-teardown   # ps 全量 + 窗口数(严格基线,P9)
room-info restore-precheck → mv -n room-info.json.drill-hidden room-info.json → restore-postcheck
test-teardown.sh <slot>
snapshot post-teardown  # ps + 窗口数 + fleet-snapshot + comm/launch-commits/alert-dirs
工具三组对照 → verdict <round>
```

紧急恢复(任何停手交接前,顺序不可颠倒):`room-info restore-precheck`(非零 ⇒ 停在这里,两份都留、报 Lead,**不执行 mv**)→ `mv -n room-info.json.drill-hidden room-info.json` → `room-info restore-postcheck`。恢复路书任何一步前先 `manifest adopt --step <id>`,按四态行事;`conflict` ⇒ 停手。

### 4.3 终局归类(每具体,取 cycle ② 下界之后**第一个** episode)

- `succeeded`:`reown_revive_succeeded`;
- `drift_exhausted`:同一 `episode_id` 下两条 `reown_revive_failed` 的 reason 以 `workflow capability drift for <exec>` 开头,继而 `episode_exhausted`、`sessions.status='failed'`、`last_error='Codex recovery exhausted after 2 attempts'`;`replaced` 再要求 `rework_replacement_launched` 且新 execution 出生;
- `watch_only`:只有 `reown_watch_started`(体没资格:running 且无 gate);
- `skipped_not_holder`:`reown_skipped_not_turn_holder`(B3 的预期结果);
- `excluded_or_ineligible`:0 行(与 cycle ① 同痕 ⇒ 夹具没生效,停手);
- `other`:原文入账,不归类。

### 4.4 轮验收

- 分母只含 B1、B2(有资格体);B3 单独一行,预期 `skipped_not_holder`,不计成功率;
- R1:B1 = `drift_exhausted`(≥ `replaced`),B2 = `succeeded`;B1 的 `codex_recovery_capabilities_prepared` = 0 条;
- R2:B1、B2 = `succeeded`;B1 另有 `codex_recovery_capabilities_prepared payload.attempt=2`;下界之后全库无 `capability drift` 文案;
- 两轮:cycle ① 三体 0 行;`fleet-diff live` 只多声明 socket、`post-teardown` 为 `pass` 或 `needs-attribution`(归因清单贴进报告)且 decoy 在;`proc-attribution` 三组对照(before→live-after 无 NONSLOT 消失且新增全 SLOT;before→post-teardown 回基线或逐条解释;pre-teardown→post-teardown 只归 teardown)NONSLOT 待解释清单为空或逐条被生产 StateStore 事件解释;`comm-scan` 前后都 0;`launch-commits-delta` 新增 ⊆ 声明集;`prod-statestore-check` 0 行;`alert-dirs-attribution` slot 归属清单为空或已交 Lead 隔离;`runner-windows` 相等或被解释;生产 `/health.uptime` 单调且 `buildSha` 不变;`state/kill-ledger` 无 `isolation_boundary` 拒绝(有则逐条解释)。

### 4.5 停手条件(不硬闯)

前置 §7 任一项不满足;`codex doctor` 非 0;`room-info.runnerMode != "real"`;`/health` SHA 失配或 HEAD ≠ manifest;`campaign-shape` 非零(含资格项);cycle ① 出现 reown 事件(排除没生效,别再藏);cycle 撞 `cycle-failed` 哨兵;`room-info restore-precheck` 冲突或 `manifest adopt` 返回 `conflict`;残锁释放失败;teardown 两次撞 lease;FLY-913 拦截 —— 任一命中就停,先做紧急恢复,再按可证伪障碍(命令 + 输出 + 判据)报 Lead。

## 5. 测试(先红后绿)

- §3.3 用例先写,工具子命令再写到刚好让它们绿;
- 输入一律 fixture 文件(从 2352 exploration、C4 回执抄的逐字行 + 自造修后 / 边界序列),按 P12 真实列名建表,不连任何真库、不 spawn;
- 真机部分不写自动化断言,其证据由 §4.2 的文件落盘并在 `verdict.md` 引用。

运行:`node --test scripts/__tests__/qa-fly-2456-drill-tools.test.mjs`;`bash scripts/__tests__/ci-shell-suite-enumeration.test.sh`。

## 6. 回滚与残留

- 纯脚本 + 文档,无 schema / flag / 产品代码;回滚 = revert PR。
- 演练期间可逆的:`room-info.json` 改名(§4.2 恢复步骤:restore-precheck → mv -n → restore-postcheck);生产默认 tmux 上的 `fly2454-decoy` 窗口(手工关);两个 `/private/tmp` 检出(删目录);`gate --no-block` 问题(随 slot CommDB 一起删)。
- **拆房后仍保留的宿主 / 远端痕迹(报告必须披露)**:`~/.flywheel/state/launch-commits/<exec>`(每具体一个,P11);`~/.flywheel/qa-evidence/` 归档;沙箱仓远端分支与 PR(标题带 do not merge,拆房后 `gh pr close`,历史保留);可能漏到 `~/.flywheel/alert-deadletter/` 的 slot 死信(交 Lead 隔离)。这些不是「零影响」的反例,是已登记的已知写点。

## 7. 稳定标识 / 展示文案

| 东西 | 值 |
|---|---|
| 证据根 | `~/.flywheel/qa-evidence/FLY-2456/<r1\|r2>/` |
| 检出 | `/private/tmp/fly2456-r1-main`、`/private/tmp/fly2456-r2-fix` |
| 体标签 | `B1`(多 activation 靶,gate+holder)、`B2`(单 activation,gate+holder)、`B3`(单 activation,parked 非 holder,阴性) |
| 终局词 | `succeeded` / `drift_exhausted` / `replaced` / `watch_only` / `skipped_not_holder` / `excluded_or_ineligible` / `other` |
| 进程归属词 | `SLOT` / `NONSLOT` |
| 夹具名 | `room-info.json.drill-hidden`;gate 文本 `FLY-2456 drill hold` |
| 沙箱 PR 标题 | `test(FLY-2456): restart drill fixture <label> (do not merge)` |
| 报告标题 | `FLY-2456 · 529 真机重启演练(2352 reown)· 修前/修后对照` |

## 8. 风险与已知限制

1. **两个夹具是本演练的信度边界**:隐藏 room-info 只解除排除;`gate --no-block` 只是让体进入生产事故同款的 `gateHeld=true` 资格(生产 15 具 drift 体的 attempt 1 都是 `liveness=alive gateHeld=true`),都不改 reown 逻辑。报告必须写明。
2. **Codex 额度**:三具真体 × 两轮 + 前置一次性体 = 7 个 daemon,共用生产 auth 池;撞 429 体会 `blocked`,按「体不合格」停手。
3. **wake 后的 QA attempt-1 真 Claude 体**:wake 后若 QA attempt 2 派工撞 FLY-2208 跑道占用,run 可能 10 分钟后 `held` ⇒ B1 被 `reown_skipped_superseded`。对策:cycle ② 在 wake 后 ≤5 分钟;超时用 session 级 terminate 收掉 QA attempt-1(P14),重跑 `campaign-shape` 确认 run 仍 `active` 再 cycle;两次不成改走 operator rework。
4. **修前 attempt 2 的等待**:5–15 分钟;超时延到 30 要写进报告。
5. **B1 在 R1 换体后**:替换体是新 execution、单 activation,会在下一 pass 被认回 —— 单独一行入账。
6. **本地 merge 头不是 CI 验过的字节**:报告写明并附 diff 统计;#1128 先合入则 R2 直接用 main。
7. **`--no-lead`**:房里没有 Lead,gate 问题永远 pending(正合所需),founder gate / Discord 面不在观察范围。
8. `hasOpenGate` 读的是 slot CommDB 里 `from_agent = exec` 的 pending question;`gate --no-block` 必须以**该体的 env**(`FLYWHEEL_EXEC_ID`、`FLYWHEEL_COMM_DB`)执行,否则 gate 挂错人。
9. 不覆盖 2352 §4 第 2 条(生产首次重启窗口的形状对照)与 L1。

## 9. 验收清单(交 QA / Lead)

- [ ] 前置 §7 六项(decoy / 一次性体 terminate / ≥2 tick / teardown / diff 空 / 归档可读);
- [ ] R1/R2 各三具体四证齐;`campaign-shape` 通过(B1 两行同 execution + 资格,B2 资格,B3 阴性);
- [ ] cycle ① 三体零事件;
- [ ] R1:B1 `drift_exhausted`→`replaced`,B2 `succeeded`,B3 `skipped_not_holder`;R2:B1/B2 `succeeded` 且 B1 `prepared attempt=2`;
- [ ] 零影响九项(fleet live/post、proc 三组、comm、launch-commits bounded、prod-statestore、alert-dirs、runner-windows、health、kill-ledger)全绿或逐条解释;
- [ ] hermetic 测试绿 + 登记 CI;`dry-run` 对路书通过;
- [ ] `drill-report.md` + `founder-report.html` 由 Lead 投 FLY-2352 thread(零表格、ship report 骨架、写明两个夹具与残留);
- [ ] 两个检出、沙箱 PR、decoy 窗口、gate 问题清理完毕;room-info 已恢复。
