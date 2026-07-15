# FLY-1234 watchdog stuck 误报审计 — 调研

Issue: FLY-1234 (https://linear.app/geoforge3d/issue/FLY-1234/bug-watchdog-的-pane-judge-判定层在场却没挡住-5-次-stuck-误报-审计今天-5-个真实案例定位漏拦点)
日期: 2026-07-13
基于: exploration.md

## 1. 目标

exploration.md 定位了三个漏拦点（漏① session_stuck 无 pane/进程确认层；漏② judge env 未通电；漏③ busy 自报没人用），brainstorm gate 批了方案 A（内联 checkStuck 确认层 + 借道 routeSuspiciousReport）+ 修正（新开关默认 ON、`=0` 才关）。本文钉死实现所需的全部代码落点、复用件接口、并发/失败语义与测试先例。

## 2. 复用件清单（全部已在库，零新轮子）

### 2.1 进程活性四态探针（#576 / FLY-720）

`probeRunnerProcessLiveness(tmuxWindow)` — `packages/teamlead/src/bridge/tmux-lookup.ts:371`
- 读 `tmux list-panes -F '#{pane_dead}'` → `alive` / `dead_pin`（窗在进程尸）/ `absent`（窗没了）/ `indeterminate`（读失败，GEO-374 语义=当活）。
- HeartbeatService 已 import 并在 `isSessionTmuxAlive`（:800）与 orphan 路径（:1364）使用 —— 确认层直接复用，无新依赖。
- tmux target 解析：`lookupTmuxTarget(execution_id, project_name)`（同文件，`gone`/`error`/`ok` 三态），HeartbeatService:814 已有用法可照抄。

### 2.2 pane 抓帧

`captureSession`（plugin.ts:359 以 `defaultCaptureSession` 引入；A7 用法 plugin.ts:4997：`defaultCaptureSession(execId, projectName, 200)` → `{output}` 或错误对象）。确认层的注入依赖 `captureFrame(session)` 在 plugin.ts 组装层用它构造。

### 2.3 帧比较语义（「看两次」）

两处现成语义，确认层选**原始帧相等**（raw compare）：
- `fingerprintOutput(output)`（stuck-candidate.ts:185，SHA-256 前 16 hex）—— raw 帧任何变化（含 spinner 秒计数、token 流）都算「在动」→ 干活。这正确处理了 xhigh 长思考：spinner 计数每秒变 → raw 帧必不同 → 抑制。
- `normalizeForQuietFingerprint` / `quietFingerprint`（quiet-classifier.ts:124/134，去 spinner/计时器噪声）—— **不用于**「是否在动」判定（会把活 spinner 洗成静止），仅当需要 FLY-626 episode 去重键时用。
- 帧窗口取法：**tick 内两抓**（间隔 `FLYWHEEL_STUCK_FRAME_GAP_MS` 默认 15s，有界 await），不跨 tick 存帧 —— 避免跨 tick 状态机与 +10min 告警延迟；15s 对「真冻结」足够（真冻结的 pane 15s 内逐字节不变），对「活 spinner」必然有差异。checkStuck 本身已是 async 串行 tick（interval 300s，见 §4），一次 tick 内对**至多少数 quiet_unexplained 会话**各 await 15s 可接受；上限保护见 §5 风险 2。

### 2.4 judge 路由（FLY-1048 PR-B）

`routeSuspiciousReport(deps, report)`（watchdog-judge.ts:469）—— 完整复用，含单飞队列、10min 冷却缓存、fail-closed：
- `judgeEnabled: () => process.env.FLYWHEEL_WATCHDOG_JUDGE === "1"`（调用时读，翻 env 即时生效）。
- `deps.deliver` 是**注入语义** —— plugin.ts:4807 的 `deliverSuspicious` 注入的是 A5 Lead 静默投递；确认层注入**自己的 deliver = 发射 session_stuck wake**。judge `a_working`/`b_parked`（有机械佐证）→ `suppressed`（自动落 `watchdog_judge_suppressed` 审计事件）；`c_stuck` → deliver（reason 追加 verdict 注解）；`suspicious`/null/judge 失败 → deliver（fail-closed，真 stuck 不漏报）。
- `SuspiciousReport` 契约（detection-suspicious.ts:18）：`targetKind:"runner"`、`targetKey=execId`、`reason`、`paneTail`（buildPaneTail，≤15 行）、`episodeFingerprint`、`frames?`（in-process only，喂 judge）。
- `mechanicalParkEvidence` / `buildJudgeInput` 闭包（plugin.ts:4898/4929）可原样复用（提成共享或在组装层第二次实例化同款闭包）。
- **judge 冷却缓存按 targetKey 全局共享** —— 确认层与 suspicious 管道对同一 runner 的裁决互相受益（10min 内不重复烧 codex 调用），无冲突：verdict 语义一致。

### 2.5 judge prompt few-shot 强化（gate 裁决 ②）

`buildJudgePrompt`（watchdog-judge.ts:74）现有「Stuck looks like / Healthy looks like」两段。追加第三段「Known healthy-but-quiet formations（few-shot，源自 2026-07-13 五案例）」：
1. Codex/外部 review 等待：pane 尾部是 review driver 输出、静止,但 comm 上下文显示 review 刚启动 → `a_working`。
2. 长思考回合（xhigh）：spinner 行存在（esc to interrupt / Cooked for Ns）→ `a_working`。
3. 测试套件/长构建运行：pane 尾部是 test runner/build 输出、无错误签名 → `a_working`。
落点：prompt 文本 + `WatchdogJudgeInput` 已有 `stage`/`commEvents` 字段承载上下文，无接口改动。

### 2.6 发射与去重（不动的部分）

- 发射：`this.notifier.onSessionStuck(session, minutes)`（RegistryHeartbeatNotifier:1622 → HookPayload event_type=session_stuck → lead_events + EventFilter）。确认层判「emit」时走原调用点，dedup（`markStuckNotified`）逻辑不变。
- 判「suppress」时**不落 dedup**（下个 tick 重新评估 —— judge 冷却缓存天然限频，episode 不被永久关闭，符合 PR-B「suppress 带 TTL 重估」精神）。

## 3. 改动落点（实现阶段照此动刀）

| # | 文件 | 改动 |
|---|------|------|
| 1 | `HeartbeatService.ts` | 构造器追加可选注入 `stuckConfirm?: StuckConfirmDeps`（缺省 undefined = 行为逐字节不变，测试友好）。`checkStuck` 在 `isStuckWakeSuppressed` 之后、`onSessionStuck` 之前插入确认层调用（env=0 或未注入时跳过）。 |
| 2 | 新文件 `bridge/stuck-pane-confirm.ts` | 纯逻辑模块（项目惯例：pure + 注入 I/O）：`confirmStuckCandidate(session, deps) → Promise<{action:"emit"\|"suppress", annotation?:string}>`。三步：liveness → 双帧 → routeSuspiciousReport。所有失败路径 fail-closed 到 emit。 |
| 3 | `plugin.ts` | 组装 `StuckConfirmDeps`：`probeLiveness`（lookupTmuxTarget+probeRunnerProcessLiveness）、`captureFrame`（defaultCaptureSession）、`routeToJudge`（复用 watchdogJudge 实例 + 第二组 deps 闭包,deliver=回调 emit）。传入 HeartbeatService 构造。 |
| 4 | `watchdog-judge.ts` | `buildJudgePrompt` 追加 few-shot 段（§2.5）。 |
| 5 | 生产 `~/.flywheel/.env` | ship 步骤：加 `FLYWHEEL_WATCHDOG_JUDGE=1`（gate 裁决②）。代码内不改默认（judge 自身开关语义不动,独立回退杆）。 |
| 6 | 测试 | 见 §6。 |

确认层决策表（stuck-pane-confirm.ts 的合同）：

| liveness | 帧比较 | judge | 结果 |
|----------|--------|-------|------|
| dead_pin / absent / lookup gone | —（跳过） | —（跳过） | **emit**（真死,附注解） |
| indeterminate | —（跳过） | —（跳过） | **emit**（读不到=保持旧行为,不漏报） |
| alive | 两帧不同 | —（跳过） | **suppress**（在干活） |
| alive | 两帧相同 | a_working / b_parked(有佐证) | **suppress**（judge 审计事件落库） |
| alive | 两帧相同 | c_stuck | **emit**（reason 带 verdict 注解） |
| alive | 两帧相同 | suspicious / null / env 关 / judge 失败 | **emit**（fail-closed） |
| capture 失败 | — | — | **emit**（fail-closed） |

注意 judge 行 env 关的语义：`FLYWHEEL_STUCK_PANE_CONFIRM=1(默认)` + `FLYWHEEL_WATCHDOG_JUDGE` 未设 → 前两步（liveness+帧）照跑，第三步直通 emit。两开关正交，各自可独立回退。

## 4. 生产参数（审计核实值）

| 参数 | 值 | 来源 |
|------|-----|------|
| stuck 阈值 | 15 min（默认,未覆盖） | config.ts:37 `TEAMLEAD_STUCK_THRESHOLD` |
| checkStuck 周期 | 300s（默认,未覆盖） | config.ts:148 `TEAMLEAD_STUCK_INTERVAL`。5 案例落 :01:35/:11:35 = 5min tick 上 episode-dedup 后的可见节奏 |
| recent_comm 窗口 | 30 min | stuck-escalation.ts:117 `FLYWHEEL_STUCK_COMM_ACTIVITY_MS` |
| busy 自报 | 默认 60min / 上限 4h | declare-state.ts:29 |
| judge 超时/冷却 | 30s / 10min | watchdog-judge.ts:210/212 |

## 5. 风险与对策

1. **确认层拖慢 tick**：每个 quiet_unexplained 会话最多 15s(帧间隔)+30s(judge)。多会话同时 quiet 时串行放大 → 对策：per-tick 确认预算（如同 tick 最多确认 3 个,其余顺延下个 tick,顺延≠告警≠丢失 —— 会话仍在 stuck 集合,只是慢 5min）。judge 端已有全局单飞+冷却兜底。
2. **capture 打扰 runner**：capture-pane 是只读操作,RunnerIdleWatchdog/A7 已在生产以更高频率跑,无新风险面。
3. **suppress 后真 stuck 漏报**：suppress 不落 dedup → 下个 tick 重估;runner 真死时 liveness 步兜住（dead_pin 立即 emit,不受 judge 冷却影响 —— 冷却缓存只在进入第三步时被查）。
4. **judge 成本**：仅「静止帧+活进程」形态触发,今天量级 5 次/天,冷却 10min,单飞队列 —— 上界安全。
5. **两管道 judge 缓存串味**：同 targetKey 共享 verdict 缓存(§2.4)——语义一致,视为特性;plan 中加一条 interop 测试钉住。
6. **Bridge 重启部署**：纯 Bridge 侧改动,单次重启生效;按 memory 纪律与其他待 ship PR 攒批（feedback_coordinate_bridge_restarts / 攒成一次重启）。

## 6. 测试先例（照抄形态）

- **单元**：stuck-pane-confirm 决策表全行覆盖（注入 fake probe/capture/judge;vitest,teamlead 包惯例）。
- **checkStuck 集成**：现有 HeartbeatService 测试注入 fake notifier 的形态（`__tests__/` 中 FLY-626/637 相关用例）追加：quiet_unexplained + 各 confirm 结果 → emit/suppress/dedup 断言。
- **reverse-compat sentinel**（gate 修正项）：`FLYWHEEL_STUCK_PANE_CONFIRM=0` → checkStuck 行为与改动前逐字节一致（先例：`__tests__/infra-notify-bytecompat.test.ts`、FLY-1048 PR-C sentinel）。未注入 stuckConfirm deps（构造器缺省）同样走旧路径 —— 双保险。
- **interop**：`__tests__/stuck-detection-interop.test.ts` 已有两管道互操作测试文件,追加 judge 缓存共享场景。
- **5 案例回归 harness**（issue 验收）：模拟 5 形态 —— ①静止帧+review driver 子进程 ②spinner 计数帧(帧必不同) ③活跃 bash(帧不同) ④静止帧+活进程+judge a_working ⑤真死 dead_pin —— 期望 ①-④ 0 误报、⑤ 照发。真机段(implement/QA 阶段)：module-driven 跑 dist + 真 tmux pane 注入(memory 配方 reference_qa_detection_needs_real_stuck_not_break_worktree：要 freeze-while-working 形态或真进程死,break-worktree 不产生可检测卡死态)。

## 7. 明确不做（scope 边界）

- suspicion 注册表彻底合流（gate 裁决①后半：留给后续 issue,不在修误报的 PR 里做管道大手术）。
- declare-state busy 的 runner 契约传播（gate 裁决③：写进报告作建议,Lead 另行处理,不进本 PR）。
- 阈值放宽 / xhigh 特判（方案 C,已否）。
- RunnerIdleWatchdog / StuckDetector / gap-scan 自身逻辑（今天它们判定正确,不动）。
