# FLY-1188 Codex Runner 一等公民 — 探索

Issue: FLY-1188 (https://linear.app/geoforge3d/issue/FLY-1188/codex-runner-一等公民-独立-promptagentsmd-连续轮次-loop-可视-tui-sandbox-scope)
日期: 2026-07-11
基于: 无

## 1. 问题定义

把 Codex Runner 做成和 Claude runner 平权的一等公民。当前系统深度耦合 Claude Code:codex-tmux backend(FLY-123)能跑,但在 /eleven(FLY-1006) 真实派活中暴露五个「不是一等公民」的硬伤。本单 = 补齐这五个硬伤;A/B split 测试不在本单(归 HL PRD,本单是它的前置)。

### 现场证据(2026-07-11,/eleven QA codex runner)

- Claude QA 反复撞 Anthropic AUP 内容误报(隧道/shim/audio-injection 措辞)→ Annie 直令换 Codex 5.6-sol 跑整条 /eleven 线。
- codex-tmux QA runner 第一轮 audit 质量好,但:turn-0 跑完就 park 回 shell、Lead `flywheel-comm send` 唤不醒、cmux tab 空白、写 worktree/commit progress 被 sandbox 挡。

## 2. 现状审计(逐硬伤,带 file:line)

### 2.1 Prompt:codex 收到的是逐字 Claude 味的 blob

- Prompt 全部在 `packages/edge-worker/src/Blueprint.ts` 组装(`runInner`,~L689-1728):`systemPrompt` = agent role 文件(`## Agent Role`)+ `## Baseline Rules`(全部 `flywheel-comm` 协议块);`prompt` = 任务行。
- **仅有的 vendor 特化**:① 三个 gate 块按 `ctx.vendor === "codex"` 换成 `--no-block` + 「END YOUR TURN,会被自动 resume」措辞(Blueprint.ts:1440/1534/1553);② adapter 层 PONYTAIL_RULESET 顶替 ponytail 插件(CodexTmuxAdapter.ts:414)。
- **其余全部原样送给 codex**,包括大量 Claude-only 内容:generic-executor.md 的 Superpowers RPC flow(`Skill` 工具驱动)、qa-executor.md 的 Claude-in-Chrome、`SendMessage` 禁令、`/compact`、`/codex-code-review` slash command 措辞(Blueprint.ts:1378/1045/1481 等)。
- 交付方式:Claude 走 `--append-system-prompt-file` + positional prompt(TmuxAdapter.ts:717-775);codex 把 systemPrompt 折进任务文本,一整个 blob 走 stdin 进 `codex exec -`(CodexTmuxAdapter.ts:407-421 + codex-resume.ts:235/279)。
- **运行时零 AGENTS.md**:grep 全仓,没有任何代码为 runner 生成/注入 AGENTS.md。FLY-123 plan §5.5 当年就把 AGENTS.md 标为「codex 的 system-prompt 注入面」,但只落了「动态层走 stdin」这一半;CodexTmuxAdapter.ts:408 的注释「AGENTS.md handles the persistent layer」是期票,没有兑现。
- 已知补充事实(Spike-δ 实测):codex 读**三层**指令 — `$CODEX_HOME/AGENTS.md`(每进程必读)+ repo 目录树 AGENTS.md + exec 动态 prompt。每个 codex runner 已有隔离的 per-runner `$CODEX_HOME`(FLY-123 WS-A,codex-home.ts)——**天然的、零仓库污染的持久注入点,现在空着**。

### 2.2 连续轮次:turn-0 park 的三重根因

codex-tmux 的执行模型是「进程边界 = gate」(Spike-δ/FLY-123):pane 是长命 bare shell,每个 cycle 注入 `node flywheel-comm codex-resume --state <f>` → `codex exec (resume)` 跑完退出 → done-marker → adapter 分类。

1. **终态误判**:cycle 退出 + 无 gate marker → `break; // terminal success`(CodexTmuxAdapter.ts:460-466)。codex 中途收工「汇报一下」也被判定为全单完成,execute() 返回,从此无人监听。
2. **send 路由错箱**:`flywheel-comm send` 调 `wakeRunnerMailbox` 时**不带 backend**(send.ts:58-64)→ `AgentTeamTransportFactory.fromEnv()` 落到 claude-code mailbox,codex 的 `CodexMailboxWatcher` 读的是 `~/.flywheel/codex-teams/...`,永远收不到。对照:gate/ask 的 `respond` 路径是 marker-aware 的,带 `backend: marker.vendor`(respond.ts:186/251,runner-wake.ts:151-172)——所以 gate 应答能唤醒,普通指令不能。
3. **循环只认 gate 应答**:即使消息进对箱,awaiting_gate 等待环只把 wake 当「再查一次 CommDB 有没有 answered gate」的提示(CodexTmuxAdapter.ts:485-491),普通消息内容永远不会变成下一 cycle 的 prompt。
- Claude 侧的对照物:① claude TUI 进程长驻,mailbox poller 常收;② FLY-818 `/loop` 目标契约自续跑 — `CLAUDE_LOOP_ADAPTERS = {"claude-tmux"}`(autocontinue-goal.ts:48),注释原文「codex has its own /goal (out of v1 scope)」——当年显式划走,本单接住。
- FLY-512 研究给了官方参照:Codex `/goal` 的续跑纪律 = 事件驱动(只在 thread idle 安全边界续)+ 防空转(一轮零 tool-call 就抑制下一次)+ 证据驱动完成 + 预算≠完成。

### 2.3 可视 TUI:pane 只有 shell 提示符

- pane 进程是 bare shell;codex 的 stdout(`--json` JSONL)全量进文件,stderr inherit 到 pane 但 exec 模式下几乎无内容 → Annie 打开 cmux tab 看到空 shell。
- Lead 侧已有完整的 windowed TUI 机制(FLY-259/FLY-398):共享 `codex remote-control` daemon + sidecar 走 WS 驱动 thread + founder 的 `codex resume --remote` pane 是同一 thread 的人类观察/驾驶端(codex-lead-tui-runtime.ts)。
- Spike-δ 当年否掉的是「往活 TUI pane send-keys 灌文本」(Option B,注入危险);remote-control(WS 驱动,TUI 只是观察端)不在被否范围内,但代价链完全不同(见 §3.3)。
- CLAUDE.md 硬规则(FLY-398):production Codex lead/runner 必须 windowed、founder 能在 cmux 看到 — 本单 scope 3 的原话是「实时看到 codex 在干活」(see);是否必须 drive 是要跟 Lead 确认的解释边界。

### 2.4 Sandbox scope:worktree 写入被挡

- fresh cycle:`codex exec --json -o <last> -C <ctx.cwd> -s workspace-write -c sandbox_workspace_write.writable_roots=[~/.flywheel, gateMarkerDir, commDb dir] -c network_access=true`(codex-resume.ts:165-194;roots 来自 CodexTmuxAdapter.ts:646-653)。resume cycle 无 -C/-s,沙箱参数从 session 继承 → **一切必须在 fresh cycle 定对**。
- writable_roots **不含 worktree 自身也不含主仓 .git**。两个真实受害路径:① 若 spawn 时 cwd 落在主仓而 worktree 是 sibling(/eleven 现场证据「-C .../flywheel」),worktree 完全不可写;② 即使 -C=worktree(workspace-write 默认 cwd 可写),`git commit`(progress ledger!)要写主仓 `.git/worktrees/<name>/` 与 `.git/objects` —— 在 cwd 之外,被 Seatbelt 挡。
- 参照:FLY-245/FLY-350 的 Lead 侧已有成熟 writableRoots 管理(workspace-write + 窄 writableRoot + cwd pin);FLY-793 教训:worktree 路径必须 canonicalize(macOS symlink)。

### 2.5 作者感知的审查路由(reviewer inversion)

不变量 = **审查者永远来自跟作者不同的 agent 家族**。现状是单向:Claude 写 → Codex 审(design/code);Codex 写 → 还是 Codex 审(自己审自己,违反不变量)。

- Bridge 触发:`event-route.ts:1699-1702` 在 stage=design_review/pr_created 时 `handleCodexAutoTrigger` — reviewer **无条件 Codex**,无任何选择逻辑;指令文本硬编码 `Run: /codex-design-review <plan>` / `/codex-code-review`(codex-instruction.ts:36-73),证据文件 `.flywheel/runs/<execId>/codex/{design-review,code-review}.json`,runner 用 `await-codex-gate` 阻塞等结果;code review 另有 FLY-827 硬 merge 门(codex-gate.ts)。
- **更深的一层坑**:`/codex-*-review` 是 **Claude Code slash command**(`~/.claude/commands/codex-*-review.md`,仓外全局文件,驱动 codex-companion.mjs)——它假定 runner 是 Claude Code 进程。**codex 作者今天连这条指令都执行不了**(codex 没有 Skill/slash 机制),即 codex 作者的 review 车道不只是「审错家族」,是整条不存在。
- 作者家族数据已存在:StateStore sessions 表有 `adapter_type` 列(FLY-493,event-route.ts:646/677/706 持久化),但 review 路由从不读它 — 「认作者」有现成单一真相,只差消费。
- Claude 侧没有打包的 reviewer:最接近的既有形态是 `claude -p` headless 判定器(approval-signal/subscription-claude-classifier-runner.ts:6,`claude -p <prompt> --model <m> --output-format json` via execFile)——「spawn 一个 headless Claude 出 verdict」的骨架已有;`claude -p --resume <sessionId>` 与 codex `exec/resume` 一一对应,可做持久多轮。
- **执行位形约束(设计关键)**:codex runner 跑在 Seatbelt 沙箱里,keychain 被挡(FLY-209 已记)。若让 codex runner 在自己沙箱内起 `claude -p`,Claude CLI 的 auth(keychain/OAuth)大概率不可用 → Claude reviewer 必须在**沙箱外**执行。这把设计推向「Bridge 驱动 reviewer 进程」或「凭据显式注入」两条路(见 §3.5)。

## 3. 方案选项

### 3.1 独立 prompt / AGENTS.md(scope 1)

| 选项 | 做法 | 优 | 劣 |
|---|---|---|---|
| **P-A(推荐): per-runner `$CODEX_HOME/AGENTS.md` 承载 codex 味行为契约** | 新建 flywheel-shipped `agents/codex/runner-contract.md`(codex 口味翻译:三段式纪律/founder-gate/comm 协议/report-back/TDD,全部以「你是 codex exec 进程、gate 用 --no-block、退出即暂停」的世界观改写);provisionCodexHome 时物化到 `$CODEX_HOME/AGENTS.md`;Blueprint 动态层(issue/任务/role 特定内容)照旧走 stdin,但按 vendor 剥掉 Claude-only 块 | codex 原生读、每 cycle 生效;零仓库污染(不碰 worktree/repo 的 AGENTS.md);per-runner home 已隔离;持久层/动态层分离与 FLY-123 §5.5 原设计一致 | Blueprint 需要 vendor-aware 的块级组装(改动面中等);两份行为契约文本要防漂移(单一来源生成或 CI 对照) |
| P-B: 只做 Blueprint vendor 分支,不落 AGENTS.md | 每个 Claude-only 块加 codex 变体 | 改动集中 | 违背 issue 明说的「AGENTS.md 形态,Codex 原生读」;所有内容仍挤在 stdin 动态层 |
| P-C: 写 worktree 根 AGENTS.md | codex 目录树原生读 | 简单 | 污染 worktree(必须 .git/info/exclude,commit 泄漏风险);与项目自带 AGENTS.md 冲突(FLY-123 已警告过 joycon 张力) |

Role 文件(generic-executor/qa-executor/项目 executor)**不做**每 vendor 重写(不可扩展):动态层注入时对 codex 附一段固定「环境翻译头」(Skill/Superpowers→照 shape 手动做、SendMessage 禁令→本来就没有、Claude-in-Chrome→按任务改用可用工具或上报缺口),其余照读。

### 3.2 连续轮次 loop(scope 2)

三个正交修复,一起构成「等价于 Claude 常驻 + /loop」:

- **L1 终态重定义(adapter)**:cycle 退出后的分类从「无 marker=成功终态」改为:①有未答 gate marker → awaiting_gate(现状);②有**完成证据**(`flywheel-comm complete` 已跑 — 新增本地 completion sentinel,complete.ts 成功/fail-close 时都写,adapter 可观察)→ 真终态;③两者皆无 → **parked-idle**:窗口与 watcher 保活,等 Lead 消息或 auto-continue,有 idle 上限(默认沿用 waitingTimeoutMs,超时按 fail-close 收尾)。
- **L2 send 修箱(comm)**:`send` 按目标 runner 的 backend 路由 mailbox(从 CommDB session/StateStore 的 adapter_type 或 spawn 注册信息解析,传 `backend` 给 wakeRunnerMailbox);parked-idle 的 adapter 收到普通消息 → 以消息原文为 prompt 起 resume cycle(消息无权威,只是输入 — 与现 wake=hint 原则一致)。
- **L3 auto-continue(FLY-818 泛化)**:复用 autocontinue-goal 的目标契约文件(已是确定性 builder);codex 的 arming 不走 send-keys `/loop`,由 adapter 在 parked-idle 且 armed 时自动注入续跑 cycle(prompt=「重读 <goal 文件> 继续;完成必须以证据 + flywheel-comm complete 收尾」)。防空转按 FLY-512:连续 N 轮(建议 2)无实质进展(无新 tool-call/diff 证据)→ 停止续跑并上报 Lead;`CLAUDE_LOOP_ADAPTERS` 语义改为 per-adapter arming 策略表。

### 3.3 可视 TUI(scope 3)

| 选项 | 做法 | 优 | 劣 |
|---|---|---|---|
| **T-1(推荐 v1): pane 内 JSONL 实时渲染** | codex-resume 把 codex stdout JSONL 边写文件边解析,向 pane(自身 stdout)渲染人话进度流(当前命令/改动文件/agent 消息/token 心跳),cycle 边界打横幅 | 保留全部既有模型(进程边界 gate、codex-with-fallback 进程级轮换、per-runner home、注入安全);改动只在 codex-resume 一处;Annie 打开 tab 即见「在干活」 | 不是真 codex TUI;founder 只能看不能打字(打字本来就该走 Discord/Lead) |
| T-2: 复用 Lead 的 remote-control daemon + `codex resume --remote` pane | runner 线程由 WS sidecar 驱动,pane 挂真 TUI | 真 TUI、可打字 | 与 runner 模型冲突大:daemon 按 CODEX_HOME 起,per-runner 隔离 home ⇒ 每 runner 一个 daemon;丢进程级 429 轮换(FLY-123 已记这是 exec 形态的核心优势);adapter 全量重写;standalone codex 硬依赖 |
| T-3: pane 直接跑 codex TUI + send-keys 驱动 | — | — | Spike-δ 实证否决(注入危险) |

T-2 记为 future(若将来 runner 也要「founder 可驾驶」再立单);v1 用 T-1 满足「cmux 里实时看到在干活」。

### 3.4 Sandbox scope(scope 4)

单选方案(无真正竞争选项):fresh cycle 的 state 构造时 —
1. `-C` 强制 = runner worktree 的 **canonicalize(realpath)** 路径(FLY-793 教训);spawn 侧防御:cwd 不是该 execution 的 worktree 时 fail-loud。
2. `writableRoots` 增补:`realpath(worktree)`(显式,防 -C 与 root 解析不一致)+ `git rev-parse --git-common-dir` 的主仓 `.git`(worktree 的 commit/index/lock 全在这)。保持最小面:不给整个主仓工作区,只给 `.git`。
3. 维持 network_access=true 与既有 flywheel roots;沙箱参数只在 fresh cycle 生效(resume 继承)的既有事实写进合同测试。

### 3.5 作者感知审查路由(scope 5)

- **认作者**:`handleCodexAutoTrigger` 处读本 session 的 `adapter_type`(已持久化,单一真相)→ 选异家族 reviewer:claude 作者→codex reviewer(现状路径逐字不动,byte-compat);codex 作者→claude reviewer(新车道)。
- **Claude reviewer 执行位形**(codex 作者沙箱内起不了 `claude -p`,见 §2.5):

| 选项 | 做法 | 优 | 劣 |
|---|---|---|---|
| **R-A(推荐): Bridge 驱动 reviewer** | runner 到 review 点跑 `flywheel-comm request-review`(或复用 stage 事件);Bridge(非沙箱、有完整 auth)spawn headless Claude reviewer(`claude -p` R1 fresh + `--resume` 多轮),写 verdict 文件;runner 用 `await-review-gate`(await-codex-gate 的家族中立化)阻塞等结果 → 改 → 再请审 | 绕开沙箱 auth 问题;reviewer 进程与作者进程物理隔离(独立性更硬);Bridge 已有 spawn `claude -p` 先例(approval classifier);round 天然可跟踪 | Bridge 多一类长任务子进程(review xhigh 可达分钟级,需超时/并发管控);review 失败路径要走事件上报 |
| R-B: runner 沙箱内直跑 claude CLI | 凭据以 `CLAUDE_CODE_OAUTH_TOKEN`/API key 形态经 config.toml env 注入(GH_TOKEN 同款管道) | 保持 runner-driven 现状形态 | 给沙箱进程再塞一个高权 token(面扩大);Anthropic token 有效期/形态待验;keychain 之外的 auth 路径需 spike 实证 |
| R-C: reviewer 也做成 runner(spawn 一个 Claude review runner) | 复用 spawn 链 | 概念统一 | 重:一次 review 一个完整 runner 生命周期;与现有「同 session 内 fix loop」交互模型冲突 |

- **verdict 证据**:家族中立路径 `.flywheel/runs/<execId>/review/{design,code}-review.json`(含 reviewer_family + reviewedHeadSha);legacy `codex/*.json` 读取兼容保留。
- **服务器侧不变量**:FLY-827 硬 merge 门升级为「异家族 review 证据」校验 — 校验 verdict 存在 + `reviewer_family ≠ author_family(adapter_type)`,缺失/同家族 fail-close;kill-switch 语义(FLYWHEEL_CODEX_HARD_GATE)保留。
- 已知风险:Claude reviewer 审 /eleven 这类内容也可能撞 AUP(审查比创作更不易触发,但非零)→ 失败路径显式:AUP 拒 → 上报 Lead 人工裁量,不静默降级回同家族。

## 4. 待 Lead 确认的假设/决策点

1. **TUI 取 T-1(渲染器)不取 T-2(真 TUI)**:满足「看得见在干活」;「founder 可驾驶」不在本单。FLY-398 硬规则按其本意(禁 headless 不可见形态)解读。
2. **AGENTS.md 落 per-runner `$CODEX_HOME/AGENTS.md`**(P-A),不写 worktree/repo。
3. **loop 终态语义**:完成证据 = `flywheel-comm complete` sentinel;无证据不终态(parked-idle + idle 上限)。auto-continue 默认 arming 范围沿用 FLY-818 现有 flag/phase 策略,仅把 codex-tmux 纳入。
4. **role 文件不做 per-vendor 重写**,用「环境翻译头」;codex 味行为契约单独成文(runner-contract.md → AGENTS.md)。
5. **Claude reviewer 走 R-A(Bridge 驱动)**:codex 沙箱内起不了 claude auth;Bridge 已有 headless claude -p 先例。R-B(token 注入)记为备选,需 spike。
6. 本单交付为多 PR(scope 1-4 是 runner 执行链,scope 5 是 review 链,可拆),顺序 plan 阶段定。
