# FLY-1257 Codex 常驻运行时 + retry 路径四缺陷 — 调研

Issue: FLY-1257 (https://linear.app/geoforge3d/issue/FLY-1257/fix-codex-常驻运行时-retry-路径四缺陷打磨等门自杀-retry-不发带-takeover-缺-startpoint)
日期: 2026-07-14
基于: exploration.md

## R1. Codex 原生等待原语(Annie 点名的 design 第一步)

### R1.1 协议面验证(本机实测,codex-cli 0.144.4)

`codex app-server generate-json-schema --out <dir>` 生成的 v2 协议 schema 实测:

- **`thread/goal/set`**(`v2/ThreadGoalSetParams.json`):参数
  `{threadId(必填), objective?, status?, tokenBudget?}`,三个可选字段全部
  nullable/可省略;schema 只证明 RPC 接受部分形状,**不证明省略字段会保留旧值**,
  所以主修重激活显式重发 runtime 缓存的 `objective + tokenBudget`,M-opt probe
  另验服务器的保留语义。
  `status` 枚举 `active|paused|blocked|usageLimited|budgetLimited|complete`
  —— **`paused` 可由客户端直接设置**。
- **`ThreadGoalUpdatedNotification`**:回传完整 `ThreadGoal`
  (`status/objective/createdAt/updatedAt/timeUsedSeconds/tokensUsed`),
  状态流转对客户端全程可观察。
- `thread/goal/get` / `thread/goal/clear` 同在(FLY-1188 已用)。

### R1.2 行为面证据(FLY-1188 research 已实测 + 待 probe 项)

已实测(FLY-1188 research.md,2026-07-11,codex 0.144.1 真 TUI):

- `/goal pause` **真停**(20s 观察零新动作,状态栏 Goal paused);
- `/goal resume` **真续**(dispatcher 恢复跨轮自动续跑);
- `/goal` 是协议面机制非 TUI 解析 —— TUI 的 pause/resume 底层就是这套 goal 状态。

2026-07-14 拉取的 OpenAI Codex Manual 也公开列出 `/goal pause`、`/goal resume`
作为 CLI/App/IDE Goal mode 的正式控制面;本机 0.144.4 schema 则补足 app-server
RPC 形状。公开手册不承诺 daemon 重启/字段保留细节,因此下列 probe 仍必须做。

待 probe(实施第一步 M0,协议面 RPC 直调,风格照抄 FLY-1188 的
`v1-goal-probe.mjs`):

1. RPC `thread/goal/set {status:"paused"}` 在 goal 活跃中途下发,是否停住
   auto-continue dispatcher(TUI 已证同引擎;RPC 路径确认)。
2. `{status:"active"}` 是否自动恢复续跑,还是需要补一个 `turn/start` kick
   (我们的设计无论如何都会 kick 一轮「gate 已答」,所以两种结果都可接受,
   只影响是否能省掉 kick)。
3. 只发 `{threadId, status}` 是否保留原 objective(schema nullable 语义确认;
   兜底方案:重发原 objective,runtime 手里有)。
4. paused 期间 daemon 重启 + `resumeThread` 后 goal 状态是否随 thread 持久化
   (FLY-1188 V2 已证 goal 状态随 thread 持久化,此处只需确认 paused 也一样)。

### R1.3 其他原生原语的排除结论

- **turn 内阻塞 tool call**(模型直接跑 blocking `gate`,turn 挂在子进程上):
  TUI approval 等待确实是无限阻塞,tool 执行期间也不产 token。但 (a) m4d spec
  已明确「保守选择:不引入未验证的 turn 内 blocking-gate」;(b) codex shell tool
  的 per-call timeout 行为未验证;(c) daemon 死亡/账号轮转会杀掉阻塞子进程,
  恢复后模型不知道 gate 命令死了,恢复语义要整套重设计。**保持排除,只作对照方案。**
- **approvalPolicy elicitation**:语义是命令执行批准,不是 Lead gate;且 runner
  沙箱姿态固定 `approvalPolicy:"never"`(`ensureThread`,
  `codex-daemon-goal-runtime.ts:353-367`),挪用会打开不该开的批准面。**排除。**

### R1.4 「连续 3 回合」的定性(根因更正,Lead Linear comment 2026-07-14)

Flywheel 代码/契约/提示词全文没有这个常量(grep 证实)。FLY-1255 runner 一手
取证给出定性:它是 **Codex 平台对 update_goal(status=blocked) 的准入门槛**——
同一 blocker 持续 ≥3 goal turns 后,平台才*允许*模型标 blocked。**允许≠应该**:
真正停手的是模型误判(把资格当指令),缺陷④(blocked 删门)再放大后果。
FLY-1255 同日反例(持续 poll、不宣 blocked、行为正确)证明这是提示词纪律可约束
的误判,不是平台强制。**因此主修落在提示词/契约 + CLI 硬闸**;runtime 层的
便宜睡眠降级为优化项(省回合,不是止血必需)。

### R1.5 主修落点 + 优化项的拦截点与现有钩子

主修落点(提示词/契约/CLI,详见 plan M1):

- Blueprint codex 等门指引五处 `isCodexRunner` 分支(`Blueprint.ts:1627-1636`
  brainstorm、`1684-1696` review_code、`1715-1716` approve_to_ship、
  `1755-1791` question/generic)——加写
  「资格≠指令 / 持续 poll / 仅真 timeout·error·reject 才 fail-close」;
- `codex-runner-contract.md` 等待章节同款铁律;
- `flywheel-comm complete` 的 route=blocked 硬闸(见 R1.5 末条)。

以下钩子盘点服务于**主修 runtime 持有**及可选的 paused 优化:

- `runGoalToTerminal`(`codex-daemon-client.ts:486` 起):终态经
  notification + `getGoal` poll fallback 两路观察;`blocked` 在
  `TERMINAL_STATUSES`(`:36-41`)→ 循环 RESOLVE。**拦截点 = 终态判定处:
  status==="blocked" 且 caller 提供的「等门中」谓词为真 → 不当终态。**
- `isWaiting()` 已存在(`CodexTmuxAdapter.ts:605-617`,gate marker 未答检测),
  已经作为 MED-7 waiting ceiling 的谓词传进 goal loop —— **同一谓词直接复用**。
- gate-deadline watcher(`CodexTmuxAdapter.ts:860-960`)已周期扫 marker、
  已处理「marker 被答 → 移除」与「超时 → 过期 + gate_timed_out」两个事件。
  **resume 钩子挂在这两个事件上**:answered → resume+kick「gate 已答」;
  timed-out → resume+kick「gate 超时,按 fail-open/fail-close 行事」(fail-close
  时模型按提示词自行 complete --route blocked,行为与 Claude 对齐)。
- MED-7 waiting ceiling(默认 49h)已保证等门期间 overall budget 不炸;
  paused 等待天然落在这个已有的预算语义里,无需新预算轨道。
- 模型侧第二条自杀路径:模型直接跑 `complete --route blocked`(契约 failure
  path)。runtime 拦不住 CLI 写库,需要 CLI 侧 guard:`complete --route blocked`
  时若本 exec 存在未答、尚未被 watcher 解析移除的 mandatory gate marker →
  拒绝并提示继续等
  (`complete.ts` + gate-marker 读取,读取函数 `listGateMarkersForExecution`
  已在 flywheel-comm/gate-marker 导出)。

## R2. retry 不发 TURN 带(缺陷②)

- start() 的 FLY-887 seam:`run-dispatcher.ts:995-1016`。条件
  `req.shareParentBranch === true && isThreeStagePhaseRole(role) &&
  threeStageKeepAliveEnabled()`;fail-closed(grant 失败 → 清 inflight +
  pre-registration → throw)。
- `CommDB.grantTurn`(`db.ts:929-947`):`INSERT … ON CONFLICT(issue_id) DO
  UPDATE SET holder_exec_id=…, epoch=epoch+1` —— **天然原子转移**,旧 holder
  被覆盖,epoch 单调递增使旧 exec 的迟到 wake 可识别。Bridge 是唯一 writer,
  retry dispatch 也在 Bridge 进程内,权限模型不变。
- `RetryDispatcher.dispatch()`(`run-dispatcher.ts:438-696`)从 admission →
  pre-register → ctx → blueprint.run 全程无 grantTurn。actions.ts 的 phase-row
  retry(`actions.ts:843-905`)传 `shareParentBranch: true` +
  `sessionRole: phaseRole`,条件材料齐备。
- 插入位置:pre-register 之后、`blueprint.run` 之前(与 start() 同序);失败
  清理复用 dispatch() 已有的 `cleanupPreRegistration` + `inflight.delete` +
  (若有)`lifecycleLaunchGuard.onSpawnFailed` 对称路径。
- 既有测试:`run-dispatcher-fly887-turn-seam.test.ts`(start 侧),retry 侧
  直接镜像扩展;`actions-retry-route.test.ts` 覆盖 actions 层。

## R3. retry takeover 缺 startPoint(缺陷③)

- 守卫:`Blueprint.ts:765-804`。takeover 触发条件
  `shareParentBranch && (implement|qa) && keepalive && isRegistered(expected)`;
  守卫要求 `clean && ctx.startPoint && head === ctx.startPoint`。
- 现有 startPoint 供给方全景:
  - phase-orchestrator 每处 dispatch 带 captured `headSha`
    (`phase-orchestrator.ts:1261/1459/1735`);
  - FLY-795 resume(start 路径)`startPoint = git rev-parse <branch B>`
    (`progress-resume.ts:39-40,130-135`);
  - auto-QA 传 parent `pr_head_sha`;
  - **retry 路径:无 —— `RetryRequest` 没有字段,dispatch() ctx 不含。**
- **副发现(数据丢失口)**:worktree 未注册(被删)时走 create 路径,
  `WorktreeManager.create` 用 `git worktree add -B <branch> <startPoint>^{commit}`
  (`WorktreeManager.ts:228-241`);显式 startPoint 缺失时先取
  `FLYWHEEL_RUNNER_START_POINT`,env 也缺失才落 `origin/main`。**最后这个 fallback
  会让 `-B` 把已存在的 branch B 强制重置回 origin/main,静默丢弃 phase 已提交的
  工作**。
  retry 带上 branch-B-tip 后,`-B <branch> <tip>` = 重置到自身 tip = 无损重建,
  同时修 takeover(worktree 还在)与 recreate(worktree 被删)两条路径。
- branch 名推导:必须复用 `resolveWorktreeKey(issueId, {sessionRole,
  shareParentBranch})` + `WorktreeManager.worktreeName`(FLY-795 的
  `branchName` deps 同款),防命名 drift。三段式 shareParentBranch 的 key
  与 role 无关(共享 branch B),phase-row retry 均可推导。
- tip 读取:`git rev-parse --verify --quiet refs/heads/<branch>^{commit}`(全限定本地
  branch;FLY-795 的 `revParse` deps 同族)。branch 确认不存在(如 design 首跑即死
  没建过分支)→不设 startPoint→沿用既有 env/origin-main fallback;其他 git/IO
  错误不可伪装成 missing,必须 fail-close。
- 实现位点选择:**dispatch() 内部**优于 actions.ts —— dispatch() 手里有
  `runtime.projectRoot`(git 操作要它),且 retry 的其他入口(若有)同样受益;
  actions.ts 无需知道 worktree 命名细节。

## R4. blocked 吞审查门(缺陷④)

- 凶手链:GatePoller 周期 `zombieGateHygienePass`(`gate-poller.ts:3181-3237`)
  → 候选 = `db.getPendingQuestions(lead)` 里 checkpoint 非空、未被 eviction
  跟踪的 → `runZombieGateHygiene` Z1:StateStore 终态(含 `blocked`,
  `StateStore.ts:212-220`)+ CommDB session 行缺失 → `retireQuestionGuarded`。
- 撞法时序:会话 blocked + CommDB 行被 teardown 删除 → 之后新开
  `gate review_code --no-block`(question = CommDB messages 行)→ 下一个
  hygiene tick 在 `request-review` 绑定/审完之前退掉它。宽限期方案赌不过
  review 时长(一轮几十分钟),排除;时间序判定是本质修法:**gate 创建晚于
  会话进入终态 = 生命迹象,永不 Z1**。
- 时钟源(Lead brainstorm 批复的设计注意:同一时钟源,都用 DB 时间戳):
  - gate 侧:CommDB `messages.created_at` = `DATETIME DEFAULT
    CURRENT_TIMESTAMP`(SQLite 服务端 UTC,"YYYY-MM-DD HH:MM:SS")。
    `getPendingQuestions` 返回行已含 `created_at`(bootstrap-generator.ts:279
    已消费),`ZombieCandidateQuestion` 加一个字段即可透传。
  - 会话终态侧:**现状没有可靠的「进入终态时刻」**——sessions.updated_at 会被
    终态后的无关写入(session_params 等)推后,拿它比较会把「终态后、
    updated_at 前」创建的 gate 误判回僵尸(正是事故窗口)。候选:
    (a) **新增 `sessions.terminal_at` 列(推荐)**:在 StateStore 状态写入点
        (upsert / persistTransition / forceStatus,即 lifecycle_revision 已经
        统一递增的同一批位点)进入 ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES 时
        以 `datetime('now')` 盖一次戳(仅从非终态→终态时写,不重复盖);
        与 CommDB created_at 同为 SQLite 服务端 UTC,字典序可比。
    (b) session_events 里找终态事件 ts —— 终态转换并非所有路径都发事件,
        覆盖不全,排除。
  - 迁移兼容:`terminal_at` 为 NULL 的存量终态行(pre-migration)→ 无法时间序
    判定 → **fail-open 保守跳过 Z1**(不退门)。理由:Z1 是打扫工,漏扫的
    真僵尸下个 Bridge 周期内新终态会有戳;而误退活门直接把会话打死(本缺陷),
    两害相权取保守。存量僵尸门本来也已被 FLY-1099 上线以来的历史 pass 清过。
- Z2 分支、kill-switch(`FLYWHEEL_ZOMBIE_GATE_RESOLVE`)、三相审计
  (intent/mutation/outcome)全部不动;改动只在 Z1 的候选判定谓词上加一条。
- 既有测试:`zombie-gate-watchdog.test.ts` 扩 Z1 矩阵;另补 GatePoller 透传哨兵与
  `StateStore.test.ts` 三入口时间戳矩阵。`zombie-scan.test.ts` 是另一套进程扫描,
  不动。

## R5. 测试面清单(fixture = 2026-07-14 实战场景)

| 缺陷 | 既有测试文件 | 新增回归场景 |
|---|---|---|
| ①提示词 | `Blueprint.fly1188-codex-prompt.test.ts`、`Blueprint.fly1188-codex-identity.test.ts` | codex 分支五处等门文本断言含「资格≠指令/持续 poll/仅真 timeout·error·reject 才 fail-close」且共享块只渲染一次;Claude 分支 byte-compat |
| ①CLI | `complete.test.ts`、`gate-marker.test.ts` | marker-capable Codex 的 `complete --route blocked` 撞未答 marker → 拒绝;env 未注入(Claude)整段跳过;env 已注入但目录/本 exec marker 不存在、marker 已答/已移除 → 放行;损坏/不可读 → fail-close |
| ①runtime 主修 | `codex-daemon-client.test.ts`、`codex-daemon-goal-runtime.test.ts`、`CodexTmuxAdapter.test.ts` | goal 翻 blocked 时 isWaiting()=true → 不终态、进入持有;marker answered/超时移除 → active+完整 objective/budget+kick;latch 覆盖 daemon/Bridge 重启窗口;isWaiting()=false 且无 latch 的 blocked 照旧终态 |
| ①M-opt(若做) | 同上 + probe 产物 | probe 先证明 RPC pause/resume/重启持久化;PASS 后才叠 paused 状态,probe FAIL 则摘除且不影响主修持有 |
| ② | `run-dispatcher-fly887-turn-seam.test.ts` | phase-row retry dispatch 后 `getTurn` = 新 execId、epoch 递增;grant 失败 → dispatch 抛 + 清理;非 phase retry 零行为变化 |
| ③ | `Blueprint.fly887-worktree-takeover.test.ts`、dispatcher 测试 | 注册 worktree + clean + head==tip 的 phase retry → takeover 成功;dirty → 照旧拒;branch 不存在 → 不设 startPoint 走 create;worktree 被删 + branch 有已提交工作 → create 重置到 tip(不丢工作) |
| ④ | `zombie-gate-watchdog.test.ts`、GatePoller 层测试、`StateStore.test.ts` | blocked 会话 + 终态后新建 gate → Z1 跳过(永不退);终态前建的 gate → 照退(FLY-1099 不回退);terminal_at/created_at NULL、损坏、同秒 tie → 保守跳过;三条状态写路径盖戳/保戳/revive 清戳 |

## R6. 波及面结论

- ①主修改 Blueprint codex 分支文本 + `codex-runner-contract.md` +
  `flywheel-comm/complete` guard + `claude-runner` 的 goal-loop 持有/重启 latch;
  M-opt(若做)只在同一骨架叠 paused RPC。Claude runner 路径零接触(全部在
  codex-only 文件/分支)。
- ② 改 `run-dispatcher.ts`(dispatch() 加 seam)。start() byte-compat。
- ③ 改 `run-dispatcher.ts`(dispatch() 推导 branch tip → ctx.startPoint)。
  Blueprint 守卫本身不动。
- ④ 改 `StateStore`(terminal_at 列 + 状态写入点盖戳)+
  `zombie-gate-hygiene.ts`(谓词)+ `gate-poller.ts`(透传 created_at)。
  Z2/审计/kill-switch 不动。
- 四项主修互相独立可分 commit,均不依赖 probe;只有优化项依赖 M-opt probe 结论
  (probe 失败的降级线:goal loop 拦截后不 pause、改为「不 kick 的静默等待」;
  probe 结论写进 plan 的风险节)。优化项整体可摘除,不影响止血。
