# FLY-2456 host drill — Lead deviations from host-runbook.md (head f51aa8710)

1. §01 line 38 (setup-01): runbook asserts `.owner.kind=="runner"`; Bridge `resolveActiveSnapshotOwner`
   (packages/teamlead/src/bridge/snapshot-closeout.ts) only ever returns kind ∈ {workflow, session, operator};
   every DAG-enrolled execution reports `workflow`. Driver predicate changed to `.owner.kind=="workflow"` —
   same intent (OWNER_EXEC is the current snapshot owner, executionId must match). Runbook must be corrected
   in the PR together with the drill reports. Discovered 2026-09-10T11:5xZ before R1.
2. Pre-R1 host hygiene (Linear「真机前置」): 78 stale `runner-fly1674-*` tmux sessions (0 child processes)
   killed 11:55:43–46Z; inventory + cleanup logs under host-precheck/.

3. R1 attempt 3 (2026-09-10T14:35Z, tool head 7b20ab216): production capture pre-before advanced past the
   database derivations on the real host — state.evidence.json 245668155 bytes (WAL fix live), comm.evidence.json
   1012034 bytes status=pass (bounded projection live, comm.db copy 1002496000 bytes), identity-result.json
   status=pass entries=3252, health/launch-commits captured. Stopped at the runbook's inline python
   `assert p.is_file() and not p.is_symlink(), 'invalid alert entry'` over ~/.flywheel/meta-alert /
   alert-deadletter: production alert dirs contain non-regular entries (see host-precheck/alert-dirs-*.txt).
   Evidence kept under r1-aborted-20260910T1435Z/ for QA cross-read.

4. Runbook inline python (production_capture, host-runbook.md:408) asserts every entry of ~/.flywheel/meta-alert
   and alert-deadletter is a regular non-symlink file; production alert-deadletter contains the subdirectory
   `_test-slot-quarantine/` (529 slot quarantine). Driver patched: non-regular entries are skipped and recorded
   in `<phase>/alerts-skipped.txt` (alerts.json rows keep the content+sha256 shape alerts.mjs read() requires).
   Verified 14:4xZ: 1 non-regular entry (that directory), 0 non-UTF8 files, 22 non-JSON files all under
   meta-alert (.txt / .txt.tmp.* — classified by alerts.mjs, not an error). Runbook fix to land in the final
   reports-into-PR rework; QA verifies then.

5. R1 attempt 4 (14:37Z) reached execute-08 (terminate the PRE precondition body): the runbook terminates 1s after
   start_body; the slot Bridge had not yet bound the session's tmux window (`:pending`), so /api/actions/terminate
   returned 400 (`[terminate] cleanup failed ... tmux window identity is still pending`) although the FSM was already
   terminated; the slot later restored the TUI window → half-dead PRE body. Driver patched: poll
   GET /api/sessions/<exec> until tmux_session is bound (≤120s) before terminating; wait result logged to
   terminate-wait.log. Slot 4 torn down with test-teardown.sh (log under host-precheck/). Production runner
   windows/sessions verified unchanged. Runbook fix (§ precondition terminate) to land in the final rework.
   Separately: the drill tmux session `fly2456-drill-r1` vanished at ~14:38:39Z without the launcher writing its
   exit line — cause unknown; launcher now logs EXIT/TERM with rc for the next attempt.
   5b. Attempt 5 (14:48Z) confirmed the wait predicate must read the slot CommDB `sessions.tmux_window`
   (StateStore `tmux_session` stays null for codex-tmux bodies; observed running body 1f54dedb with
   tmux_session=null but CommDB tmux_window=runner-test-slot-4:@2). Predicate switched to the CommDB column,
   bound = non-empty and not ending in `:pending`.

## #6 archive_ledger: reaper 空转拒绝行(targetKind=none)被路书断言拒收 (attempt 6, 15:05:30Z)
- 事实: slot-4 kill-ledger 含 2 行 `source=mcp_descendant_reaper signal=none targetKind=none target=null reason=periodic_orphan_pass refusal=isolation_boundary refusalReason=no_evidence`(14:59:10Z, 15:04:10Z,每 5 分钟一行)。路书 `archive_ledger` 断言 targetKind∈{pid,pgid,tmux-window} → AssertionError;且 `'isolation_boundary' in json.dumps(r)` 判 fail。
- 出处(main 源码): `packages/teamlead/src/bridge/mcp-descendant-reaper.ts` `reapMcpOrphans`:`resolveIsolationRoot(env)!==null` 时**不扫描**,直接 `recordBoundaryRefusal({source:'mcp_descendant_reaper',reason:'periodic_orphan_pass'})` 并 audit `isolation_boundary_refused{targetKind:'none',target:null,evidence:{},reason:'no_evidence'}`。这是 slot 内 reaper 的设计内 no-op,不是越界杀尝试。
- 后果: 路书判据对任何跑满一个 reaper 周期(5 分钟)的 slot 都不可满足。
- 驱动补丁: 接受 `targetKind=none` 行(须 refusal=isolation_boundary, target=null, signal=none);refusals 分两类:`noopRefusals`(none/null/periodic_orphan_pass,只计数)与带目标的真拒绝(仍判 fail)。summary 多出 noopRefusals/noopRefusalCount/deviation 字段。
- 路书修正(进最终 rework): §finalize/archive_ledger 同上分类;文字说明 no-op 拒绝行是 slot 隔离生效的正向证据。
- 同窗口另一事实(非路书缺陷): 生产窗口 @4275(FLY-2456 implement 体 370c90bf)在 14:56:32–46Z 被生产引擎 resident grace 到期回收(FLY-2474 形状,14:23 complete + 30min),生产 kill-ledger 有 codex_daemon_runtime/codex_runner_tui 行,slot 账本无涉。attempt 6 的 pre-before/pre-after 舰队差分因此 9→8,与 drill 无因果。

## #7 finalize_precondition: proc-attribution `needs-attribution` 无归因入口,对跑真 Codex 体的 slot 不可满足 (attempt 7, 15:26:38Z)
- 事实: proc-full/proc-teardown 均 `needs-attribution`(unexplained 14/28 行,全 NONSLOT)。工具 `scripts/lib/qa-fly-2456-proc.mjs classify()` 只认「可执行文件或紧随其后的解释器脚本路径在 slotDir/checkout 下」为 SLOT,argv 明确不算(ps 不保留引号)。因此 slot 的 tmux server(`tmux -S /private/tmp/flywheel-test-slot-4/...`)、npx 起的 node daemon、`codex app-server --listen unix:///tmp/flywheel-test-slot-4/...`(pid 64375)及其 MCP 子进程、`claude -p` reviewer、`-zsh` 都是 NONSLOT;加上宿主瞬态(sleep 轮询/Chrome renderer/gh api/mdworker/contactsd)。路书 §1154「proc 没有自动终态归因接口,任何 needs-attribution 保留并阻止通过」= 不可满足判据。
- 驱动补丁: `lead-proc-attribution.py` 在两份 proc json 上做 Lead 机械归因,逐行留 rule+evidence:A argv 含 slot/checkout 根路径;B 同快照祖先链到 tool-SLOT/A;C 宿主瞬态白名单(sleep/caffeinate/gh/cmux list-pane-surfaces/cmux-sync watch/Chrome Helper/Metadata/mdworker/ps//System/Library//usr/libexec//usr/sbin);D removed 行带生产 flywheel 签名(runner-flywheel、~/Dev/flywheel/、claude --agent、claude-lead、com.flywheel.、~/.flywheel/comm/flywheel/、unix:///Users/.../.flywheel/)且非 A/B = production_casualty → fail;其余 unattributed → fail。finalize 对 proc 的通过条件改为「工具 pass,或 needs-attribution 且 Lead 层 pass」,precondition.json 增 leadAttribution/deviations。
- attempt 7 数据干测: proc-full pass(瞬态 25);proc-teardown pass(slot 19,瞬态 16,伤亡 0)。
- 路书修正(进最终 rework): 把该归因层写成路书正式一步(或工具加 `--lead-attribution` 输入),并删掉 §1154 的「阻止通过」措辞;与 fleet 已有的 needs-attribution 例外思路一致。
- #7 补记 (attempt 8/9): 追加瞬态规则——僵尸占位 `(name)` / `<defunct>`、Claude Code 工具壳 `~/.claude/shell-snapshots/` 及其祖先链子进程(tail/ugrep 等)、`/Applications/*.app/`(含空格路径);并对齐工具语义:post-teardown 模式下 proc.mjs:82 只把 removed 的 NONSLOT 当 unexplained,Lead 层对 added 的 unattributed 行只计数(`added_unattributed`)不判 fail,removed 行仍严格。

## #8 body_context: Codex 体在 main 上从不写 sessions.branch,路书断言 TypeError (attempt 11, 16:26:36Z, execute-16 park_marker B3)
- 事实: B3(5ce7afe7,slot-4 FLY-146 Codex 体)起体 6s/70s/110s 后 StateStore `sessions.branch` 均 NULL(`tmux_session` 也 NULL,worktree_path 已设);生产三具 Codex 体 914a44d6/fee1e17d/370c90bf 的 `branch` 同样 NULL,`worktree_binding_branch` 有值(flywheel-FLY-2484 / flywheel-FLY-2456)。B3 的 `worktree_binding_branch=project-slot-4-FLY-146` = `git -C <worktree> branch --show-current`。路书 `body_context` 的 `!/^[-\w/]+$/.test(s.branch)||s.branch.includes('..')` 对 null 先 regex.test('null') 通过再 `.includes` 抛 TypeError → 对任何 Codex 体不可满足。
- 驱动补丁: 查询改 `COALESCE(branch, worktree_binding_branch) AS branch`(保留 branch_raw/worktree_binding_branch 留证),加 `typeof s.branch!=='string'` 显式判空;其余校验(正则、`..`、worktree 前缀、`git branch --show-current` 对照、origin 对照)原样。
- 路书修正(进最终 rework): 同上;文字说明 Codex 体 branch 真相在 worktree_binding_branch。
- 重入不可行: setup-07 `test ! -e /tmp/flywheel-test-slot-4` 等 no-clobber 断言要求干净宿主,只能拆房从头跑(attempt 12)。

## #9 execute-13 deploy_room: 拆房后 9 秒 slot 目录被外部重建,room_capture 探死端口 curl exit 7 (attempt 12, 16:42:46Z)
- 事实: execute-10 拆房 16:42:20Z 完成(日志 Slot 4 released/teardown complete);16:42:29.039Z `/tmp/flywheel-test-slot-4/state/comm/test-slot-4/comm.db` 被重建(389KB,25 张表,`mailbox_migration_meta` 记 mailbox_v1 迁移完成于该时刻,sessions/mailbox 等全 0 行);无 lock、端口 19874 无监听、argv/env 均无进程引用 slot;驱动此刻在 `production_capture pre-after`(工具全部 readonly+fileMustExist,不是驱动建的)。`room_capture deploy` 见目录存在就 curl health → 拒连 → exit 7。attempt 11 同段(拆房到 deploy 间隔 30s)未复现。
- 写者: 未定位(生产 Bridge 日志、runner-stop-notify 日志、停体账本、projects.json、strength-two 路由均排除);记入 FINDINGS F2。
- 驱动补丁: `late-residue-guard.sh` 在 deploy_room main 前运行——目录存在时,仅当 无 lock ∧ 端口无监听 ∧ 无进程引用(argv+env) ∧ 内容仅 state/comm/test-slot-N/comm.db(-wal/-shm) ∧ 所有表 0 行 才归档(listing/sha256/stat/tables/rowcounts/comm.db 副本 → `late-residue-<ts>/`)并清除;否则 exit 70 停手。
- 路书修正(进最终 rework): teardown 后加同样的迟到残留检查;并把写者查清后修其路径解析。

## #10 park_marker: 新起体的分支只在本地,路书在基线捕获时假设远端已有该分支 (attempt 13, 17:02:31Z, execute-16)
- 事实: B3(0c1c8174)起体 6s 后 worktree 分支 `project-slot-4-FLY-146` 在 sandbox 远端不存在(`git ls-remote` 空),`capture_marker` 的 commit/tree/blob 全 null → `jq -er '.blob.sha|select(test(...))'` 报 null cannot be matched。worktree HEAD=sandbox main 1855f7a1a、树干净、marker 文件本地存在(6628B,与 main blob 870a45fc 同)。
- 驱动补丁: 基线捕获前先 `git ls-remote --heads origin refs/heads/$BODY_BRANCH`,为空且树干净时 `git push origin HEAD:refs/heads/$BODY_BRANCH`(体开 PR 前本来也要先推),留 `*-marker-remote-before.txt` / `*-marker-publish.txt`。
- 路书修正(进最终 rework): 同上。

## #11 驱动重入 START_FROM (attempt 14)
- 动机: 每次从头重跑前置段 ~33 分钟;17–39 步还可能再撞路书缺陷。
- 实现: `START_FROM=execute-NN` 时,execute-01..15 的块包在 `if ! skip_step <id>` 里(字符串序比较);setup-07 的「slot 目录/lock 必须不存在」断言只在非重入模式检查;`manifest init` 在副本上验证过幂等(rc 0,manifest 字节不变)。其余 setup 块只定义函数/覆盖写文件。前提: slot 仍在、evidence 目录仍在、被跳步骤的 manifest receipt 已存在。
- 路书修正(进最终 rework): 把重入能力写成路书正式 knob。

## #12 park_complete adopt: main 上体入场即有 cleared 的 park 投影,路书 park-adopt 假设 complete 前无行 (attempt 14, 17:05:03Z, execute-18)
- 事实: B3(0c1c8174)session=running、node=running,但 `workflow_engine_park` 已有 1 行(state=cleared, reason=activation_spawn_admitted, 17:02:26Z 入场即写)+ `workflow_engine_park_outbox` 1 行 `park_cleared`;生产 370c90bf 同形(14:17:24 park_cleared → 14:22:51 park_opened)。`scripts/lib/qa-fly-2456-park-adopt.mjs` 的 execute 分支要求 `!projection && !events.length` → 落到 `park_partial_or_not_open` conflict → adopt_db 返回 1。
- 处置: 工具改动不能落在 PR 的 worktree(替身要接手、树须干净),另建 Lead 自有 detached worktree `~/Dev/flywheel-FLY-2456-tools`(@7b20ab216,pnpm install 完成),在那里改 park-adopt:`notYetParked = (!projection || projection.state==='cleared') && events.every(e=>e.event==='park_cleared')`;驱动 `TOOL_REPO` 指向该 worktree。PR worktree 保持干净(porcelain 0)。
- 路书/工具修正(进最终 rework): 同上补丁进 PR。

## #13 park_complete after-adopt 竞态: complete 返回后引擎异步写 park_opened,after 快照拍早了 (attempt 15, 17:09:02Z, execute-18)
- 事实: `complete --route needs_review --pr 193` 返回 `session_completed delivered (attempt 1/4)`;紧接的 adopt_db after 快照里投影仍非 open → `park_partial_or_not_open`;数秒后实况:sessions=ship_parked、implement node=done、qa node=admitted(17:09:02Z 已派)、`workflow_engine_park` state=open reason=rework_reachable_wait gen 2、outbox park_opened gen 2。
- 驱动补丁: complete 后每 2s 轮询 slot StateStore/CommDB,直到 sessions.status=ship_parked ∧ park.state=open(≤120s),记 `park-wait.log`,再拍 after 快照;超时即 fail。
- 路书修正(进最终 rework): 同上(与 #5 terminate 等窗口绑定同一类:效果步之后要等引擎异步落账)。

## #14 qa_fail_b1 after-adopt 竞态: 返工 wake 异步送达,after 快照拍在 awaiting_receipt (attempt 15, 17:11:30Z, execute-25)
- 事实: qa-result fail 17:11:27Z 落地(claimId=1);引擎 17:11:29–30Z 走 edge_traversed → rework_target_reserved → rework_delivery_claimed → 铸 implement attempt 2(execution_admitted)→ rework_delivery_awaiting_receipt;wake binding attempt=2 mode=wake 17:11:30Z;after 快照此刻拍到 delivery=awaiting_receipt → rework-adopt `delivery_incomplete`(判据要求 state=wake_delivered)。B1 的 Codex agent 当时仍在自己的 onboarding turn 里(Pursuing goal),turn 结束进 hold 后 daemon 消费 wake:17:12:25Z `rework_delivery_wake_delivered`(qa-result 后 58 秒)。
- 驱动补丁: qa-result 后每 2s 轮询 `workflow_rework_delivery.state` 直到 wake_delivered(≤600s),记 `rework-wait.log`,再拍 after 快照。
- 路书修正(进最终 rework): 同上。
- 观察(报告素材,非缺陷): 驱动代体 `complete` 后,B3 的 Codex agent 并未停下,pane 显示「continuing the wait loop without terminalizing the goal or treating the parked phase state as a blocker · 1 background terminal running · Pursuing goal (10m)」= 生产见过的「goal 自续被动等 phase-wake」形态,在 slot 里稳定复现。

## #15 compare_round 分类器: 三具体全判 other (R1 verdict, 17:31:40Z)
- 事实: final-observe.json 里 B1/B2 sessions.status=failed,last_error=`Codex recovery exhausted after 2 attempts`(无 successor);B3 有 `reown_skipped_not_turn_holder` session event。分类器仍把 B3 判 other(应为 skipped_not_holder),B1 预期 replaced(main 上根本不换体,失败即停),B2 预期 succeeded。事实读数不受影响(0/2),但分类器要按 main 的真实终态补 `failed_exhausted_no_replacement` 一类,并修 B3 的事件匹配。
- 处置: 不改 verdict;R1 附录 FINDINGS F4 记事实;最终 rework 修分类器。

## #16 launch-delta QA identity: `name()` 正则不认 activationId 的冒号 (R1 verdict launchCommits 「QA identity invalid」)
- 事实: `scripts/lib/qa-fly-2456-launch-delta.mjs` `name = /^[a-zA-Z0-9_-]+$/`,而 activationId 形如 `activation:<exec>:<run>:qa:1` → 永远 invalid → launchCommits/liveAfter、/postTeardown 两项必 fail(unbounded delta 也随之)。
- 工具补丁(tools worktree): 新增 `activationName` 允许 `:` `.`,仅用于 activationId;R2 在 compare_round 时已用补丁版。R1 附录用同一工具对原输入补跑一次。

## #17 拆房归档不含 slot Bridge 日志,reown 失败原话随拆房丢失 (R2, 17:55:37Z)
- 事实: `test-teardown.sh` 只归档 boundary-events.json / launch-manifest.json / kill-ledger;slot `bridge.log`(含 `[codex-session-reown] ... recovery owner failed before commit` 前一行的真实原因,如 R1 的 `immutable launch snapshot does not match rehydrated context`)与 `report-host.log` 随目录删除。R1 的原话是我在拆房前手工读到的;R2 没有。
- 驱动补丁: 新增 `archive_slot_logs`,在 teardown_room 前把两份日志复制到 `$EVIDENCE/slot-pre-teardown-<phase>-*.log`。
- 路书修正(进最终 rework): teardown 归档加入两份日志(或 test-teardown.sh 本身归档)。
