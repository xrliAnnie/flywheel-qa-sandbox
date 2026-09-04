# FLY-2148 runner 记忆落地:写入时机 · 收口回执 · 分流归因 — 探索
Issue: FLY-2148 (https://linear.app/geoforge3d/issue/FLY-2148/2132b1-runner-记忆落地角色项目目录-短索引送达-写入时机与截断防护)
日期: 2026-09-04
基于: 无(上游 = product/doc/FLY-1984-codex-home-identity/epic-prd.md §B;前置 = engineering/doc/FLY-2147-runner-role-memory/ 的 plan.md 与 design-correction.md,PR #1056 已于 2026-09-04 03:29 合入 main)

> 本文只回答三件事:B0 之后到底还缺什么(实测)、B1 要做成什么样、有哪几条路及推荐哪条。
> 怎么改哪几行、测什么,在 plan.md。

---

## 1. 问题(issue 三条要求 × B0 已做 / 未做)

issue 写的三件事,逐条对照 B0(FLY-2147,PR #1056)实际落地的代码:

| issue 要求 | B0 已做(代码在本分支) | B0 没做 ⇒ B1 要做 |
|---|---|---|
| ① (角色+项目)记忆目录的读写机制:短索引自动送达,正文按需翻,照 Lead 侧形状 | **已做**:`packages/edge-worker/src/runner-memory.ts` 在 spawn 时算出 `~/.flywheel/runner-memory/<project>/<role>/`,经 `--settings {autoMemoryDirectory, autoMemoryEnabled:true}` 让 Claude Code 原生装载 `MEMORY.md`(前 200 行 / 25KB)、正文按需读;Codex runner 得到 `FLYWHEEL_RUNNER_MEMORY_DIR` env + 手工指针段 | **默认没开**:B0 设计修正把它挂在四态 flag `runner_memory_mode`(`off|split|role|shared`),默认 `off`,`off` 与合入前 spawn **逐字节相同**。本 runner 自己的环境里就没有 `FLYWHEEL_RUNNER_MEMORY_DIR`(`env \| grep` 为空,exit 1),生产 Bridge(buildSha 31da178)也还在 B0 合入之前的构建上 |
| ② 写入时机:她倾向一 issue 写一次,留给我判断 | **只给了一句建议**:prompt 里 `Prefer writing at the end of your work, at most ~5 …`;plan §5 Q4 明写「引擎不做写入回执」 | **没有时机合同、没有回执**:没有任何地方知道「这次执行到底写没写」。Claude 原生 auto memory 的官方描述是「Claude doesn't save something every session. It decides what's worth remembering」——靠它自觉,不能满足「第二次跑读得到第一次写的」 |
| ③ 截断防护:索引注入有界 + 超界可见 | **已做(读侧)**:spawn 前有界读(≤64KB)、软预算 160L/20KB、硬上限 200L/25KB、超限时日志 + prompt 两面说明从第 K 行起不装载 | **写侧只有 Claude 有**:官方文档「After Claude writes to MEMORY.md, Claude Code measures the file … If over a limit, the write still succeeds, but Claude Code returns an error telling Claude to rewrite the index」——这是 Claude Code 自己的;**Codex runner 手写索引没有任何写侧守卫**,写超了要到下一个 runner 起来才被发现 |

另外一条 B0 留下、B1 必须补的缺口(不在 issue 三条里,但是 flag 退役条件的数据来源):

| 缺口 | 证据 |
|---|---|
| **分流臂只打日志、不入库**。`Blueprint.ts:2713` 打 `[Blueprint] runner-memory selection mode=… arm=… issue=…`,但 `sessions` 表没有任何 `runner_memory_*` 列(`grep runnerMemory packages/teamlead/src` 只命中 flag-store 两个文件) | flag 注册表 `retireWhen`:「founder selects role or shared as the permanent memory behavior」——founder 要对比两臂,而今天没有任何一张表能回答「这个 session 跑在哪一臂、写没写记忆」。FLY-2147 的 QA 也把它列为「发现 A」(`~/.flywheel/artifacts/fly2147/README.md`),只留了一个读 bridge.log 的探针 |

⇒ **B1 的真实范围 = 写入时机合同 + 收口回执 + 分流归因入库 + Codex 写侧截断守卫 + 在 role 臂下跑通 PRD 四条验收。** ①的机制本身不重做。

## 2. 现状(2026-09-04 本机实测 + 读代码,不是读文档)

### 2.1 B0 在本分支上的形状(已合入)

```
Blueprint.runInner
  ├─ runnerMemoryMode()  ← flag store(FLYWHEEL_RUNNER_MEMORY_MODE,默认 off)
  ├─ resolveRunnerMemorySelection({mode, issueIdentifier}) → off | role | shared   (split = sha256(issueId)[0] % 2)
  ├─ arm==="role" ⇒ prepareRunnerMemoryMount(...) → mounted | skipped | failed     (policy 探测 → 身份 → 根 → mkdir → 首跑写 3 行头 → 有界量索引)
  ├─ console.info/warn(formatRunnerMemoryLogLine)                                   ← 唯一的落痕
  ├─ prompt 插 `## Runner Memory` 段(Agent Role 与 Baseline Rules 之间)
  └─ adapter.execute({ runnerMemory: mounted{dir} | disabled{reason} | undefined })
        ├─ TmuxAdapter: --settings {autoMemoryDirectory, autoMemoryEnabled:true} + pane env FLYWHEEL_RUNNER_MEMORY_DIR
        └─ CodexTmuxAdapter: env.FLYWHEEL_RUNNER_MEMORY_DIR
```

- `emitStarted`(session_started,DirectEventSink 落 `sessions` 行)在 **worktree 创建之前**就发出(`Blueprint.ts:1006`,DirectEventSink 注释「emitStarted runs fire-and-forget BEFORE the worktree」);记忆挂载在 `:2703`,晚于它 ⇒ 臂/目录**赶不上** session_started 的 Bridge-trusted 字段(`skill_framework_mode` 就是走这条路入库的)。
- 记忆目录里 runner 真写过的实物(FLY-2147 QA 在沙箱 slot 留下的,`~/.flywheel/runner-memory/test-slot-3/generic/`):`MEMORY.md` 5 条指针 + 5 个 topic 文件,frontmatter `name/description/metadata.type`——**与 Lead 侧 `~/.claude/agent-memory/<lead>/` 同形**。①的「照 Lead 侧形状」已经成立,不需要再造词表。

### 2.2 收口链路(runner 怎么说「我做完了」)

| 节点 | 终结命令(runner 自己跑,在 runner 的 pane env 里) | Bridge 落库处 |
|---|---|---|
| eng_design | `flywheel-comm complete --route phase_design_complete` | `event-route.ts` session_completed → `patchCompletionEvidence()`(`:1950-1970`,写 summary / diff_summary / commit_* 等) |
| implement | `complete --route needs_review --pr N`(之后 park) | 同上 |
| qa | `qa-result --status pass\|fail --summary …`(之后 park 或再走 complete) | `workflow-decision-routes.ts`(DAG 决策通道,不经 /events) |
| 任何节点硬失败 | `complete --route blocked` | 同上(session_completed) |

`complete.ts` 与 `qa-result.ts` 都在 runner 进程里跑,天然拿得到 `FLYWHEEL_RUNNER_MEMORY_DIR`;都是「先本地收集证据 → 组 payload → 带重试 POST」的形状,证据(`evidence.diffSummary` 等)本来就是 runner 侧自报、Bridge 当数据存。**把「记忆收口回执」放进同一个 payload 是零新通道。**

### 2.3 写入这件事今天靠什么

- Claude runner:Claude Code 原生 auto memory——模型在会话中自己决定何时写(官方:「Claude reads and writes memory files during your session」「doesn't save something every session」)。B0 的 prompt 只多了一句「Prefer writing at the end」。
- Codex runner:B0 prompt 说「read `MEMORY.md` yourself … write new lessons there in the same shape」,完全手工。implement 节点默认 codex ⇒ implement 角色的记忆主要靠 Codex 手写。
- 两者都没有「写了没」的任何机器可见痕迹。Lead 今天要知道,只能去 `ls` 那个目录。

### 2.4 Lead 侧「已验证的形状」是什么

Lead 用 Claude Code 原生 agent memory(`~/.claude/agents/<lead>.md` 的 `memory: user`),写法由 Claude Code 的内建记忆指引驱动(一事一文件 + `MEMORY.md` 一行指针 + frontmatter)。FLY-2145(A1,PR #1064 已合)给它加了私有仓 + 钩子,**没有改写入时机**——Lead 也是「模型自觉写」。所以「照 Lead 侧形状」指的是**目录与文件形状**,不是时机;时机这一格 Lead 侧同样是空的,B1 是第一个给它定合同的。

## 3. 目标与验收(把 PRD B 四条 + issue 三条翻成可测句子)

| 要求 | 可测形式(在 `role` 臂下) |
|---|---|
| runner 起来读得到「它这个角色+这个项目」的记忆,不是空的 | 同 (project, role) 第二次 spawn 的 prompt `## Runner Memory` 段报 `N lines`(N ≥ 首跑 3 行头 + 第一次写的指针数),且 Claude 复述得出第一次写的 nonce(沿用 B0 §4 的三次往返脚本,但第一次由**真实 DAG runner**在收口时写) |
| 第二次跑读得到第一次写的 | 同上 |
| 换 issue 换工作目录读到同一份 | 目录路径只由 (project, role) 决定(B0 已证);B1 用两张不同 issue 的 session 行 `runner_memory_dir` 相等来断言 |
| 工作目录清掉后写下的还在 | 删 worktree 后 `runner_memory_dir` 下文件仍在(B0 已证);B1 回执里的 `closeout.sha` 与删后 `sha256sum` 一致 |
| 写入时机(issue ②) | 每个 DAG 节点执行收口(`complete` / `qa-result`)时有一条 `runner-memory closeout` 回执:`written=yes/no`、Δ 行数、Δ topic 文件、是否超预算;写进 `sessions.runner_memory_receipt`;runner 终端上也能看到那一行 |
| 截断防护写侧(issue ③) | Codex / Claude 收口时索引超软预算 ⇒ 回执行含 `OVER BUDGET` 与 K;超硬上限 ⇒ 额外一句「下一个 runner 从第 K 行起读不到」;两种都不阻塞完成但 Lead 可见 |
| 分流归因 | 每个 claude-tmux / codex-tmux 执行的 `sessions` 行有 `runner_memory_arm ∈ {off, role, shared}`;`role` 臂再有 `runner_memory_dir` 与 spawn 时索引快照;`off` 臂下这三列以外的行为与 B0 逐字节相同 |

## 4. 能走的几条路

### 4.1 写入时机(issue ②,她说「一 issue 写一次」是倾向,留我判断)

先把「一 issue」落到正确粒度:一张 issue 在 DAG 里是 eng_design → implement → qa **三个不同角色的 runner**,记忆按角色分目录,所以「一 issue 写一次」在角色目录上的自然形状就是**每个节点执行收口时写一次**——每个角色目录里,这张 issue 恰好留一次痕。

| 路 | 做法 | 取舍 |
|---|---|---|
| **A(推荐)· runner 自写 + 收口回执,不阻塞** | prompt 里把「Prefer …」改成明确的收口规则:「在跑终结命令**之前**,写下本次执行学到的 ≤5 条可复用判断;没学到就不写,并在最后报告里说一句」。`complete` / `qa-result` 在发事件前量一次索引,与 spawn 快照(env 里)比对,打印一行回执并塞进 payload;Bridge 落 `sessions.runner_memory_receipt` | 写的内容只有 runner 自己知道,只能它写;回执让「没写」从「不知道」变成「看得见」。代价:写与不写仍由模型遵守 prompt,不是硬门 |
| B · 阻塞式:未写不许完成 | `complete` 发现索引与 spawn 快照相同就拒绝,除非带 `--memory-none "<理由>"` | 强保证,但:① 要改所有阶段 prompt 里的终结命令与一堆 prompt golden;② 重启续跑的 attempt 快照是新的,会逼它写废话;③ `blocked` 路由绝不能拦,又要分路由;④ 与本 Epic 两次「不加旋钮」的 founder 直令气质相反(`--memory-none` 事实上是个口子)。**先不做**,回执数据攒一阵子,若「没写」占比高,再由 Lead 决定升级成阻塞——那时改的只是 `complete` 一处 |
| C · QA / closeout 钩子代写 | issue 收口时由一个额外 LLM 步骤读 transcript 提炼记忆 | 多一次模型调用、多一套「记忆生成器」词汇,且写进的是二手转述;违背「一个真相源」。否 |
| D · Claude Code `SessionEnd` 钩子写 | `scripts/hooks/flywheel-session-end.sh` 已在,SessionEnd 时模型已经走了 | 钩子没有内容可写,只能量索引;而量索引的最好时点是 runner 还活着的收口命令里(它看得见、还能补写)。否 |

### 4.2 回执与归因怎么落库(路 A 内部)

| 数据 | 谁产生 | 走哪条已有通道 | 落到哪 |
|---|---|---|---|
| 臂 `off/role/shared`、目录、spawn 索引快照 `{lines, bytes, sha16, topicFiles}` | Blueprint(挂载之后) | **新增一个只在 Bridge-local `DirectEventSink` 实现的 emitter 方法**(HTTP `TeamLeadClient` 为 no-op,与 `bindWorktreeOnce` / `docTier` 同一红线:runner 可见的 `/events` token 不能带 Bridge 权威) | `sessions.runner_memory_arm / runner_memory_dir / runner_memory_spawn`(3 列,nullable) |
| 收口回执 `{spawn, closeout:{lines,bytes,sha16,topicFiles,overBudget,overHard,firstDroppedLine}, delta:{indexChanged, lines, topicFiles}}` | `complete` / `qa-result`(runner 侧,当数据不当权威) | 各自已有 payload 加一个字段 | `sessions.runner_memory_receipt`(1 列 JSON) |
| 快照怎么从 spawn 传到收口 | Blueprint → adapter | 已有 pane env 正向边界,加一个 `FLYWHEEL_RUNNER_MEMORY_SNAPSHOT=<紧凑 JSON>`(与 `FLYWHEEL_RUNNER_MEMORY_DIR` 同族,只在 mounted 时设) | — |

被否的替代:
- **Bridge 侧终结时自己去量文件**(在 `applyTerminalTimestamp` 或一个新 reconciler 里):一处覆盖全部终结路径,但 design/implement 节点收口后要 park 到 ship(可能几天),终结时点太晚;而且把文件系统 I/O 塞进状态机事务。回执要的是「runner 说做完那一刻」的状态,只有收口命令知道那一刻。
- **把臂塞进 session_started**:臂本身在 emitStarted 前就能算(只依赖 mode + issueId),但目录和快照要等 worktree;拆成两个事件承载一个概念,不如一个专用方法。
- **快照写在记忆目录里的隐藏文件**:往「它们的」目录里放我们的运行时数据,污染。env 已经是 B0 立的正向边界。

### 4.3 度量函数放哪(一个真相源)

有界读(≤64KB、`fstat` 取精确字节、`readSync` 循环、`finally close`)与 `measureIndexPrefix` 今天在 `packages/edge-worker/src/runner-memory.ts`。收口回执要在 `flywheel-comm` 里量同一个文件,而 `flywheel-comm` 只依赖 `flywheel-config`(不依赖 edge-worker)。
- **推荐**:把纯度量部分(常量、`measureIndexPrefix`、有界读、sha16、topic 文件计数)**搬到 `packages/config/src/runner-memory-index.ts`**(`runner-memory-mode.ts` 已经住在那里),edge-worker 的 `runner-memory.ts` 改为从它 re-export——B0 的测试 import 路径不变、字面不变。
- 否:在 flywheel-comm 复制一份 ⇒ 两个 K 的算法,迟早分叉。

### 4.4 写侧截断守卫(issue ③)

Claude 有原生写侧守卫(见 §1),Codex 没有。B1 的写侧守卫就是 §4.2 的回执行:收口时量一次,超软预算 ⇒ 回执行 `OVER BUDGET … consolidate before you finish`;超硬上限 ⇒ 再加 `entries from about line K will NOT be loaded by the next runner`。这时 runner 还活着、还没 park,能立刻整理。不阻塞。
另外 B0 spawn 侧的守卫(下一个 runner 起来第一件事整理)继续生效——两面夹住,任一面漏了另一面兜。

### 4.5 flag 默认值

**不动**。`runner_memory_mode` 默认仍 `off`;它是 founder 的分流实验器官,何时设 `role` / `split`、何时退役是 Lead 与 founder 的操作决定。B1 交付的是「设成 role/split 之后,记忆真的落得下、看得见、能归因」;E2E 验收在隔离 slot 里设 `role` 跑。**B1 不加任何新 flag / env 开关**;新增的两个 env(`FLYWHEEL_RUNNER_MEMORY_SNAPSHOT`)是数据管道,不是开关。

## 5. 未决问题(已非阻塞发给 Lead,ask `7a0aa474`;按下面默认继续)

| # | 问题 | 我的默认 |
|---|---|---|
| Q1 | B1 不改 flag 默认(off 仍 off),验收在 role/split 下跑,生产何时设由 Lead 操作 | 按此 |
| Q2 | 写入时机 = 每节点收口前 runner 自写 + 回执不阻塞 | 按此;Lead 若要阻塞式再改 `complete` 一处 |
| Q3 | 分流臂 + 回执持久化到 `sessions` 列算 B1 范围 | 算(flag 退役条件的数据来源);4 列 nullable,off 臂只多一列 `arm=off` |
| Q4 | 跨角色读 | 不做;prompt 只指向本角色目录;盘上互相可见但不引导;留 founder 拍 |

## 6. 本 issue 明确不做

- 不改 `runner_memory_mode` 默认值,不退役 split,不加新开关。
- 不改 B0 的挂载 / 编码 / policy 探测 / 读侧守卫逻辑;只搬度量函数的位置(re-export 保 B0 测试不动)。
- 不做 Codex 原生记忆挂载(C1);不做跨角色策略;不迁移 573 条项目记忆;不做记忆备份(A 线)。
- 不做「记忆写得好不好」的质量审计;回执只回答写没写、写了多少、超没超预算。
- 首跑「不是空的」不靠预置种子:第一次 (project, role) 起来读到的是 3 行头,从第二次起非空;不从项目共享记忆里抽种子(混味、质量未审、B0 Q2 已给只读指针)。
- 不给 Lead 加新的通知面;回执落库 + Bridge 日志一行 + runner 终端一行,三面可见。founder 的分流对比页是后续单。
