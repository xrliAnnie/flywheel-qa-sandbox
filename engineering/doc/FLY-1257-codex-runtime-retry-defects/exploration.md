# FLY-1257 Codex 常驻运行时 + retry 路径四缺陷 — 探索

Issue: FLY-1257 (https://linear.app/geoforge3d/issue/FLY-1257/fix-codex-常驻运行时-retry-路径四缺陷打磨等门自杀-retry-不发带-takeover-缺-startpoint)
日期: 2026-07-14
基于: 无

## 背景

2026-07-14 Codex design 首跑 + 配额事故连环暴露 4 个运行时/生命周期缺陷,全部真机实证
(FLY-1244/1253/1238/1255 现场)。本文档是 design 阶段的问题定义:逐个缺陷做代码审计、
定位根因位点、列出修复方案选项与推荐。

四个缺陷相互成链:①让 Codex design 会话自停进 blocked → 触发 retry → ②③让 retry
再次 blocked → ④让 blocked 会话无法自救重新请求审查。断掉任何一环都能缓解,四环全修
才是根治。

## 缺陷① Codex 等门自杀(最高优先)

> **根因更正(2026-07-14,Lead Linear comment,来自 FLY-1255 runner 一手取证,
> 覆盖 issue 描述旧表述)**:「连续 3 回合」不是 FLY-1188 设的耐心上限,而是
> **Codex 平台对 update_goal(status=blocked) 的准入门槛**——同一 blocker 持续
> ≥3 个 goal turns 后平台才*允许*标 blocked。事故机理 = runner 把「允许标
> blocked」误当「应该标 blocked」主动停手,再被缺陷④(blocked 删门)放大。
> 修法相应更新:主修 = Blueprint 等门指引写死「资格≠指令、resident 持续 poll、
> 仅真实 timeout/error/reject 才 fail-close」(FLY-1255 本轮已按此行为运行,可作
> 正确行为参照);缺陷④照修;「便宜睡眠」保留为**优化项**(降低持续 poll 的回合
> 消耗),不再是止血必需。下文审计与方案已按此更正重排。

### 现场审计

- Codex runner 的 gate 形态(FLY-1188 M4):`gate <checkpoint> --no-block` 注册 +
  模型跨轮 `flywheel-comm check <id>` 轮询。注入文本在
  `packages/edge-worker/src/Blueprint.ts:1627-1636`(brainstorm)、`1684-1696`
  (review_code)、`1755-1791`(question/generic);常驻契约在
  `packages/claude-runner/agents/codex-runner-contract.md`("KEEP WORKING …
  poll for the reply across your turns")。
- goal 生命周期:`codex-daemon-goal-runtime.ts` 驱动 **codex 原生 v2 Goal API**
  (`thread/goal/set|get|clear` + `ThreadGoalUpdatedNotification`,FLY-1188
  research.md 已证实)。`GoalStatus` 枚举
  `active|paused|blocked|usageLimited|budgetLimited|complete`,其中
  `blocked` 是 TERMINAL(`codex-daemon-client.ts:36-41`)→ `runGoalToTerminal`
  返回 → adapter 结束会话。
- **「连续 3 回合」不是 Flywheel 代码里的常量**(代码与契约全文无此数字),也不是
  平台的自动裁决——它是 **Codex 平台对 update_goal(status=blocked) 的准入门槛**
  (FLY-1255 一手取证):同一 blocker 持续 ≥3 goal turns 后,平台才*允许*模型标
  blocked。真正停手的是模型自己:design 产出完成后无独立工作,每轮 `check` 得
  `pending`,凑满门槛后把「有资格标 blocked」误当「应该标 blocked」→ 主动
  update_goal(blocked)(终态)→ 会话自停。2026-07-14 三张 Codex design 全部
  这样死掉,而 Lead 批复只晚了十几分钟。FLY-1255 同日反例:runner 持续 poll 不
  宣 blocked,行为正确——证明这是可用提示词纪律约束的误判,不是平台强制。
- 顺带的浪费:等待期间每一轮轮询都是一次真实模型回合(烧 token + 烧 24h active
  budget;MED-7 waiting ceiling 只延 deadline,不省回合)——这是「便宜睡眠」
  优化项要解决的部分,不是止血必需。

### 已有可复用资产

- `isWaiting()` 谓词(`CodexTmuxAdapter.ts:605-617`):扫 gate marker 目录,未答
  marker 存在 = 正在等门。**runtime 已经知道门开着。**
- gate-deadline watcher(`CodexTmuxAdapter.ts:860-960`,FLY-159 常驻替身):已在
  周期扫 marker、处理超时(fail-open/fail-close + `gate_timed_out`)、检测 marker
  被答后清理。**已有一个周期性 marker 观察点可挂 resume 逻辑。**
- codex **原生等待原语初查**(Annie 点名的 design 第一步,research.md 详查):
  1. **原生 goal pause/resume** —— 协议面 `thread/goal/set` 的 status 枚举含
     `paused`;TUI `/goal pause` 实测真停(20s 零动作)、`/goal resume` 真续
     (FLY-1188 research.md 2026-07-11 实测,codex 0.144.1)。paused 是非终态,
     不烧回合。**最贴合「便宜睡眠」的原生原语。**
  2. **turn 内阻塞 tool call** —— TUI approval 等待即无限阻塞;shell tool call
     执行期间模型不产 token。理论上模型直接跑 BLOCKING `gate`(去 `--no-block`)
     即挂在子进程上等。但 m4d spec 当时明确「保守选择:不引入未验证的 turn 内
     blocking-gate」(V5-safe);且 daemon 重启会杀掉阻塞子进程,恢复语义要重设计。
  3. approvalPolicy elicitation —— 语义不匹配(是命令批准流,不是 Lead gate),
     且 runner 沙箱姿态固定 `approvalPolicy:"never"`,不可挪用。

### 方案(按根因更正重排)

- **主修(止血,必做)= 提示词/契约写死等门纪律 + CLI 硬闸**:Blueprint 的 codex
  等门指引(brainstorm/review/question/generic/approve_to_ship 五处
  `isCodexRunner` 分支)+
  codex-runner-contract.md 写死三条——(a) **资格≠指令**:平台允许你标 blocked
  不等于你应该标;(b) resident 持续 poll(节奏放缓),gate pending 不是 blocked;
  (c) 仅真实 timeout / error / reject 才走 fail-close。FLY-1255 本轮的正确行为即
  参照。辅以 **CLI 硬闸**:`complete --route blocked` 在存在尚未被 watcher
  解析/移除的 mandatory gate marker 时拒绝——同一条纪律从软提示变成硬约束,堵住误判的
  第二条出口。
- **优化项(可独立摘除)= 便宜睡眠(原生 pause/resume)**:降低持续 poll 的
  回合/token 消耗。模型无独立工作时 runtime 把原生 goal 置 `paused`(协议面
  `thread/goal/set`,TUI /goal pause 已实测真停),gate watcher 检测 marker
  被答/超时 → resume + kick;同时天然构成第二道保险丝(goal 翻 blocked 且
  isWaiting() 为真 → 不当终态)。不再是止血必需,排在四缺陷主修之后,风险大可
  整体摘到 follow-up。
- 已排除:turn 内阻塞 gate(m4d 已否决的未验证路径:tool-call timeout 行为未知、
  daemon 重启杀阻塞子进程后恢复语义要重做),只作对照记录。

## 缺陷② retry action 不发 three_stage TURN 带

### 现场审计

- start() 路径有 FLY-887 pre-launch TURN grant seam
  (`run-dispatcher.ts:995-1016`):`shareParentBranch && isThreeStagePhaseRole(role)
  && keepAlive` → `db.grantTurn(...)`,fail-closed(grant 失败 = dispatch 失败)。
- **`RetryDispatcher.dispatch()`(`run-dispatcher.ts:438-696`)没有这个 seam。**
  actions.ts 的 retry(`actions.ts:843-905`)对 phase row 正确传了
  `shareParentBranch: true` + `sessionRole=phaseRole`,但新 executionId 没有
  `three_stage_turn` 行 → runner `turn` 自检 `no-turn` → 拒动共享 worktree
  (正确的 fail-close)→ 再次 blocked。2026-07-14 三张 design 的 retry 全撞,
  靠 Lead 手工外科补带才通。

### 修复方向

dispatch() 镜像 start() 的同一 seam(同条件、同 fail-closed 语义、同清理路径:
inflight + pre-registration)。`CommDB.grantTurn` 本身 `ON CONFLICT … epoch+1`
就是原子转移——旧 exec 的带被自然接管,无需额外「回收」步骤。方案上没有真分叉,
plan 阶段定位点与测试即可。

## 缺陷③ retry takeover 缺 ctx.startPoint

### 现场审计

- Blueprint 三段式 worktree takeover 守卫(`Blueprint.ts:765-804`):
  `shareParentBranch && (implement|qa) && keepalive && worktree registered` →
  要求 `clean && ctx.startPoint && head === ctx.startPoint`,否则
  `worktree_takeover_failed`。守卫本意(FLY-887):不清洗掉 parked phase 的未提交
  工作。
- startPoint 的现有来源:phase-orchestrator 每次 handoff/fix/respawn dispatch 都带
  captured `headSha`(`phase-orchestrator.ts:1261/1459/1735`);FLY-795 resume 用
  branch B tip(`progress-resume.ts:13,39-40`)。
- **retry 路径完全没有 startPoint**:`RetryRequest` 无此字段,dispatch() 的 ctx 也
  不含 → takeover 恒 fail(`expected=?`)。2026-07-14 FLY-1244 撞上,靠删干净
  worktree 走 fresh clone 绕过。

### 修复方向

retry 为 phase row 恢复 startPoint。来源候选:

- **a. branch B 当前 tip(推荐)**:与 FLY-795 resume 同款(`git rev-parse
  <branch B>`)。worktree 是 branch B 的 checkout,clean + head==tip 即安全接管;
  语义正确——retry 的「预期头」就是分支现状,不存在要保护的前任未提交工作(前任已死,
  dirty 时守卫照样拒,fail-close 不变)。
- b. land-status / 上任会话记录(issue 原文提的方向):`pr_head_sha` 只在 PR 之后
  存在,design/implement 早期 retry 覆盖不到;land-status 文件同理。作为 a 的补充
  数据源不必要——branch tip 全阶段可用。

实现位点:actions.ts executeRetryAction(有 session row + phaseRole + projectName)
或 dispatch() 内部(有 runtime.projectRoot)。branch 名推导必须复用
`resolveWorktreeKey` + `WorktreeManager` 的命名(FLY-795 的 `branchName` deps 同款,
防 drift)。取不到 tip(分支不存在,如 design 首跑即死没建过分支)→ 不设 startPoint,
走 removeIfExists+create 老路径(byte-compat)。

## 缺陷④ blocked 状态吞审查门

### 现场审计

- 凶手:zombie gate hygiene Z1(`zombie-gate-hygiene.ts:88-192`,FLY-1099 §5)。
  判定:pending gate + CommDB session 行缺失 + StateStore status ∈
  `ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES`(**含 `blocked`**,
  `StateStore.ts:212-220`)→ `retireQuestionGuarded` 退门。
- 撞法:会话因①②③进了 blocked、CommDB 行已被 teardown 清掉;之后(runner 复活/
  手工驱动)新开 `gate review_code --no-block` → 在 `request-review` 绑定前,
  hygiene 扫到「blocked 会话的 pending gate」→ 退掉。FLY-1244 连撞两次,该会话从此
  永远无法重新请求审查,只能 retry 重生。
- 结构性矛盾:Z1 的设计假设是「gate 是会话生前开的、死后悬挂的遗留物」(FLY-977/980/
  1041/1049 的头排阻塞),但 blocked ≠ 没人驱动——blocked 会话之后新开的 gate 是
  **生命迹象**,不是僵尸。

### 修复方向

- **a. 时间序判定(推荐)**:gate 创建时刻晚于会话进入终态的时刻 → 非僵尸,Z1 永不
  退。数据可得:CommDB `messages.created_at`(questions 即 messages,
  `db.ts:17`);会话终态时刻 StateStore sessions `updated_at`(或以 status 变更
  event 佐证)。真僵尸(生前开的门)照退,FLY-1099 的清理能力不回退。
- b. 宽限期(gate age < N 分钟不退):实现最简,但 review 一轮可跑几十分钟,pending
  的 review_code gate 在 reviewer 答复前始终暴露,宽限期赌时长,治标。
- c. sanctioned 解 blocked:注册 review/gate 时把 blocked 会话翻回活跃态。语义最
  "正",但动 FSM/状态机波及面大(decision route、监控、founder 状态显示全联动),
  超出本 issue 的打磨定位;若 a 落地,c 可作为后续独立 issue。
- 不可行:把 blocked 移出 ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES——直接退化回
  FLY-1099 前的头排阻塞。

## 波及面与风险预判

- ①主修只动 Blueprint codex 分支文本 + `codex-runner-contract.md` +
  `flywheel-comm complete`(CLI 闸);优化项(若做)才动
  `CodexTmuxAdapter`/`codex-daemon-goal-runtime`/`codex-daemon-client`
  (claude-runner 包,Claude 路径零接触),且需真机验证原生 `thread/goal/set
  status:"paused"` RPC 行为(TUI 已实证,协议面待 probe)。
- ②③只动 retry 路径(dispatch()/actions.ts),start()/orchestrator 路径 byte-compat。
- ④只动 zombie-gate-hygiene 判定谓词,Z2 与 kill-switch 语义不变。
- 回归测试:四项各自以 2026-07-14 实战场景为 fixture(①等门>3 轮后 Lead 才答、
  ②phase retry 后 turn 自检、③registered worktree 上的 phase retry、④blocked
  会话新开 review gate 后 hygiene 扫描)。

## 结论

四项均已定位到具体代码位点,修复方向明确(含 Lead 根因更正):①主修=等门纪律
写死进提示词/契约 + CLI 硬闸,便宜睡眠(原生 pause/resume)降级为可摘除的优化项、
②镜像 FLY-887 seam、③a(branch B tip)、④a(时间序判定)。优化项需要一步协议面
probe 验证(纳入 plan 的可选里程碑)。
