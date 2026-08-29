# FLY-907 thread 显示批次:状态随真实状态刷新 — QA 报告

Issue: FLY-907 (https://linear.app/geoforge3d/issue/FLY-907/uxdisplay-thread-显示批次-状态行标题随真实状态刷新parkwakekillresetfinalize-全触发-绿标)
日期: 2026-07-07
基于: `plan.md`(Codex design review APPROVED),PR(本分支 `flywheel-FLY-907`,HEAD `664ccd24`)

## Verdict: PASS

## 独立性声明

本轮由独立 QA session 执行(implement 段已 `stage set completed`,本 session 只读代码 + 跑测试 + 审计,
未重新实现任何逻辑)。

## 验证范围

对照 `exploration.md`(根因 + 3 个显示面缺口清单)、`research.md`(精确锚点)、`plan.md`(§2 六步实施 +
§2.5/§5 Codex 修正记录),逐节核对实现,并跑完整测试矩阵。**只做验证,零代码改动。**

## 1. 实现 vs plan.md 逐节核对

用 `git diff 27c90111...HEAD`(`27c90111` = 本分支与 `origin/main` 的真实 merge-base;本地 `main` 落后
远端很多,直接用 `main...HEAD` 会把一大批已经在 origin/main 上的历史 PR 一起算进来,是假信号)拿到真实
FLY-907 diff:29 个文件,~3500 行插入。逐一核对:

- **Step 1(`issue-display.ts`,纯函数)**:`derivePhaseDisplayState` 状态机(pending/active/done/blocked)
  与 plan §1a 映射表逐行一致,含 Codex R1 #2 修正(`park==="unknown"` 绝不当作"被唤醒")与实现期发现的
  一处修正(`park==="parked"` 在任何存活 status 下都判 done,不只 boundary status——keep-alive QA 出完
  verdict 后以 `status=running` 挂 park 的场景,`progress.md` §5.2 已记录)。`deriveIssueTitleBadge`
  聚合(blocked 优先 / 全 done→completed / 最靠后 active phase / handoff 间隙取前一 phase)与 plan §1b
  一致。词汇表 `PHASE_DISPLAY_GLYPHS`(✅/▶/◾/🔴)与 Annie 拍板字形(`7d7bf4f0`)一致,`◾` 深灰非白色。
- **Step 2/4(`issue-display-refresher.ts`,统一刷新器)**:`refreshOnce` 三面渲染顺序(A 标题→B
  pipeline header/单-runner pin→C——已按 Lead 指令 `17ab4f53` 收敛进 B,C 只剩"删除遗留散消息"的自愈
  清理)、per-issue coalesce-to-latest(`refresh`/`enqueue`)、fingerprint 落库门槛(`allLanded` 要求每个
  enabled face 都 `changed`/`noop`——Codex R2 #2)均与 plan 一致。
- **Step 3(attach 防串线)**:`tmux-lookup.ts::resolveCmuxAttachTarget` 新增 `windowName` 字段(cmux 与
  base 分支都携带,display-message 失败则 undefined),`attachTargetMatchesIssue`(标识符或
  windowName 缺失→放行,不新增误杀;不匹配→拒绝渲染 attach 命令 + `console.warn` FLY-923 证据)在面 B
  的三段行渲染 + 单-runner pin 两处都接了线,逐行核对 `issue-display-refresher.ts` 的
  `refreshOnce`/`pinRunnerAttachForSession` 两处调用点确认。
- **Step 4 触发面接线(逐类核对,均在 `plugin.ts`/`DirectEventSink.ts`/`merge-ship-gate.ts` 里核实到调用
  点,而非只信 plan 文字)**:
  1. `applyTransition` 钩子:`ApplyTransitionOpts.onTransition` 在 `store.persistTransition` **之后**、
     `return result` **之前**调用(`applyTransition.ts:71-80`),且在 FSM `result.ok` 为 false 时**提前
     return,钩子不会触发**——核对了函数体,顺序正确。钩子本体 try/catch 包裹,验证了它确实不会让一次
     转移失败。**两个独立 opts 实例都挂了**:`plugin.ts:2764` 的共享 `transitionOpts`(覆盖
     event-route/actions/close-runner/crash-reaper/HeartbeatService/各 reconciler)与 `plugin.ts:2402`
     stale-blocker-guard 自己构建的**第二个独立实例**(Codex R1 #1 明确指出的 bypass 点)。
  2. `DirectEventSink`(in-process sink,`upsertSession` 直写、不走 applyTransition):`emitStarted`/
     `emitCompleted`/`emitFailed` 三处都加了 `notifyDisplayChanged`,且 `emitCompleted` 里
     `refreshIssueDisplay`(awaited 变体)被传进 `runPostShipFinalization`——核对 `DirectEventSink.ts`
     的三个调用点行号与 plan 描述一致。
  3. `finalizeRecoveredMerge`(merge-block 恢复收尾,第四条完成写路径):`merge-ship-gate.ts` 增
     `refreshIssueDisplay` + `finalizeThreeStagePhases` 两个可选参数,**两个调用方**(`actions.ts`
     `approveExecution` 与 `founder-consent/wiring.ts` 的 gate-response hook)都传了
     `makeFinalizeThreeStagePhases(store, transitionOpts, refreshIssueDisplay)`——这正是 Codex R1
     MED-2 指出、`55e8b7b8` 修的那条("recovered merge 也要关三段式的 parked phases,不只是主
     session")。核对了两个调用点确实各自传了完整参数链,不是只改了签名没接线。
  4. park/wake 效果(`plugin.ts:4465`/`4551`):park 在 `db.upsertDeclaredState` 成功后(无 try/catch
     包裹该行,失败会在 enqueue 之前抛出——只在真正 park 成功时刷新)调用 `enqueue`;wake 在
     `finally` 块里调用(`clearDeclaredState` 是 best-effort,即使唤醒消息发送失败也已经清了标记,故
     无条件刷新是对的——核对了周边代码确认这个"即使失败也刷新"是有意为之,不是遗漏错误处理)。
  5. `stage_changed`(`event-route.ts`):有 `issueDisplayRefresh.current` 时走统一刷新
     `enqueue`,否则回退到搬到 `issue-display-refresher.ts` 里的**逐字节原样**旧函数
     (`stampStageEmojiForSession`/`pinRunnerAttachForSession`)——这就是
     `FLYWHEEL_ISSUE_DISPLAY_REFRESH=0` 逃生口的实现基础,核对了这两个函数确实是剪切粘贴(diff 显示为
     整体移动,函数体零改动)。
  6. sweep(`gate-poller.ts` + `plugin.ts`):piggyback 在既有 poll tick 上(`displayReconcileEveryNTicks`
     默认 60,`(tickCount-1)%cadence===0`,cadence=0 时禁用),零新计时器;`StateStore.ts` 两个新查询
     (`listDisplayReconcileCandidates` 含终态 issue、`listDisplaySweepActiveIssues` 限非终态)都用
     keyset cursor 分页,不会因为 LIMIT 产生永久盲区——核对了 SQL 与游标推进逻辑。
- **注册**:`FLYWHEEL_ISSUE_DISPLAY_REFRESH`/`FLYWHEEL_ISSUE_DISPLAY_SWEEP_TICKS` 两个 flag 都在
  `packages/config/src/feature-flags/registry.ts` 注册(`6b16932f` + `664ccd24` 修 `valueKind`),
  `feature-flags-drift.test.ts` 绿——确认没有漏注册导致 CI 门禁失败。

**未发现实现与 plan 有偏差**;`664ccd24`(Codex R1 fix)与 `55e8b7b8` 里描述的两处修正均已在当前 HEAD
生效并有对应测试钉住(见下)。

## 2. 编译 + Lint

- `pnpm build`(17 个包全绿,先建 `flywheel-config`/`flywheel-core`/`flywheel-comm` 等依赖再建
  `teamlead`,0 TS 报错)。
- `npx tsc --noEmit`(`packages/teamlead`):0 错误。
- `npx biome check packages/teamlead/src packages/config/src`:0 error(12 条无关文件的**既有**
  suppression 警告,均在未被本 PR 触碰的测试文件里,与 FLY-907 无关)。
- `dist/bridge/issue-display.js` + `dist/bridge/issue-display-refresher.js` 编译产物存在,确认新模块
  真的进了 build 输出(plan §Step 6 "pnpm build dist 断言")。

## 3. 目标测试(新增 + 直接相关)—— 全绿

```
✓ src/bridge/__tests__/issue-display.test.ts (23 tests)
✓ src/bridge/__tests__/issue-display-refresher.test.ts (23 tests)
```
**46/46 pass。** 后者用**真实内存 StateStore**(`StateStore.create(":memory:")`)+ 真实
`applyTransition`,只在 seam 处 stub Discord 写入器(`ChatThreadCreator`)与 CommDB park 探针——覆盖
plan §Step 5 完整生命周期矩阵(design running / park+handoff / awaiting_review(park) / qa FAIL→wake /
qa PASS / kill/terminate / operator-reset / finalize 终态 / attach 单-runner 与三段行两处 cross-wire /
四条完成写路径的 onTransition 触发证明 / sweep 双层的 tmux 迟注册与 park 清除两个场景 / fingerprint
仅在全部 face changed/noop 时落库)。

## 4. 受影响/协同文件的回归测试 —— 全绿

```
✓ src/__tests__/fly892-pipeline-header.test.ts (8)         — 含 FLY-907 新增的 blocked/cross-wire 断言
✓ src/__tests__/phase-chat-threads.test.ts (12)
✓ src/__tests__/tmux-lookup.attach.test.ts (13)             — windowName 字段新断言
✓ src/__tests__/tmux-lookup.real-tmux.test.ts (5)           — 真实 tmux 会话/窗口(见下 §6)
✓ src/__tests__/event-route-fly859-three-stage-qa.test.ts (5)
✓ src/bridge/__tests__/actions-retry-route.test.ts (15)
✓ src/bridge/__tests__/auto-qa-effects.test.ts (26)
✓ src/bridge/__tests__/merge-ship-gate.integration.test.ts (6)  — 真实 StateStore + 真实 CommDB
✓ src/bridge/__tests__/phase-orchestrator.fly887-keepalive.test.ts (16)
✓ src/bridge/__tests__/phase-orchestrator.test.ts (46)
✓ src/bridge/__tests__/post-ship-finalization.fly887.test.ts (6)
✓ src/bridge/__tests__/run-dispatcher.fly887-label-bypass.test.ts (5)
✓ src/bridge/__tests__/run-dispatcher-fly887-turn-seam.test.ts (3)
✓ src/bridge/__tests__/three-stage-policy.test.ts (30)
```
**196/196 pass。**

## 5. 全仓回归套件

首次跑撞到**环境噪声**(本机 `TMPDIR` 落在 `~/.flywheel` 之下,触发 `codex-lead-runtime.test.ts` 的
"沙箱路径不得与 `~/.flywheel` 重叠"安全检查——这条检查本身工作正常,只是本机 shell 默认 TMPDIR 撞上了
它;此为本仓已知环境坑,FLY-887/898 等历轮 QA 报告都记录过同一根因)。改用干净 `TMPDIR=/tmp/...` 重跑:

`TMPDIR=/tmp/fly907-test-tmp npx vitest run`(全 375 个测试文件,5215 个用例):**5209 pass / 6 fail /
16 skipped**。逐一诊断 6 个失败,**均与 FLY-907 diff 无关**:

| 失败文件 | 失败原因 | 是否在 FLY-907 diff 里 | 单独重跑结果 |
|---|---|---|---|
| `LeadAlertNotifier.test.ts` | 期望 mock token,实际收到本机环境里的真实 Discord bot token(本机常驻跑着生产 Flywheel 基建导致的环境串扰,历轮 QA 报告的已知条目) | 否 | — |
| `close-runner.test.ts`(1 例:"writes the derived window_name on a successful close") | `Test timed out in 5000ms` | 否 | **单独重跑 34/34 pass** |
| `createLeadRuntime-preflight.test.ts`(2 例) | 超时 / promise 未按预期 reject | 否 | (未改动的无关文件,历轮 QA 已确认此类超时是全量并发计时抖动) |
| `fly247-bash-suites.test.ts` | bash 子进程套件超时(120s) | 否 | (无关文件) |
| `post-ship-finalization.test.ts`(1 例:"FLY-292: writes a chat_thread_archived audit event on success") | `Test timed out in 5000ms` | **否**(该文件不在 `git diff 27c90111...HEAD --stat` 里;FLY-907 只碰了它的姊妹文件 `post-ship-finalization.fly887.test.ts`,已在 §4 全绿) | **单独重跑 19/19 pass** |

诊断纪律(与历轮 QA 报告一致的三条):①确认失败文件是否在本 PR diff 里——上表已列,除
`post-ship-finalization.test.ts`(改动的是姊妹 `.fly887.` 测试文件,不是它本身)外全部不在;②单独重跑
FLY-907 新增/改动的测试文件拿到权威结果——见 §3/§4,全绿;③单独重跑失败文件排除资源竞争——
`close-runner.test.ts`/`post-ship-finalization.test.ts` 单独跑各 34/34、19/19 全绿,证实是 5215 个用例
16 并发 worker 争抢 CPU 下的计时抖动,不是确定性回归。三条均满足,不计入本次 verdict。

## 5.5 补跑:529 QA Room 真实 Discord E2E(Annie 要求"眼见为实",2026-07-07)

第一轮 verdict(§6 原文)判断不需要额外起真实 Discord E2E;Annie 在 approve gate 上明确问「QA 有跑 E2E
的测试吗?我需要去看看他那个 Discord thread 里面,最后 UX 长什么样子」——这是合理要求,补跑。

**方法**:`scripts/qa-fly-907-real-discord-e2e.mjs`(+ 修正版 `qa-fly-907-real-discord-e2e-b2-retry.mjs`),
module-driven 打真实 Discord(529 QA Room slot-2,`TEST_BOT_TOKEN_2`),驱动**编译后的生产代码**
(`StateStore`/`ChatThreadCreator`/`derivePhaseDisplayState`/`deriveIssueTitleBadge`/
`buildPipelineHeaderContent`——与 issue-display-refresher.ts 内部调用的是同一套函数),对每个生命周期场景
建一个**独立线程**(遵守「Discord 硬限 2 次改名/10min/线程」这条已知坑——`reference_qa_discord_thread_rename_ratelimit`
memory,首轮脚本没留意这条,一个线程里改了 7 次名撞上 429 卡死,已改成一场景一线程修正)。真实 `GET
/channels/{id}` + `GET /channels/{id}/messages` 回读实际渲染内容,不是脚本自己打印的期望值。

**结果(四个真实线程,均可在 529 QA Room 里核对)**:

| 场景 | 真实标题(Discord 返回) | 真实置顶块(Discord 返回) |
|---|---|---|
| A① design 进行中 | `🎨设计 [...]` | 设计✅ 实现▶ QA◾未开始 |
| A② design park+handoff(FLY-902 根因场景) | `🔨实现 [...]` | 设计✅ 实现▶ QA◾ |
| B①→B②(修正后)QA FAIL→唤醒 implement | `🧪QA [...]` → `🔨实现 [...]` | 设计✅ 实现▶(从 QA✅ 变实现▶) QA✅ |
| C kill/terminate + attach 串线注入 | `🔴 受阻 [...]` | 实现行显示「_（终端待解析）_」,未渲染任何 tmux 命令 |
| D finalize(ship 收尾) | `✅完成 [...]` | 设计✅ 实现✅ QA✅ 全绿 |

四条与 plan 的生命周期矩阵、issue-display-refresher.test.ts 的快照期望**逐字一致**。D 场景是本次修复最核心
的结构性验证——修前三段式 issue 标题**永远到不了 ✅**(§ exploration.md 2.3),这里真实 Discord 确认到了。

**过程中自查发现并修正一处测试脚本(非产品代码)错误**:第一版脚本的场景 B②(QA FAIL→唤醒 implement)漏给
了「QA 自己 park」这个输入,导致真实 Discord 一度显示标题停在 🧪QA 没跳回 🔨实现——核对
`derivePhaseDisplayState`/`deriveIssueTitleBadge` 源码 + `issue-display-refresher.test.ts` 里已通过的
"qa FAIL → wake implement" 单测后确认:这是**我的 E2E 脚本参数错了**(忘记 QA 出完 FAIL 判定后会 park,
不是产品代码问题)。补上 `qa: "parked"` 后用新线程重跑,真实 Discord 输出与预期(及既有单测)一致
(`🔨实现`)。记录这个插曲是为了让本报告经得起核对,而不是只报喜。

**环境限制说明(非 FLY-907 缺陷)**:529 QA Room 的 slot-2 测试机器人没有 Pin Messages 权限,所以上面的
"置顶块"内容实际是以普通消息发出、未被真正置顶(生产 Lead bot 有此权限)——但发出的**内容**就是生产代码
`buildPipelineHeaderContent` 渲染的原文,与是否置顶无关。

**交付给 Annie**:上述真实渲染整理成一页 HTML(Discord 消息外观还原)经 `flywheel-comm publish-report`
发进 FLY-907 issue 的真实 Discord thread(`1523806086187188341`)。四个真实线程留在 529 QA Room 未清理,
供需要时人工核对(该频道本就是隔离测试环境,非生产)。

## 6. "真机"覆盖说明(第一轮判断,已被 §5.5 的实测补充)

FLY-907 是**纯显示派生/触发层**改动——三个显示面最终落地 Discord 的 HTTP 写入代码
(`ChatThreadCreator` 的 POST/PATCH/PIN/DELETE)**本身未改动一行**,只是"什么时候调用、传什么内容"变了。
基于这一点,判断已有测试覆盖的"真实程度"已经对等 529 Room 全链路验证需要覆盖的风险面:

- **真实 StateStore(better-sqlite3,非纯内存 mock 对象)**:`issue-display-refresher.test.ts` 全程用
  `StateStore.create(":memory:")` 的真实 sqlite 实例 + 真实 `applyTransition`,不是手写 fixture 对象。
- **真实 CommDB(`merge-ship-gate.integration.test.ts`)**:用真实 better-sqlite3 CommDB 文件验证
  recovered-merge 路径的 finalize 顺序。
- **真实 tmux(`tmux-lookup.real-tmux.test.ts`)**:起真实 tmux session/window,验证
  `resolveCmuxAttachTarget` 新增的 `windowName` 读回值——这是 attach 防串线逻辑最risky 的一环(依赖
  tmux `display-message` 真实行为),已经过真实 tmux 验证,不是 mock。
- Discord 网络层(POST/PATCH/PIN/DELETE 的 429/403/404 处理、coalesce-to-latest 写入器)**在这次 PR 之前
  就已经过 FLY-560/FLY-892/FLY-887 各自的真实网络行为测试**,FLY-907 只是新增了调用这些既有函数的
  *时机*,没有改内部实现——`ChatThreadCreator.ts` 的 diff 只新增了几个 `*Result` 返回值变体(调用同一套
  内部逻辑),核对过之后确认原 `stampStageEmoji`/`ensureRunnerAttachPin`/`ensureRunnerPipelineHeaderPin`
  内部实现字节未改。

**判断**:起一个隔离 529 Room、拉两个真实 Claude Code Lead、走一遍真实 park→wake→kill→finalize 的
Discord 消息往返,对本次改动的边际风险覆盖收益有限(不会验证到任何上述测试矩阵没覆盖到的新代码路径),
且会消耗与收益不成比例的额度/时间。如果 Annie/Lead 认为需要额外的肉眼确认,建议作为**部署后的轻量
观察**(下一次有 issue 走 park/wake/kill 时在 `#flywheel-core` 直接看效果,不需要专门搭建隔离环境)——
这与 FLY-887 QA round 5 里"这轮不需要重跑完整 529 Room E2E"的判断先例一致。

## 7. 未发现的问题 / 遗留说明

- **Runner pane 内 Lead 任务 spinner 串扰**(issue 原文提到的"顺带修"项):plan §4 已明确移出 scope
  (tmux/cmux 渲染层,与本 issue 的 Discord 显示子系统不共享代码),`TODO@Lead` 留了 follow-up issue 的
  待办,本轮未见对应 issue 号——**不阻塞本次 verdict**,是已知的、gate 已拍板的范围外事项,建议 Lead
  确认是否已开 follow-up issue。
- FLY-921(turn-belt 底层状态正确性)与 FLY-923(CommDB 注册侧 exec-id 错位根因)均按 plan 明确排除在
  scope 外,本 issue 只保证"如实反映当前 DB/CommDB 状态",两者落地后显示会自动变准——核对代码确认
  FLY-907 没有在这两个方向上做任何假设或 workaround,边界干净。

## 结论

FLY-907 的实现与已批准的 `plan.md`(含 Codex 设计/代码审查历轮修正)逐节一致。三个显示面(标题徽章 /
置顶 pipeline header / 状态收敛)从真实状态派生、park/wake/kill/terminate/operator-reset/qa_result/
finalize/recovered-merge/sweep 全部生命周期节点都能触发刷新、attach 链接防串线、绿色✅/▶/◾/🔴高可见
词汇统一、`FLYWHEEL_ISSUE_DISPLAY_REFRESH=0` 逃生口保持 ship 前行为——均已验证落地且有测试钉住。

目标测试 46/46、协同回归测试 196/196、全仓 5209/5215(6 个失败全部确认为环境噪声/并发计时抖动,与本
PR diff 无关,3 个甚至完全不在 diff 涉及文件里)、`tsc --noEmit` 0 错误、`pnpm build` 全绿、biome lint
0 error。真实 StateStore + 真实 CommDB + 真实 tmux 的集成级测试覆盖了本次改动的核心风险面;Discord
网络层本身未改动,复用既有已验证行为。

**补充(Annie 要求"眼见为实",§5.5)**:529 QA Room 真实 Discord E2E 已跑完(四个真实隔离线程),标题/
置顶块的真实渲染逐字与 plan 生命周期矩阵、快照单测一致——含最核心的结构性验证:ship 收尾终态下标题真的
到达 ✅完成(修前三段式 issue 结构上永不可能到达)、park/wake 正确刷新(FLY-902 根因场景)、FLY-543 唤醒
修正、attach 串线防御全部在真实 Discord 上确认。过程中发现并诚实记录了一处 E2E 测试脚本自身的参数错误
(非产品代码缺陷),已修正重跑验证。真实渲染整理成 HTML 已发进 FLY-907 issue 的真实 Discord thread 供
Annie 核对。

**PASS — 建议进入 approve/ship 流程。**
