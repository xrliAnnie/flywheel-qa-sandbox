# FLY-921 三段式流水线:QA 相位抢先跑 + turn-belt 死 holder 不释放锁 — 探索

Issue: FLY-921 (https://linear.app/geoforge3d/issue/FLY-921/bugpipeline-三段式流水线qa-相位抢先跑-turn-belt-死-holder-不释放锁-qa-边角覆盖补强)
日期: 2026-07-06
基于: 无

## 1. 问题陈述

FLY-543(2026-07-06)真机运行暴露三段式流水线(FLY-887 保活机制)两个缺陷 + 一个覆盖缺口:

1. **QA 相位抢先跑**:design complete 后,implement(a1390641) 20:40 UTC 起,QA(b6888f1e) 20:42 UTC 就被拉起、抢到 worktree 轮次(epoch=3)、真跑了并 commit 了 `qa(FLY-543): BLOCKED — implement phase delivered zero code`。
2. **turn-belt 死 holder 不释放**:Lead kill 了 QA holder 进程后,`flywheel-comm turn` 仍返回 `not-yours holder=b6888f1e epoch=3`,design 段永远拿不回轮次,最终 operator 手动 UPDATE DB(现 epoch=4)才解开。
3. **QA 覆盖缺口**:FLY-887 只测了保活 happy-path,没测相位竞争 / founder 中途改 scope 撞自动推进 / kill-holder 后轮次恢复。

Issue 里列的候选(「turn-belt 相位排序」「design complete 后同时拉起 implement+QA」)是症状侧猜测。本探索按 Lead 要求**先从 logs + 代码定位精确根因**,结论与候选不同。

## 2. 现场证据链(logs + DB + tmux pane 三方互证)

时间均为 UTC(本机 local = UTC-7)。证据源:
- Bridge log `/tmp/flywheel-bridge.log`(行号 1330505–1332390 窗口)
- StateStore `~/.flywheel/teamlead.db` sessions 表
- CommDB `~/.flywheel/comm/flywheel/comm.db` three_stage_turn 表
- 死 tmux pane `cmux-FLY-543-…:22`(implement 段遗骸,pane 内容完整保留)
- Claude 会话转录 `~/.claude/projects/-Users-xiaorongli-Dev-flywheel-FLY-543/`
- FLY-543 worktree git log

### 2.1 时间线

| 时刻 (UTC) | 事件 | 证据 |
|---|---|---|
| 20:40:02 | design 段 `phase_design_complete`,head `07f75a39` | log: `design → implement handoff on FLY-543 @ 07f75a39 (exec a1390641)` |
| 20:40:04 | implement(a1390641) 启动,TURN epoch=2 | log session_started |
| 20:41:23 | implement 提交 progress ledger `chore(progress): FLY-543 implement 0/12`(= commit `852e7de7`),nextStep 写明「Phase 0 spikes (S0.1 claude -p zero-tools/resume, S0.2 mic)」 | sessions.summary 里的 ledger diff + git log |
| 20:42:05 | implement 按 plan 跑 S0.1 spike:**嵌套 `claude -p` 会话 `85f2c9ce` 启动** | 转录文件首行 timestamp `2026-07-06T20:42:05.809Z` |
| ~20:42:30 | 嵌套会话结束 → SessionEnd hook 用**父 runner 的 callback token** POST `/hook/complete` → Bridge 判 a1390641「完成」 | sessions.last_activity_at=20:42:32;下一行 |
| 20:42:32 | DecisionLayer 合成路由:`decision_route=needs_review`,`decision_reasoning=Default fallback — LLM unavailable. Error: No ANTHROPIC_API_KEY`;status → awaiting_review | teamlead.db sessions 行(pr_number、review_question_id 均为空) |
| 20:42:3x | awaiting_review 命中 implement→QA handoff 边界 → **QA(b6888f1e) 被拉起,TURN epoch=3 给 QA** | log: `implement → qa handoff on FLY-543 @ 852e7de7 (exec b6888f1e)`;紧随 `FLY-827 review-held: suppressing review-required delivery for a1390641` |
| 20:42–20:49 | **双写手**:implement 其实还活着,继续在同一 worktree 写 voice-core 代码(FakeChild/config.test.ts/registry.test.ts…,pane 可见 /loop 自续);QA 同时评估同一 worktree | 死 pane 22 内容 + QA BLOCKED commit `cef2f161` |
| 20:48:11 | 一个 session_completed「blocked — Lead escalates」事件 | log EventFilter |
| 20:49:40 | implement pane 被 **signal kill**(Lead 回收) | pane 尾行 `Pane is dead (signal kill, Mon Jul 6 13:49:40 2026)` |
| 20:49:47 | QA 段退出 → 同一条 fallback 链再走一遍 → 又一个合成 needs_review → **给 founder 发了假「PR ready for review」通知** | log EventFilter `PR ready for review`;QA 行 decision_reasoning 同为 Default fallback |
| 之后 | TURN 卡死:holder=b6888f1e(已死) epoch=3;design 段 `turn` 永远 not-yours;operator 手动 UPDATE → 现 epoch=4 holder=design | comm.db three_stage_turn 现值 + Lead 确认(543 是他手改的) |

### 2.2 三方互证的关键点

- **implement 没有「完成」也没有「死」**:Bridge 在 20:42:32 判它完成,但 pane 证明它活到 20:49:40 被 kill,期间一直写代码。
- **完成事件不是 runner 驱动的**:真 runner 驱动的 `complete --route needs_review` 按协议带 `--question-id`(FLY-191/FLY-208),落库为 review_question_id(注意:源码层面 complete.ts 对 needs_review 并不强制 `--pr`,`pr_number` 在合法路径下也可能为空 —— Codex design R1 核实);a1390641 的 review_question_id 为空,decision_reasoning 是 FallbackHeuristic 的模板句 —— 铁证为合成。
- **嵌套会话时间完全吻合**:85f2c9ce 起 20:42:05、`claude -p` 秒级跑完,SessionEnd ≈ 20:42:30 = Bridge 误判完成时刻。其后 20:43:47、20:44:37 还有两个嵌套会话(S0.2 等),但 wait 已 settle,无二次伤害。

## 3. 根因(与 issue 候选的差异)

### 根因① QA 抢跑 = 「父会话完成误判」五连锁,不是相位排序 bug

1. **传输层身份混淆**:`scripts/hooks/flywheel-session-end.sh` 的 SessionEnd hook 依赖环境变量 `FLYWHEEL_CALLBACK_PORT/TOKEN`;runner 内部按 plan 跑嵌套 `claude -p` 时,子进程**继承同一套 env**,子会话结束即用父 token 回调。
2. **回调服务只认 token**:`HookCallbackServer.waitForEvent` 只匹配 `token + eventType`,不校验 `event.sessionId`;而 `TmuxAdapter.waitForCompletion` 明知自己启动的 `claudeSessionId` 却未用它过滤 → 假完成 settle。
3. **DecisionLayer 在本机永久降级**:订阅制部署没有 ANTHROPIC_API_KEY,Haiku triage **每次**都失败 → 走 `FallbackHeuristic`。
4. **progress ledger 骗过零 commit 护栏**:FallbackHeuristic Rule 1(commitCount=0 → blocked)本可拦住,但 FLY-795 的 ledger 自动 commit(`chore(progress): implement 0/12`)使 commitCount=1 → 落到 Rule 4 默认 `needs_review`。
5. **合成路由被当成相位推进证据**:`PhaseOrchestrator.onPhaseComplete` 只看 `status === "awaiting_review"`(HANDOFF_STATUS 边界),不区分「runner 真实走完 APPROVE GATE」和「进程侧合成」→ 拉起 QA、TURN 交给 QA,与还活着的 implement 形成同 worktree 双写手 —— TURN 机制要防的事,被推进机制自己造成了。

推论:在本部署形态下,**任何** implement 段的「非 runner 驱动完成」(嵌套会话误判、进程早死、被 kill)都会确定性地立刻拉起 QA。design 段边界(design_done)不受此影响 —— DecisionLayer 合成不出 `phase_design_complete` 路由,只有 runner 显式 complete 能产生 design_done。

### 根因② turn-belt 无 stale-holder 恢复路径

`three_stage_turn` 的写入口全景(代码审计):
- `grantTurn`:dispatcher pre-launch seam(`run-dispatcher.ts:720`,spawn 路径)+ PhaseOrchestrator 两处 wake 前(fix wake / retest wake)。
- `deleteTurn`:**只有** `post-ship-finalization.ts:241`(ship 后清理)。

即:holder 进程死亡(kill / crash)后,没有任何 liveness 检测、没有 reconcile、没有操作命令;`turn` CLI 是只读的。TURN 永远指向死 exec,唯一解法是手改 DB。FLY-863 的 `reconcileStuckCodexHolds` 已为「卡死持有物的安全回收」立了先例(阈值 + 单次告警 + 安全恢复),turn-belt 缺同类机制。

### 附带发现(不阻塞,已向 Lead 报告)

- **假「PR ready for review」founder 通知**:kill QA 触发同一条 fallback 合成链 → session_completed(needs_review) → founder 侧看到根本不存在的 PR ready。修根因①即消除。
- **GatePoller orphan 刷屏**:QA runner 的 gate question 把自己 exec-id 打错一位(`…254ec025` vs 真 `…258ec025`)→ orphan question 每 tick 重复告警、无限刷。Lead 已拍板:**单开 follow-up issue,不进本 PR**。
- FLY-543 worktree 根目录有个名为 `=` 的杂物文件(runner shell 笔误产物,无害)。

## 4. 修复方向(与 Lead brainstorm gate 达成一致,2026-07-06)

| # | 层 | 内容 |
|---|---|---|
| Fix A | 传输层(根治①的入口) | `TmuxAdapter`/`HookCallbackServer`:completion callback 必须校验 `event.sessionId === claudeSessionId`,不匹配则记 warn 并**继续等待**(pane_dead poller 兜底真实退出) |
| Fix B | 相位推进护栏(①的纵深) | implement→QA handoff 只认 runner 驱动的完成证据:`review_question_id` 在场且非 UNBOUND 哨兵(初稿曾并要求 pr_number,Codex design R1 核实该字段在合法 needs_review 下也可能不落库,已移除 —— 见 research §2.2);合成的 awaiting_review 一律 fail-closed 告警 Lead、**不**拉起 QA(keep-alive ON/OFF 两条路径都盖) |
| Fix C | turn-belt 恢复(根治②) | 参照 FLY-863 reconcile 先例:holder 会话终态或进程探测 dead(`dead_pin`/`absent`;`indeterminate` fail-closed 不动)→ 安全重授给最近的 parked-alive 相位;启动时 reconcile 全表扫 + 事件驱动位点;全程 Bridge 单写者不变;每次恢复告警 Lead 一次 |
| Fix D | 防御纵深 | `FallbackHeuristic` Rule 1 不把 `chore(progress):` ledger commit 计入 commitCount(纯 ledger = 零工作 → blocked,不再落到默认 needs_review) |
| ③ QA 补强 | 对抗/边角测试 | 嵌套 callback 不 settle / implement 早死不拉 QA / kill-holder 轮次恢复 / founder 中途改 scope 撞自动推进 / 合成完成不推相位(详见 plan) |

## 5. 范围边界

- **不动 FLY-918** 的 release 结构(opt-in 并存 / kill-switch / 隔离验证)—— 本 issue 是流水线内部机制修复,相关但独立。
- 不改 runner 协议文本(Blueprint prompt)的既有 APPROVE GATE 流程 —— Fix B 依赖的证据字段(`--question-id` → review_question_id)本来就是协议要求;运行时判别子**不含** pr_number(complete.ts 对 needs_review 不强制 --pr,见 research §2.2)。
- GatePoller orphan 刷屏、`=` 杂物文件:不进本 PR(Lead 开 follow-up)。
- 非三段式(单会话)流水线行为字节兼容:Fix A/D 对单会话同样生效但语义只会更保守(误判完成变少、纯 ledger 退出从 needs_review 变 blocked)—— 在 research 中论证这是 bug fix 而非行为回归。

## 6. 已确认的决策(brainstorm gate 记录)

- Lead 确认根因链与四个 fix 方向「全 sound、照做」;判别子思路获认可(gate 时表述为 review_question_id + pr_number,后经 Codex design R1 源码核实收敛为**仅 review_question_id**,pr_number 在合法 needs_review 下也可能不落库)。
- FLY-543 现网 TURN 是 Lead 手改的 epoch=4 —— 与根因②推断一致。
- 流程:标准三段式,design 三件套 → Codex design review → implement(TDD)→ code review → 独立 QA。
