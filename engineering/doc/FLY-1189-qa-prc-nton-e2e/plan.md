# FLY-1189 QA·FLY-1048 PR-C 529 Room 真机 N-to-N E2E — 实施计划

Issue: FLY-1189 (https://linear.app/geoforge3d/issue/FLY-1189/qa-fly-1048-pr-c-529-room-真机-n-to-n-e2e统一升级流-bi-4-抑制)
日期: 2026-07-11
基于: research.md(同文件夹;exploration.md 的设计已过 brainstorm gate,Tadashi 2026-07-11 APPROVED)

> **状态:Codex design review APPROVED(4 轮,xhigh)。** R1 8 项(multi-lead 资源生命周期 / ACK 枚举纠正 / S4 时间线拆分 / S7 TTL 不可达改造 / 4-phase 重排+证据外置 / TOCTOU+trap 恢复 / 证据假绿假失败修 / H5c 探针改 preflight)、R2 7 项(pre-boot grace seam / S7 专用 ACKED target / trap 归 driver / quarantine 回安全根 / borrowed-lock finalize / S9 branch-aware+C2' 具名 / SQLite WAL taint 查询)、R3 1 项(S7 并发 interleaving branch-aware)全采纳;R4 APPROVED。反馈存档 /tmp/codex-rescue-design-feedback-flywheel-FLY-1189-plan-round{1..4}.md。

> **For agentic workers(三段式 Implement + QA 阶段照建/照跑):** 本 plan 两段消费——§B(H1-H5)是 Implement 阶段的 TDD 任务;§D 是 QA 阶段的执行矩阵(独立 session 跑,不许由 harness 作者判 verdict 之外还改被测代码)。被测 = **PR #556 @ 98c2108c**(执行时重核 origin ref 指向该完整 SHA,漂移则记录并以新 head 重跑)。

**Goal:** 给 FLY-1048 PR-C(统一升级流 + BI-4 抑制)补上它从未有过的真机 QA:529 Room 隔离环境、真 Bridge + 真 Lead + 真 runner、真故障、真 Discord 证据,核心是 N-to-N(多卡死 runner × 多 owner-Lead)的路由与抑制正确性;全绿才放行 merge gate。

**Architecture:** 单 slot Bridge(生产同形态:一个进程、一张 detection_escalations 表、resolveLeadForIssue 路由)挂 ≥2 个真 test Lead;真故障注入四式全部带 S1 安全锁(三重锚定 + TOCTOU 身份绑定 + trap 强制恢复);campaign 分 4 个部署 phase(teardown 会清 SLOT_DIR,故证据实时落 campaign root);计时用 env 缩短跑主矩阵 + 默认 30min 真等一条。

**Tech Stack:** bash(test-deploy.sh 扩展、注入器、驱动)+ sqlite3(slot teamlead.db 断言)+ curl(Discord API 证据)+ 既有 529 Room 基建。

---

## §0 已锁决定(brainstorm gate,Tadashi 2026-07-11 拍)

| # | 裁定 |
|---|---|
| D1 | N-to-N 拓扑 = **单 Bridge 多 Lead**(路由+抑制同进程同表);test-deploy.sh 加性 multi-lead,flag 未设 = 现状逐字 |
| D2 | 真故障注入(SIGSTOP / 移 worktree / 真 park 不上报 / 真 ask 无人答)+ 两只阴性对照;**S1 安全锁 = 硬要求**(见 §A) |
| D3 | 主矩阵 grace 缩 ~3min;**默认 30min 真等场景必留不许砍** |
| D4 | judge(PR-B)真开 = 生产形态;case-c 主断言走高置信机械路保确定 |
| D5 | E4 = 2 Lead × 2 并发卡死 + 2 对照;fleet guard 单列场景 |
| D6 | Implement 建 harness+smoke;QA 阶段独立执行+verdict;FAIL kickback 给 PR-C 实现者,本单不代修 |
| D7 | founder page 用**真** DISCORD_OWNER_USER_ID(真 @ 即「恰一次不轰炸」硬证据;Tadashi 知会 Annie) |
| D8 | 529 Room 现在归本单;**开跑前自核房空**(lsof 19871-19874 + tmux ls),不只信调度 |

**已定事实(Codex R1 读 98c2108c 源码闭合,不再是未决项)**:gap 类 episode 的 `target_key == execution_id`——`evaluateGapSuspicion` 写 `session.executionId` 为 targetKey(detection-gap-scan.ts:121-127),`buildGapEscalationInput` 原样传入(detection-detector-wiring.ts:73-91),`createSessionTargetResolver` 以 target_key 查 session(detection-escalation-sinks.ts:90-114)⇒ gap 类也能页 founder。matchesExecId=true 记录在案;H5c 相应改为**运行时 preflight**(见 H5)。

## §A S1 安全锁契约(注入器的先决,违者 = harness 缺陷级 FAIL)

背景:同机 19 个生产 runner 在飞。任何 SIGSTOP/SIGCONT/mv 前,目标必须过**三重锚定 + TOCTOU 身份绑定**,全过才执行,任一不过 → exit 2 + 大声报错,**绝不降级执行**:

1. **execId 锚**:目标 execId 必须存在于 slot Bridge 的 sessions 里(sqlite 查 `${SLOT_DIR}/teamlead.db` sessions 表),且是本次 QA 注入清单(注入器落盘的 campaign manifest)里的成员。
2. **tmux 锚**:目标 PID 由 tmux pane_pid 沿进程树向下解析(不接受外部传入的裸 PID);pane 必须属于 slot 命名空间的 session/window;进程树解析结果必须**恰一个** claude 后代——零个或多个都拒。
3. **路径锚**:目标进程 canonical cwd 与待移 worktree 路径必须落在 slot sandbox 前缀下——`realpath` 后按**目录成分边界**比对(带尾 `/`,`slot-2-evil` 不得匹配 `slot-2`);生产 `~/Dev/flywheel*` 与 `~/.flywheel` 命中即拒。

**TOCTOU 身份绑定(Codex R1 #6)**:verify 通过后先落 **append-only action journal**(execId、pane id、PID、**进程 start-time**、command、canonical cwd/worktree、**inode**、source/destination root);执行动作前**立即重读同一 tuple**,要求恰一个目标且 start-time/inode 未变(PID 复用即被抓);变了 → 拒并报。

**quarantine 根(Codex R2 #4)**:break-worktree 的搬移目的地 = `${SLOT_DIR}/qa-moved-worktrees/<execId>`——与路径锚同一安全根,restore 天然合法;campaign root **只存证据**,绝不放 worktree。restore 只允许「source=journaled quarantine 路径、destination=journaled 原 slot 路径」这一个方向。恢复必须发生在该 phase teardown 之前(S9 排序已保证)。

**强制恢复合同——trap 归 driver(Codex R2 #3)**:注入器子命令是一次性进程,自注册 EXIT trap 会在退出时立刻 SIGCONT、毁掉场景——所以生命周期 owner = **driver**:driver 在任何 mutation 前注册自己的幂等 `EXIT INT TERM` trap 并存活到场景恢复;注入器只提供原子、journaled、幂等的 `freeze/thaw/break/restore/recover-from-journal` 操作;driver trap 调 `recover-from-journal`(只用已验证 journal 身份 + 再核 start-time),恢复成功前不得 teardown;正常场景显式恢复后 EXIT trap 二次运行 = no-op。

**journal 全量 invariant = E5 硬门之一(Codex R2 #7)**:campaign 结束核 journal——每个被动过手的 PID 的 canonical cwd 都在 slot/quarantine 安全根内、零生产 PID 出现——这覆盖「误发过 SIGSTOP 但没写生产 DB」的伤害面。

配套:`prod-snapshot` 子命令在每 phase 前后各跑一次——生产 runner PID 集合 + 生产 alert-queue/deadletter/claims.db/comm 根 file-set(复用 qa-fly-529-alert-smoke portable 手法)。**E5 判定用归因制,不用集合绝对相等**(活跃生产机 3h 窗口必有自然 churn,见 §D S11)。

## §B Implement 阶段任务(本 branch,TDD,全套过 Codex code review)

### Task H1 test-deploy.sh 多 Lead 加性扩展(含资源生命周期,Codex R1 #1)

**Files:**
- Modify: `scripts/test-deploy.sh`(FLYWHEEL_PROJECTS jq builder :894 一带 + Lead 启动段 :949 一带 + slot claim/lock 段 + Bridge env 段 :1084 一带)
- Modify: `scripts/test-teardown.sh`(按 manifest 逐 Lead 清理)
- Test: `scripts/__tests__/test-deploy-multilead.test.sh`(hermetic,仿 fly247-bash-suites 判例)

接口(全部加性):
- `--extra-lead <slotId>:<deptLabel>`(可重复):从 test-slots.json 取该 slot 的 botName/botAppId/tokenEnvVar/channelId,给 FLYWHEEL_PROJECTS 的 leads[] 追加 `{agentId:<botName>, chatChannel:<channelId>, botTokenEnv:<tokenEnvVar>, match:{labels:[<deptLabel>]}}`,并启动第二个真 test Lead 进程(claude-lead.sh)。
- `--lead-label <deptLabel>`:把主 Lead 的 match.labels 从 ["*"] 收窄成显式标签(未设 = 现状 ["*"] 逐字)。
- `--detection-lead-grace-ms <ms>`(Codex R2 #1):在脚本**生成 canonical `.flywheel/config.yaml` 时**追加 `detection.lead_grace_ms`——这是 Phase D per-project override 的唯一可用时点(teardown 删 SLOT_DIR、下次 deploy 重 clone + 无条件重写 config + 同一不可暂停调用里起 Bridge,「部署前手写 repo 文件」没有执行窗口)。未设 = 生成内容逐字不变;launch manifest 记录 effective override。

资源生命周期(与接口同等重要):
- **slot claim + finalize(Codex R2 #5)**:对主 + 全部 extra slot 按**排序后的完整集合原子 claim**(现有 `/tmp/flywheel-test-slot-<N>.lock` 机制逐个上锁,任一失败 → 已上的全部回滚释放 + fail-fast)。现逻辑 5 分钟后会把仍是 claiming 态的锁判 stale 回收(test-deploy.sh:71-114),且只 finalize 主 slot(:1124-1128)——**Bridge PID 拿到后必须把同一存活 PID 写进主 + 每个 borrowed lock**,附 sidecar(ownerSlot/campaignId/borrowed=true);任一 finalize 失败 → 整个 deploy 回滚。`test-teardown.sh <借用slot>` 遇 borrowed lock → fail-loud 指向 owner slot(不许只删锁)。
- **per-Lead 资源**:每个 extra Lead 独立 discord-state dir、identity(AGENT_SOURCE)、access.json、log(现脚本只为主 Lead 生成,:681-723);Bridge env 显式接收**全部** `tokenEnvVar=value`(现只传主 Lead,:1084-1099)。
- **campaign manifest**:资源清单(slots、Lead PID/window、state dirs、workspaces)落 `${SLOT_DIR}/campaign-manifest.json`;**launch manifest(无 secret)**同时记录 Bridge PID、5 个 bool flag、数值 knob、dist SHA——S0 的 flag 实测依据(macOS `ps eww` 读不到别进程 env,alert-mirror suite :32-34 已明示,不用它)。
- **teardown**:`test-teardown.sh` 按 manifest 逐 Lead 清 supervisor/tmux window/session-id/manifest/workspace/state,并释放全部借用 slot 的 lock。

步骤:
- [ ] RED:hermetic 测试先挂——(a) 新 flag 全不设 → FLYWHEEL_PROJECTS 与现 builder 输出**字节一致**(固定输入 jq diff 空)+ 生成的 canonical config **byte-identical** + teardown 行为逐字;(b) `--extra-lead 3:Ops-Test --lead-label Product-Test` → leads[] 恰 2 项、字段逐一断言;(c) 非法 slotId / slot 缺字段 / 非法 grace 值 → fail-fast;(d) **第二 slot 已被占(lock 存在)→ 零副作用退出**(主 slot lock 也回滚);(e) 启动中途失败 → 已建资源完整回滚;(f) teardown 后无 extra Lead 残留(supervisor/window/state 探针);(g) `--detection-lead-grace-ms 120000` → YAML 恰多 detection.lead_grace_ms 一键;(h) **borrowed lock 防回收**:模拟 lock age >300s,campaign Bridge PID 存活时第二个 deploy 不能 reclaim
- [ ] GREEN + Commit
- [ ] 第二 Lead 进程启动段(测试断言:生成的启动 env 含正确 token env/AGENT_SOURCE/access/log;真进程留 H4 smoke 验)+ Commit

### Task H2 故障注入器(S1 安全锁)

**Files:**
- Create: `scripts/qa-fly-1189-fault-inject.sh`
- Test: `scripts/__tests__/qa-fly-1189-fault-inject.test.sh`(hermetic:锚定拒绝矩阵用假进程/假路径构造)

子命令:`freeze <execId>` / `thaw <execId>` / `break-worktree <execId>`(mv 到 `${SLOT_DIR}/qa-moved-worktrees/<execId>`——与路径锚同安全根,§A)/ `restore-worktree <execId>` / `recover-from-journal`(driver trap 的恢复入口,幂等)/ `prod-snapshot <label>` / `verify-target <execId>`(只跑锚定+journal 落盘,dry-run)。**注入器不自注册 EXIT trap——生命周期 owner 是 driver(§A trap 合同)。**

- [ ] **实现 gate(Codex R1 #6 前移)**:先做 5 分钟 spike——对一个自 spawn 的沙箱进程真跑 mv-worktree,确认**同 filesystem rename 下目标进程后续命令真产生 ENOENT**(已打开的 cwd fd 不失效,ENOENT 靠后续相对路径/exec 触发;若实测拿不到稳定错误签名,break-worktree 不得用作 §D 的确定机械路,S1/S4 改用「错误签名注入变体」:在 runner worktree 里放一个任务脚本让真 runner 反复执行一条真失败命令——同样是真进程真错误,签名可控)。spike 结论写进 progress.md
- [ ] RED:拒绝矩阵先挂——execId 不在清单 / tmux 锚不匹配 / **pane 进程树零个或多个 claude 后代** / 路径锚命中生产前缀 / **prefix collision(slot-2-evil)** / realpath symlink 逃逸 / **PID start-time 在 check 与 act 之间变化(复用模拟)** / **目标在 check 后退出**,全部 exit 2 且**未执行任何动作**(副作用探针);**restore 方向锁**:source≠journaled quarantine 或 destination≠journaled 原路径 → 拒;**trap 恢复(owner=driver)**:kill 真 driver 进程(此时注入器子进程已退出)→ parent trap 经 recover-from-journal SIGCONT+restore 成功;正常恢复后 EXIT trap 二次运行 = no-op
- [ ] GREEN(锚定+journal+recover-from-journal 实现 = §A 原文)+ Commit
- [ ] prod-snapshot 子命令(file-set + PID 集合,输出 JSON)+ 测试(固定 fixture 目录 diff 语义)+ Commit

### Task H3 场景驱动 + 断言/采证库

**Files:**
- Create: `scripts/qa-fly-1189-nton-driver.sh`(场景编排入口,`--scenario <id>`;`--campaign-root <dir>` 必填)
- Create: `scripts/lib/qa-fly-1189-assert.sh`(断言函数库)
- Test: `scripts/__tests__/qa-fly-1189-assert.test.sh`(hermetic:喂固定 sqlite fixture + 录制的 Discord JSON)

断言函数(全部输出 `PASS|FAIL <id> <详情>` 行 + 证据 JSON **实时落 campaign root**——teardown 会删 SLOT_DIR,Codex R1 #5):
- `assert_episode <execId> <kind> <fingerprint> <status>`:sqlite3 查 detection_escalations,**以完整 (target_key, kind, episode_fingerprint) 为键**(fingerprint 从服务端行读回,不硬编码形态;区分同 target 多 occurrence 用 first_detected_at_ms)。
- `assert_thread_msg <threadId> <pattern> <count>`:GET /channels/<thread>/messages;**证据 = 消息 id + 链接 + 原文 dump + author bot id + parent channel id**。
- `assert_founder_page <threadId>`:GET 读回,断言 mentions[].id == DISCORD_OWNER_USER_ID 且恰 1 条;founder_page_ledger 行存在。
- `assert_lead_event <execId> <eventType> <delivered>`:lead_events 行 + delivered_at。
- `assert_no_cross <issueA> <issueB>`:**显式遍历两边已知 issue thread**(不是只扫 parent channel,Codex R1 #7),断言 A 的 thread 无 B 的 identifier/execId,反向亦然;author bot id 同时核对。
- `assert_prod_taint <campaignId>`:**归因制 E5 闸**。queue/deadletter 等 JSON 文本可 grep;**SQLite 一律 readonly `sqlite3` 查询、连接需能读 WAL**(生产 DB 是 WAL 模式,活跃提交可能只在 -wal frames、二进制页也不保证裸 grep 命中——grep 会假绿,Codex R2 #7):生产 StateStore 至少查 sessions/session_events/lead_events/chat_threads,生产 CommDB 至少查 sessions/messages/questions/declared-state,按 campaign id / test project / 测试 execId / marker 参数化匹配零命中;缺表按已知 schema 跳过,**DB 打不开/查询异常 → E5 fail-closed**。PID/file snapshot diff 作观察证据,churn 需归因说明。

步骤:
- [ ] RED(fixture 驱动断言库先挂,含 no_cross 的 thread 遍历假绿反例)→ GREEN + Commit
- [ ] driver = **primitives + worked scenarios**(每场景:**先注册 EXIT/INT/TERM trap(§A:driver 是恢复 owner,trap 调 recover-from-journal)**→ 注入 → 轮询断言(带超时)→ 采证落 campaign root → 显式复原)+ Commit

> **【职责分层 · Tadashi 2026-07-11 拍(scope decision A,question aa2e0eeb)】driver = primitives,QA session 编排 §D 九场景。**
>
> 明确改写(原措辞「driver 编排 场景=§D 表逐条」= silent descope 风险,故落死):
> - **Implement 阶段的 driver 交付**:hermetic-tested 的 **primitives**(`inject` / `register-target` / `poll_assert` / `recover` + `driver_recover` trap owner)+ **worked scenarios**(`selftest` 证 trap+injector 接线、`s1-detect` 证 inject→poll-episode→assert→recover 一条真臂、`s11-taint` 证 E5 归因闸)+ 断言库(`assert_episode/thread_msg/founder_page/lead_event/no_cross/prod_taint`)。这些全部 hermetic 可测,是 QA 阶段拼装 §D 的**已测工具箱**。
> - **QA 阶段(独立 session,持 Discord/Bridge 权)编排 §D 的 S2-S10 九场景**:S2-S10 本质要**真 Discord fetch 消息 + POST /detection-ack + grace 真计时**,只能对真 Bridge / 真频道 / 真 runner 跑,implement 阶段没有 hermetic 验证面;把这 500 行未测编排塞进安全关键 driver = 更危险。分层理由 = 诚实 + 安全。
> - 🔴 **硬约束(Tadashi ③,不许 silent 省掉)**:**S2-S10 必须在 QA 阶段真的跑**(真 Discord / 真 Bridge、真 N-to-N:多卡死 runner × 多 owner-Lead)。这正是 FLY-1048 关单要的**真 N-to-N 证据**(Tadashi 为此撤回了 1048 merge gate)。toolkit 是手段,**真证据在 QA 那一轮**——不是 toolkit 交了就算完。QA runner 用 driver 的 primitives + 断言库把 §D 逐行编排、跑真机、贴真 Discord 链接。

### Task H4 harness smoke(对 QA 环境自身做 QA;不判 PR-C)

- [ ] 用 **main dist** 部署 slot2 `--extra-lead 3:Ops-Test --lead-label Product-Test --alerts` + TEST_REPLY_BY_ISSUE=1:断言 2 个 Lead 进程活、FLYWHEEL_PROJECTS 落盘 2 leads、launch manifest 完整、两频道各能注入 runner 并各建 [FLY-XX] thread(各自 bot 建)
- [ ] 注入器真机走一遍:freeze→pane 冻结(capture-pane 两次 hash 同)→thaw→恢复;break-worktree→runner 真报 ENOENT(验 H2 spike 结论)→restore;verify-target 对**生产 runner execId** 跑 → 拒绝(dry-run);**kill -INT driver 中途 → trap 恢复生效**
- [ ] teardown(含 extra Lead 清理断言)+ 生产零 taint + Commit(smoke 脚本 `scripts/qa-fly-1189-room-smoke.sh` 随 branch)

### Task H5 沙箱资产 + 运行时 preflight(Codex R1 #8 改造)

- [x] **H5a(已核 2026-07-11,implement)**:两个 dept 沙箱 issue **都已存在、都常开**,无需新建 ——
  - `Product-Test` → **FLY-145**(`[QA-FLY-127 sandbox] S6 retry — Product-Test`,In Progress,label 真挂)
  - `Ops-Test` → **FLY-139**(`[QA-FLY-127 sandbox] Ops-Test label only`,In Progress,label 真挂)
  - 两个 label(`Product-Test` id `b0ed01a3…`、`Ops-Test` id `24cada40…`)都是真 Linear label。slot3 identitySource=ops-lead,故 `--extra-lead 3:Ops-Test` 命中。**labels 必须真挂在 Linear issue 上**——/api/runs/start 不收 caller labels,route 从真 issue 拉 label 做 auto-resolve/scope-check(runs-route.ts:351-418),PreHydrator 带入 session(PreHydrator.ts:31-41);driver **不传伪 labels 参数**。
- [x] **H5b(已记 progress.md)**:源码结论 matchesExecId=true(§0 已定事实,含三处代码锚点),不再作未决探针。
- [x] **H5c 交付(implement)= `scripts/qa-fly-1189-preflight.sh`**(**PR-C-dist 部署 preflight**,QA 阶段 Phase A 开头跑):真 labeled dummy issue 起 runner 后,断言 sessions.issue_labels 含预期 label、owner lead 解析正确、chat_threads 绑定存在、createSessionTargetResolver 前置全成立;任一缺 → **exit 1 + STOP ask Tadashi**(这才是真 blocker)。QA 阶段执行,不在 implement 跑真部署。

## §C 环境规格(QA 阶段部署参数,一处定死)

- **dist**:worktree `origin/flywheel-FLY-1048-pr-c` @ 98c2108c → `pnpm install && pnpm -r build` → 从该 checkout 跑 test-deploy(hybrid swap 机制)。
- **slot**:slot 2 为 Bridge host(port 19872);`--extra-lead 3:Ops-Test --lead-label Product-Test --alerts`;TEST_REPLY_BY_ISSUE=1 + TEST_API_TOKEN 预置;BRIDGE_DEPT_SCOPE_REJECT 保持默认 ON(*-Test label 真走 dept 路由——E4 的路由前提,不关闸)。
- **flag(deploy 前导出,env-at-fork 惯例)**:5 bool 全开 FLYWHEEL_DETECTION_GAP_SCAN=1 FLYWHEEL_PANE_MULTIFRAME=1 FLYWHEEL_STUCK_ERRORSIG=1 FLYWHEEL_WATCHDOG_JUDGE=1 FLYWHEEL_DETECTION_ESCALATION=1;**验证靠 launch manifest + bridge.log cadence/feature 锚点交叉核,不用 ps eww**。
- **计时(Phase A 主矩阵)**:FLYWHEEL_GAP_SCAN_EVERY_N_TICKS=5;FLYWHEEL_GAP_ASK_UNANSWERED_MS=60000;FLYWHEEL_GAP_UNCONSUMED_MS=60000;FLYWHEEL_FRAME_INTERVAL_MS=30000;FLYWHEEL_FRAME_CAPTURES_PER_TICK=4;FLYWHEEL_DETECTION_LEAD_GRACE_MS=180000;FLYWHEEL_CLEARING_TTL_MS=120000;reconcile 默认(20 tick≈60s)。
- **founder**:DISCORD_OWNER_USER_ID=真值(从 ~/.flywheel/.env 读,显式注入 test Bridge env)。
- **证据**:campaign root = `/tmp/qa-fly-1189-campaign-<id>/phase-*/`(SLOT_DIR 之外,teardown 不touch);每场景完成即写。

## §D QA 阶段执行矩阵(独立 QA session 照跑;全绿才 PASS)

> 🔴 **S2-S10 必须真的跑(Tadashi 2026-07-11 硬约束③)**:本矩阵**不是可选、不是 toolkit 交了就算完**。QA 阶段 runner 用 H3 driver 的 primitives(`register-target`→`inject`→`poll_assert`→`recover`)+ 断言库,把下面每一行**对真 Bridge / 真频道 / 真 runner 编排跑一遍**,产出**真 N-to-N 证据**(多卡死 runner × 多 owner-Lead)。这正是 FLY-1048 关单要的东西——Tadashi 为此撤回了 1048 的 merge gate,证据只在这一轮出。**跳过任一行 = 没证据 = 不 PASS。**
>
> 每场景证据三件套:**真 Discord 消息链接(旁存 API GET 原文 dump——thread 归档后链接可能失效,dump 是耐久证据)** + slot DB 行 dump + bridge.log 锚点。**任一 FAIL → 停矩阵、出 Round-N FAIL 报告、kickback**(修复方 = PR-C 实现者,新 head 重跑受影响场景;dist 级改动全重跑)。

**Campaign 分 4 个部署 phase(Codex R1 #5:teardown 清 SLOT_DIR + per-project grace 在 boot 读一次,不能一锅跑)**:

### Phase A(主矩阵,§C 计时;S9 必须在本 phase teardown 前)

> **本 phase 部署命令(implement 已交付 seam)**:
> `TEST_REPLY_BY_ISSUE=1 <5 flag> bash scripts/test-deploy.sh 2 --extra-lead 3:Ops-Test --lead-label Product-Test --alerts`
> Product-Test 注入 issue = FLY-145(slot2/bot2/频道2),Ops-Test 注入 issue = FLY-139(slot3/bot3/频道3)。
> Phase A 开头先跑 `scripts/qa-fly-1189-preflight.sh`(H5c);跑通再注故障。

| ID | 场景 | 注入 | 断言(核心) | 判据 |
|---|---|---|---|---|
| S0 | 房态+基线+preflight | — | lsof 19871-19874 空 + tmux 无他人 slot 会话;prod-snapshot before(`qa-fly-1189-fault-inject.sh prod-snapshot`);launch manifest 5 flag+knob+SHA 齐;**H5c `qa-fly-1189-preflight.sh` 全过** | 前提 |
| S1 | 检测真触发 | runner A1(Product-Test)break-worktree → 真 ENOENT 循环(或 H2 spike 定的错误签名变体) | detection_stuck_confirmed episode 出现(NEW→LEAD_NOTIFIED,fingerprint 从行读回);A1 的 [FLY-XX] thread 安静帖(无 mention)恰 1 条;lead_events 行 delivered;Lead-P pane 渲染出事件 | E1/E2 前半 |
| S1b | 冻结形态(观察+兜底断言) | runner A2 freeze(SIGSTOP) | 判定路径三分支:(i) 判 c_stuck → 统一流(同 S1 断言);(ii) fail-suspicious → **断言** lead_events 出现 detection_suspicious + Lead pane 渲染(A5「绝不静默」契约);(iii) 超两个 frame 周期无任何事件 → **FAIL(E1 漏检)**。走了哪条记录进报告 | E1(C 不漏:兜底可证) |
| S2 | 升级流走完(3min grace) | S1 的 A1 无人 ACK | 超 grace 后 founder page:thread 里真 @(mentions[].id==owner)恰 1 条;行 ESCALATED;founder_page_ledger 有行 | E2 |
| S3 | BI-4 同 episode 不刷屏 | A1 保持坏 ≥5 个 reconcile tick + ≥3 轮 gap scan | thread 帖计数仍 = 1(Lead 腿)+ 1(founder page);该 episode lead_events 仍 1 条;**ESCALATED 后继续坏 10+ tick 零新增** | E3 |
| S4a | ★N-to-N 路由(双页) | A1(Product-Test,case-c)+ B1(Ops-Test,漏①真 park 不上报)同时活跃,**都不 ACK**(kind 组合显式:一 case-c 一 gap,两条入流路都被覆盖) | A1 事件只在 slot2 频道该 issue thread(slot2 bot 发);B1 只在 slot3 频道(slot3 bot);assert_no_cross 双向(遍历两 thread);**两 episode 独立计时、各页 founder 恰 1 次**;对照 C1(真干活)+ D1(park 且真上报)全程零 episode 零消息(R1 静默) | E4 |
| S4b | ★跨 target 抑制隔离(ACK 分叉) | **fresh** A2'(Product-Test)+ B2'(Ops-Test)两个新 episode;A2' 在 grace 前被 Lead ACK,B2' 不 ACK | A2' ACKED、**自 lead_ack_at_ms 起 ≥2×grace 窗口内零 founder page 零新帖**;B2' 照页恰 1 次(A 的抑制不吞 B);ACK 用真实枚举(见 S6) | E4/E3 |
| S6 | Lead ACK 双腿 + auth | 对 A2':POST /api/sessions/<execId>/detection-ack body {leadId, kind, episode_fingerprint(服务端读回值), **disposition:"ack"**};resolve 腿用**命名 episode C2'**——Product-Test 新 runner、kind=detection_stuck_confirmed(同 S1 注入式)、owner=Lead-P,fingerprint 读回后**在 grace 前** POST **disposition:"resolve"**(枚举实为 ack/resolve/dismiss,400 其余——Codex R1 #2 纠正);C2' 纳入 founder-page 总量与 no-cross 断言 | ack→200+行 ACKED;resolve→200+行 RESOLVED(C2' 零 page 零新帖);**auth 三重实测:无 Bearer→401 / 错 owner leadId→403 / 正确→200** | E2/E3 |
| S7 | CLEARING 真实语义(改造,Codex R1 #4 + R2 #2) | **专用 target T7**(Product-Test 新 runner):触发 episode → grace 前 disposition:"ack"(ACKED——CLEARING 只吃 NEW/LEAD_NOTIFIED/ACKED,**刻意排除 ESCALATED**,StateStore:6485-6507,所以不能用 S4a 已 page 的 B1);对仍 running/awaiting 的 T7 调真实 /close-runner(body 带 done:true + 正确 owner leadId:同一 HTTP 调用先转 completed→kill→ACKED 行标 CLEARING) | **branch-aware(两种合法 interleaving 都不是 FAIL——close 的 completed transition 与 markDetectionClearingSafe 之间有多个 await 点,~60s 一次的 reconcile 若落在窗口内会先把 ACKED 行 recovery auto-RESOLVE,之后 CLEARING update 改 0 行、无 log,Codex R3 #1)**:Branch A(CLEARING wins)= close success + bridge.log 的 detection episode(s) marked CLEARING 行 + 随后 DB RESOLVED(recovery)+ 期间零新通知;Branch B(recovery 抢先)= close success、无 CLEARING log,但同一精确 episode 在 close 请求窗口内直接 RESOLVED(recovery)+ 零新通知——记录为 recovery_preempted_clearing,**不判 FAIL**。driver 先锚定一次刚完成的 reconcile 再立即执行 T7(给下个 tick 留满 cadence,偏置 Branch A),但 Branch B 仍保留非假失败兜底;真机硬目标 = close 后可靠收口 + 无重复通知。**TTL 回弹(NEW 复报)降级为单测 spot-check**(PR-C C5 单测,QA 复核存在+绿);「cleanup 已开始但未 terminal」的真机入口缺失作为**可达性发现**写进 qa-report 反馈 PR-C 实现者/Tadashi(不改 DB 冒充 E2E) | E3(诚实范围) |
| S9 | 恢复自动 RESOLVE(**本 phase 内、teardown 前**,branch-aware——Codex R2 #6) | thaw A2 / restore A1 worktree → runner 真恢复 | A1:episode 必须自动 RESOLVED(recovery probe)+ 无新告警。A2 按 S1b 实走分支:走了统一 c 流 → 同 A1 断言;走了 fail-suspicious → **断言进程真恢复 + 原 suspicious 事件不重发 + 不存在待 RESOLVE 的 detection 行**(suspicious 只写 session_events/lead_events,本就无 detection_escalations 行) | E1(a 态收口) |

### Phase B(fresh 部署:FLYWHEEL_DETECTION_FLEET_THRESHOLD=2,其余同 §C)

| S8 | fleet guard | fresh 起 2 只新 runner 造 2 个同 kind 新 episode(不复用任何旧 target——CLEARING/RESOLVED 残留会吞新 episode) | 单条 detection_fleet_aggregate 落 #test-flywheel-alerts;founder page 零条;两行 ESCALATED(fleet) | E4(不轰炸) |

### Phase C(fresh 部署:`env -u FLYWHEEL_DETECTION_LEAD_GRACE_MS`,**且沙箱 canonical config 无 detection override**——per-project grace 在 Bridge boot 读一次,不能与 S10 同部署)

| S-30 | 默认 grace 真等(D3 必留) | 起一只新 stuck runner,让它煮;期间整理 Phase A/B 证据 | +30min(±1 reconcile 周期)founder page 到达,时间戳差进报告 | E2(真 30min) |

### Phase D(fresh 部署:经 H1 的 `--detection-lead-grace-ms 120000` seam——deploy 自己重 clone 沙箱 + 无条件重写 config + 同一调用里起 Bridge,「手写 repo 文件」没有执行窗口,Codex R2 #1)

| S10 | per-project grace override | 新 stuck runner | ~2min 升级(全局默认 30min 被 override);launch manifest 记录 effective override;证明值从 canonical root 读(runner 不能自调) | E2(配置面) |

### 收口(跨 phase)

| S11 | 零生产影响 | campaign 全程后 | **归因制闸(硬判据,两条)**:① taint 扫描——queue/deadletter JSON 文本扫;**生产 SQLite(StateStore:sessions/session_events/lead_events/chat_threads;CommDB:sessions/messages/questions/declared-state)用 readonly sqlite3 查询、连接读 WAL、按 campaign id/test project/测试 execId/marker 参数化匹配零命中**(WAL 下裸 grep 会假绿);DB 打不开/查询异常 → **fail-closed**;② **action journal 全量 invariant**——每个被动过手的 PID canonical cwd 都在 slot/quarantine 安全根、零生产 PID(§A)。**观察证据**:prod-snapshot 前后 diff,自然 churn 附归因(19 runner 活跃机上不承诺集合绝对相等——那会假失败);生产 runner PID 集合对账(消失的 PID 归因到其正常生命周期,不许无解释) | E5 |

**执行顺序**:Phase A(S0→S1/S1b→S2→S3→S4a→S4b/S6→S7→S9)→ teardown → Phase B(S8)→ teardown → Phase C(S-30,煮着写报告)→ teardown → Phase D(S10)→ teardown → S11 收口。预算 ≈ 3.5h 墙钟(30min 煮在 Phase C 与报告并行)。

**judge 额度注意**:S1b 可能真调 codex(codex-with-fallback 轮转);判定观察记录进报告,不作为 PASS 前提(C-不漏由 S1 机械路保证)。

## §E 证据与报告契约

- 证据实时落 campaign root `/tmp/qa-fly-1189-campaign-<id>/phase-*/`(SLOT_DIR 之外);campaign 结束筛关键件拷进 branch `engineering/doc/FLY-1189-qa-prc-nton-e2e/qa-evidence/`;**每条 Discord 链接与 API GET 原文 dump 一一配对**。
- `qa-report.md`(同文件夹):E1-E5 判定表逐条贴证据 + 场景明细 + judge 观察记 + S1 安全对账(action journal + prod 归因)+ 房态记录 + **S7 可达性发现专节**;PASS 才 emit qa-result pass 并报 Tadashi 亲核。
- **红线重申**:绝不自 merge / 自 :cool:;不碰生产;FAIL 不代修;不改 DB 冒充真机行为。

### §E.1 显式未证明项 · 必须原样上报 founder(Tadashi 指令 2026-07-11,不许埋进附录)

**BI-4 的 CLEARING TTL 回弹,经真实入口(close-runner)不可达 → 本次真机 QA【未能证明】此项。**

- **原因**:close-runner 只对 terminal 状态生效;而 reconcile 的 recovery auto-RESOLVE **永远先于 TTL** 把该行收口,TTL 回弹在生产路径上走不到。
- **处理**:降级为单测 spot-check(复核 PR-C 已有的 C5 单测存在且绿)。**绝不通过改 DB 伪造真机 E2E。**
- **反馈实现者**:「cleanup 已开始但尚未 terminal」的真机入口**缺失**——这是 PR-C 的一条**可达性发现**,写进 qa-report 交回实现者。

**规矩**:qa-report.md 的 E1-E5 判定表必须把本节**原文引用**在 E3 判定旁边——founder 有权知道哪些证了、哪些没证、为什么没证。「测不到」可以,「测不到但看着像测到了」不行。QA 阶段 runner 不得省略、不得软化本节措辞。

## §F Out of scope

Lead 侧 pane_error_stalled 全面验收(PR-A qa-report §7 已有真机证据,本单只顺带观察 Lead pane 健康);FN4 draft-intent(显式 follow-up);CLEARING TTL 回弹的真机 E2E(可达性缺口,见 S7——单测 spot-check + 反馈实现者);PR-C 单测/CI 复跑(Codex code review 已过,QA 只 spot-check CI 绿);修被测代码。

## §G 风险与缓解

| 风险 | 缓解 |
|---|---|
| 误伤生产 runner(同机 19 只) | §A 三锚+TOCTOU journal+trap 恢复+fail-loud;verify-target dry-run 先行;前后 PID 归因对账 |
| 房被抢/并发 QA | D8 自核 + **全部借用 slot 原子 claim**(H1)+ Tadashi 调度 |
| break-worktree 的 ENOENT 签名不稳定 | H2 spike 前置定论;不稳则换错误签名注入变体(同为真进程真错误) |
| judge codex 限流/慢 | 主断言走机械路;codex-with-fallback;judge 结果只观察 |
| 真 @ 打扰 Annie | D7 已拍(Tadashi 知会);page 总量 ≈ 5-6 条(S2/S4a×2/S4b/S-30/S10) |
| PR-C head 漂移 | 每 phase 部署前 rev-parse 核 98c2108c;漂移 → 记录 + 新 head 全重跑 |
| load(test Bridge+2 Lead+~6 runner 增量) | 每 phase 部署前查 uptime load;>核数×1.5 → 报 Tadashi 缓行 |
| chat thread 未建导致 founder page 空转 | H5c preflight + 注故障前断言 chat_threads 行存在 |
| teardown 吃证据 | 证据实时落 campaign root(SLOT_DIR 外);断言库强制 --campaign-root |
