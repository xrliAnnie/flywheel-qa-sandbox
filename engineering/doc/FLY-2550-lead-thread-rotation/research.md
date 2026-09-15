# FLY-2550 常驻 Lead 线程轮换 — 调研
Issue: FLY-2550 (https://linear.app/geoforge3d/issue/FLY-2550/2355e-常驻-lead-记忆蒸馏真拦点-codex-threadsid-current-thread-id-排除常驻-lead-永不换)
日期: 2026-09-14
基于: exploration.md

> 所有 Codex 引用按生产版本 **0.154.0**(`git clone --depth 1 --branch rust-v0.154.0`,路径相对 `codex-rs/`)。所有生产读数取自 scratchpad 里的**拷贝**;没有写任何家、没有改任何配置、没有重启任何进程。

## 1. 轮换后旧线程为什么一定会进候选(逐条件对照)

候选条件(`state/src/runtime/memories.rs:196-249` + `threads.rs:1400-1416`)与轮换后旧线程 `T_old` 的状态:

| 条件 | `T_old` | 由谁保证 |
|---|---|---|
| `archived = 0` | 保持 0 | 本设计**不调** `thread/archive`(它只把 `archived=1`,`thread_processor.rs:611-632`) |
| `source ∈ {cli,vscode,atlas,chatgpt}` | `vscode` | daemon 建线程时定的,不变(`app-server/src/lib.rs:435`) |
| `memory_mode = 'enabled'` | 保持 | 本设计不调 `thread/memoryMode/set`;`disable_on_external_context` 默认 false(PRD §5.6.3 ⛔ 不动) |
| `id != current_thread_id` | 新线程是 current | `thread-id` 文件改指新线程;旧线程不再被 `thread/resume`(`ensureThread` 只 resume `thread-id` 里那一个) |
| `updated_at_ms ≤ now − 6h` | 最后一轮 = fence 建立前的最后一次真实 turn | fence 起零 turn:router 暂停、pane 已杀并验证、`turns/list` 非进行中;换页后 Discord/mailbox 路由绑定新线程,pane 重开到新线程(`tui-window.ts:139-190`),旧线程不再 resume |
| `updated_at_ms ≥ now − 10d` | 下一次 startup 在 ≤6h 内 | Bridge `summary_due` 每 6h 一次(FLY-2382,journal 实测 00/06/12/18 UTC)⇒ 新线程每天 ≥4 次 `turn/start` ⇒ ≥4 次 memory startup(`turn_processor.rs:669-678` 每个有输入的 turn 都触发) |
| 额度守卫 ≥25% | 不由本设计控制 | `memories/write/src/start.rs:60-67`;09-14 19:00 实测再次跳过 ⇒ 验收要把 `skipping memories startup because Codex rate limits…` 记为可见原因 |
| `preview <> ''`、`has_user_event` | 有真实用户消息 | 旧线程至少有轮换前的对话 |

`updated_at_ms` 的写入点只有三处(`state/src/runtime/threads.rs:771, 2893, 3358`):turn 落盘时、`touch_thread_updated_at`(`rollout/src/state_db.rs:722`,rollout 写入阶段)、以及 `upsert_thread`(`reconcile_rollout`,`state_db.rs:560-600`,resume/扫描时按 rollout 元数据 upsert)。`thread/list`、`thread/read` 只读。⇒ 只要旧线程不再被 resume、不再有 turn,它的 `updated_at` 就冻结。

## 2. 为什么不用 `thread/fork`(实证)

- `thread_fork_inner`(`app-server/src/request_processors/thread_processor.rs:4757-5040`):源线程 `history_mode='legacy'`(Mufasa 主线程实测 `legacy`)⇒ `read_stored_thread_for_resume(include_history=true)` 读**全部**历史 → `fork_thread_from_history` → `spawn_thread(InitialHistory::Forked(items))`。
- `core/src/session/mod.rs:1478-1515 record_initial_history`:`ForkPersistence::Copied` 分支「Keep the copied prefix … `persist_rollout_items(&rollout_items)`」⇒ 新线程的 rollout 文件**包含整份旧历史**;`SessionMeta.forked_from_id`(`rollout/src/recorder.rs:846`)只是血缘元数据,stage1 读 rollout 时不会因此剔除(`memories/write/src/phase1.rs:291-292, 406-431` 只按 item 类型过滤)。
- `ThreadForkParams`(`v2/thread.rs:519-600`)没有 `historyMode`;只有 `lastTurnId`/`beforeTurnId` 能**砍掉后缀**(`truncate_rollout_after_turn_id`),砍不掉前缀。
- ⇒ 第 N 次 fork 轮换后,`T_old` 的 rollout = N 代家谱;stage1 每次都保头保尾截到 70% 窗口(`prompts.rs:100-117`),越往后「中间」丢得越多、摘要越重复、单次输入始终顶格。

## 3. 轮换周期的算式(Mufasa 实测)

- 主 rollout 7,096,220 B(06-09 → 09-14)。按 ISO 周统计**只算 stage1 会喂给模型的 item**(`response_item` 中 message / function_call / function_call_output / reasoning,与 `serialize_filtered_rollout_response_items` 的过滤一致):W33 59,846 B、W35 24,505 B、**W36 599,673 B**、W37 122,545 B、W38(至 09-14)257,125 B。
- stage1 输入上限 = 模型有效窗口 × 70%(`CONTEXT_WINDOW_PERCENT=70`,`lib.rs:98`);Mufasa `modelContextWindow` 258,400(`metrics/context-usage.jsonl`)⇒ ≈ **180K token**;中英混排 JSON 粗估 1 token ≈ 2–3 字节 ⇒ ≈ 360–540 KB。
- ⇒ 以 **7 天**为周期,W37/W38 这种周整份进得去;W36 那种重周会被保头保尾截断(Codex 原生行为,不是失败)。更短周期(3 天)可让重周也进得去,代价是 founder 多一次「换页」。本单取 7 天为常量,理由:一周正好对齐 FLY-2119 的验收窗口与 founder 的心智(「每周换一页」);常量集中在一处,想改只动一个数字。
- 首次轮换的旧线程是 97 天/7.1 MB 那条:它会被截到 180K token(保头保尾),**中间约 90% 不进摘要**。接受:那是历史债,不是设计要还的。

## 4. 新线程为什么不携带任何旧对话(R1/R2 两轮的结论)

- v1 让模型在旧线程写便签:R1 指出那是一轮无人确认、继承 Lead 全部工具权限、超时也无法取消(`CodexTurnExecutor` 只有 `startTurn/awaitCompletion/reconcile`,超时只放弃等待)的自动 turn。
- v2 改为运行时从旧 rollout 机械摘录进 `developerInstructions`:R2 指出 developer 层权限高于 user 内容,新线程紧接着的既有 full-access bootstrap turn 会把历史 user 命令当高权限指令消费,是新的 authority crossing。
- ⇒ v3:`developerInstructions` 只放代码内置固定文本(`rotationDeveloperNote`,嵌入经 `THREAD_ID_RE` 校验的上一页线程 id 与 ISO 时间),连续性只靠 Codex 记忆摘要 + journal 恢复(换页期间到达的输入在新线程上照常回答)。诚实代价:换页后第一句可能要重述上下文。若将来要「带一点旧对话」,只能走低权限、不自动执行的通道,另开设计单。

## 5. 运行时接缝(全部已存在,轮换只是把它们串起来)

| 缝 | 位置 | 轮换怎么用 |
|---|---|---|
| 线程真相 | `readThreadId/writeThreadId`(`codex-lead-runtime.ts:1156-1168`),文件 `<stateDir>/thread-id`,`writeFileSync` 非原子;`readThreadId` 把缺失/读错/空文件都折叠成 `undefined` | 仍是唯一真相;TUI 路径改用 `readThreadIdStrict`(只有 ENOENT 算首启,其余 fail-loud);写改为「临时文件 + rename」原子写 |
| 每代启动顺序 | `CodexLeadRuntime.start`:`startProcess → ensureThread → wire → recover → startGateway`(`CodexLeadRuntime.ts:9-13`) | 轮换动作放在 `ensureThread`:此时 gateway 未开、路由未建、**没有并发 turn** |
| demux / founder 观察 | `wireDemuxedProcess`(`codex-lead-tui-runtime.ts:288-330`):`toExecutor` 处理 sidecar 自己的 turn,`toObserver` 收 founder(foreign)turn 事件,现只回调 `onFounderTurnCompleted`;`CodexLeadProcess.request` 公开(`:329`),**全局每请求超时 60s**(`:103, :143`);`reconcile` 用 `thread/read`。0.154.0 `thread/turns/list`(`app-server/src/request_processors/thread_processor.rs:3060-3114`)支持 `limit/sortDirection/itemsView`,`TurnStatus = completed|interrupted|failed|inProgress`;**legacy 线程每次请求都全量重放 rollout**(源码注释) | 新增 `onFounderTurnStarted`;fence 用 `thread/turns/list {limit:1, desc, itemsView:"notLoaded"}` 经局部 10s wrapper,只有明确 terminal 才放行;实施前先在 7.1 MB 只读拷贝上量延迟(plan C0) |
| 代重建入口 | `DaemonConnectionSupervisor`:只有 `onConnectionLost` 触发 `onLoss` 重建(`DaemonConnectionSupervisor.ts:120-200`);无公开「主动重建」 | 新增 `requestRebuild(reason)`:复用 `onLoss` 的同一条路(fence → stop → ensureDaemon → 新代),不走 backoff 首步等待;普通 loss 语义(保 pane、带 backoff)不变 |
| 线程变化 ⇒ TUI 重开 | `ensureTuiHealthy`:`ownedTuiThreadId !== tuiSpec.threadId` ⇒ 无条件 `ensureTuiWindow`(杀同名 window 再建,`tui-window.ts:139-190`);**liveness 定时器每 20s 调它,窗口死了就重建**(`codex-lead-tui-runtime.ts:541-559, 913-923`),只有代 `stop()` 才清;`killTuiWindow`(`:233-245`)现为 fail-open `void`,忽略 kill 结果;无 rollout 的新线程在 `wire()` 里先跑一次 ≤90s 的既有 bootstrap turn(`:846-887`) | `killTuiWindow` 改为返回验证过的 boolean;fence 期间 `rotationFenceHeld` 让 liveness 只 probe 不 create;`ensureTuiHealthy` 返回 pane 是否存活;bootstrap outcome 记进 `rotation_bootstrap` 回执 |
| journal 恢复 | `LeadJournal` `accepted` 条目在新代 `recover()` 自动重派,`dispatching`/`ambiguous` 不重派(`LeadJournal.ts:7-20`);founder 终端 turn 以 `state='completed'` 观察行入库(`recordObservation`);`JournalStore` 接口与内存 store 在 `LeadJournal.ts`,生产 SQLite 在 `SqliteJournalStore.ts:78-324`(表有 `created_at`,现只有 `journal_state_idx`) | 零改动:fence 期间 `router.pause()` 只让输入停在 `accepted`,新代重派到新线程;新增 `countCompletedSince` 三处实现 + `(state, created_at)` 索引作「本页有真实对话」门 |
| 空闲信号 | `LeadInputRouter.whenIdle()`(`LeadInputRouter.ts:236-240`);`submit()` 同步 durable accept + 入队 + `pump` 置 `processing`(`:199-210, 266-274`),所以「查一次空闲」不是 fence | 新增 `pause()/resume()`:pause 后 `pump` 不出队,输入停在 `accepted`;fence = pause → 杀 pane 验证 → 等真空闲 → `turns/list` |
| 回执落点 | `<stateDir>/brain/lifecycle.jsonl`(名册 Lead)、`metrics/context-usage.jsonl` | 本设计**不改**这两个合同(巡逻在读它们);新开 `<stateDir>/thread-rotation.jsonl` |
| 回滚开关先例 | FLY-2460 `FLYWHEEL_CODEX_MEMORY_DISTILL=off`(`run-infra.ts` 解析一次) | 同形:`FLYWHEEL_CODEX_LEAD_THREAD_ROTATION=off`,在 `parseCodexLeadTuiRuntimeConfig` 解析一次 |
| rollout 定位 | `rolloutExistsFor(codexHome, threadId)`(`codex-lead-tui-runtime.ts:421-440`)按 `e.name.includes(threadId)` 递归扫 `sessions/`(会接受后缀伪装/多匹配) | 只用于给账本 `startedAt` 播种:`rolloutTimestampFor` 要求 basename 精确匹配 `rollout-<ISO>-<uuid>.jsonl` 且唯一,否则用 `now`;不读正文 |

## 6. 验收怎么量(给 QA 与 founder 一周观测)

```sh
# 旧线程是否进了候选(T = 任一 startup 时刻;MAIN = 新线程 id)
cp -p ~/.codex-mufasa/state_5.sqlite* "$SCRATCH/"; sqlite3 "$SCRATCH/state_5.sqlite" \
  "select count(*) from threads where archived=0 and memory_mode='enabled' and id!='$MAIN'
   and updated_at_ms >= (strftime('%s','$T')-10*86400)*1000 and updated_at_ms <= (strftime('%s','$T')-6*3600)*1000;"
# stage1 是否认领了旧线程
cp -p ~/.codex-mufasa/memories_1.sqlite* "$SCRATCH/"; sqlite3 "$SCRATCH/memories_1.sqlite" \
  "select kind,job_key,status,worker_id from jobs where kind='memory_stage1';
   select thread_id,length(raw_memory),length(rollout_summary),rollout_slug from stage1_outputs;"
# 真摘要落盘
ls -la ~/.codex-mufasa/memories/rollout_summaries/
# 额度闸是否在窗口内拦过(可见原因,不是失败)
cp -p ~/.codex-mufasa/logs_2.sqlite* "$SCRATCH/"; sqlite3 "$SCRATCH/logs_2.sqlite" \
  "select datetime(ts,'unixepoch'), file, substr(feedback_log_body,1,120) from logs where file like 'memories/%' order by ts desc limit 20;"
# 本设计自己的回执
tail -n 20 ~/.flywheel/state/codex-lead/mufasa-lead/thread-rotation.jsonl
```

QA 若不想等 6h:在**529 房拷贝的家**里按 FLY-2460 exploration §2.6 的配方起一次 `codex exec … -c memories.min_rollout_idle_hours=1 -c memories.max_rollouts_per_startup=4` 强制认领(生产家零写入)。

## 7. 与 PRD FLY-2119 的关系

- PRD 在 PR #1024(分支 `flywheel-FLY-2119`,未合入 main)。本单的 PRD 补充写成 `prd-supplement-FLY-2119.md`(本文件夹),内容即未来 PRD §5.7;待 #1024 落地后由持有 TURN 的人原样并入(docs-only,不阻塞本单)。
- PRD §5.1「一周后仍为空 ⇒ 重开诊断,不盲调参数」已由 FLY-2360 执行;本单是诊断的结论落地。§5.6.3 四道闸继续一道不动。

## 8. 验证边界

- C0 已验证:`thread/turns/list(notLoaded)` 对 7,096,220 B legacy 线程为 590.55 / 865.26 ms,两次 completed。见 `codex-review/turns-list-latency.md`。
- 第一次轮换那条 97 天线程的 stage1 是否会在模型侧失败:源码只有 token 截断(`prompts.rs:115`),没有字节拒绝;实施后看 `jobs.last_error`。
- `developerInstructions` 在 `thread/start` 上的字节上限(源码是 `Option<String>`);v3 文本固定 ≈150 字符,远低于任何合理上限。
