# FLY-2169 socket 直连 Codex runner 在 cmux 零可见 — 探索

Issue: FLY-2169 (https://linear.app/geoforge3d/issue/FLY-2169/可见性-socket-直连-codex-runner-在-cmux-零可见-founder-主观察窗照不到-implement-段一晚四问)
日期: 2026-08-29
基于: 无

**Mode**: Technical | **Depth**: Deep | **Status**: final(autonomous design 节点,决策依据 issue 要求 + 生产证据)

## 0. 现象复述

founder 2026-08-30 01:08–01:09(UTC)连续四问:FLY-2155 / FLY-2165 / FLY-2152 三条线的
implement 段在她的主观察窗 cmux 里完全不可见。cmux 是 tmux 的镜像,claude 体 runner 全部
可见(每体一个 tmux 窗口跑 claude CLI),codex 体 implement 段全部黑窗。

## 1. 探索发现 — 根因比 issue 描述更精确一层

issue 的根因描述是"socket 直连的 Codex runner 没有 tmux 窗口"。实际探索发现:**开窗机制
存在,但对 implement 段 phase runner 系统性失败**。

### 1.1 现有机制(FLY-1188 M4c-3)

`CodexTmuxAdapter`(codex vendor 的 runner adapter,`packages/claude-runner/src/CodexTmuxAdapter.ts`)
在 spawn 时:

1. 向 comm.db `registerSession`,tmux_window 先写占位 `runner-flywheel:pending`
   (CodexTmuxAdapter.ts:1819-1821);
2. spawn `codex app-server --remote-control`(Bridge 子进程,socket 直连)驱动 goal;
3. 等 `onThreadReady` 后调 `ensureRunnerTuiWindow`(`codex-runner-tui-window.ts`)开一个
   founder TUI 窗口:窗口内跑 `codex resume --remote unix://<socket> <threadId>`,附着到
   daemon 正在驱动的同一线程;
4. TUI 成活(settle 800ms 后 pane 仍在)才 `pinCommDbSessionWindow` 把 comm.db 的
   tmux_window 更新为真实窗口(`wireCreated`,CodexTmuxAdapter.ts:671-712)。

窗口命名已经是 canonical `FLY-XX-role-...`(`sanitizeTmuxName(ctx.label)`),issue 要求 1
的命名部分现状已达标。

### 1.2 生产证据(2026-08-29/30 当晚,comm.db + bridge.log 实测)

comm.db sessions 表(时间 UTC):

| execution_id | issue | vendor | tmux_window | 备注 |
|---|---|---|---|---|
| b03845bf | FLY-2155 | codex | `runner-flywheel:pending` | implement 段,founder 点名 |
| aace4d22 | FLY-2152 | codex | `runner-flywheel:pending` | timeout 终态,founder 点名 |
| 1ac0d135 | FLY-2166 | codex | `runner-flywheel:pending` | |
| ca97c108 | FLY-2031 | codex | `runner-flywheel:pending` | |
| dd6b27d7 | FLY-2165 | codex | `runner-flywheel:@118` | 曾成功,窗口现已消失 |

bridge.log(/tmp/flywheel-bridge.log)统计:

- **47 次** `runner-tui-window: founder TUI DIED immediately`,分布在 6 个 implement 窗口:
  FLY-2155(10 次)、FLY-2152(10 次)、FLY-2031(9 次)、FLY-2166(8 次)、FLY-2103(6 次)、
  FLY-2139(4 次)— FLY-1239 的 bounded retry 链全部耗尽;
- 少数 `founder TUI up` 成功(2165/2136/2033 各 1 次等),但当前
  `tmux list-windows -t runner-flywheel` 里 **codex implement 窗口一个都不剩**(claude 体
  窗口全部健在)— 成功的 TUI 后来也死了,且 park/keep-alive 期间无人补窗;
- TUI 未成活 → comm.db 恒 pending → `[issue-display] attach cross-wire … resolution_failure
  "pending-target" — withholding attach command`(FLY-923 证据链同时报废)。

### 1.3 TUI 死循环的机理(为什么修不动)

`codex resume --remote` TUI 的出生依赖两件 Bridge 管不到的事:

1. **rollout-landing race**(FLY-1239 已知):TUI resume 需要 CODEX_HOME/sessions 下该
   thread 的 rollout jsonl 已落地;app-server 落 rollout 的时机不受控 → "no rollout found"
   → TUI spawn 后 200ms 内退出 → tmux 报成功但 pane 已死;
2. **active-writer fork**(memory: reference_design_review_gate_committed_plan_and_codex_resume_traps):
   resume 撞上 daemon 这个 active writer 时 codex 会 fork 新线程。实锤:b03845bf 的
   CODEX_HOME 下有 4 个 rollout — 真 goal 线程 11.2MB(活跃更新到最后),另外 3 个
   2.4-3.6MB 的是 15:26 三次 TUI 尝试各自 fork 出来的副本线程。**每次开窗尝试还在污染
   CODEX_HOME 并复制整段历史**。

即:可见性通道把自己的健康押在 codex binary 的 TUI + rollout 时序上,实证不可靠,且尝试
本身有副作用。真 goal 线程一直在正常干活(11MB rollout 持续增长)— 纯可见性故障。

### 1.4 事件流现状 — 渲染钩子已预留

`CodexDaemonEvents.onNotification?: (method, params)`(codex-daemon-client.ts:168-170)
转发 app-server 的**每一条** raw notification,注释原文 "for pane rendering / diagnostics"。
CodexTmuxAdapter 目前只用它打心跳:`{ onNotification: () => heartbeat() }`
(CodexTmuxAdapter.ts:981),params 全部丢弃。协议已知 method:`turn/started`、
`turn/completed`、goal 通知(`onGoalUpdate`)、item 级事件。

### 1.5 既有窗口终态规则(claude 体)

`packages/flywheel-comm/src/cleanup.ts`:session 终态(ended_at)后超过 timeout 分钟才
kill 对应 tmux window — 即**留痕一段时间再清**。codex 窗口一旦注册真实窗口名,这套机制
自动覆盖它(issue 要求 2 的"按既有 close 规则处理")。当前 CodexTmuxAdapter 在 teardown
时主动 killWindow — 因为 resume TUI 指向死 socket 必须杀;只读 tail 窗口没有这个约束。

## 2. 受影响面

| 文件/模块 | 影响 | 说明 |
|---|---|---|
| `packages/claude-runner/src/CodexTmuxAdapter.ts` | 改 | 开窗时机(spawn 即开,不等 threadReady)、窗口内命令、comm.db pin 时机、teardown 窗口处理、onNotification 接 transcript sink |
| `packages/claude-runner/src/codex-runner-tui-window.ts` | 改 | 窗口命令从 `codex resume --remote` 换为 transcript tail;settle/died 检测面收窄 |
| `packages/claude-runner/src/`(新模块) | 加 | transcript 渲染 sink(notification → 可读文本 → 落盘) |
| `packages/flywheel-comm/src/db.ts` | 不改 | `updateSessionTmuxWindow` / `%:pending` 语义照用 |
| `packages/flywheel-comm/src/cleanup.ts` | 不改 | 终态窗口留痕+超时清理,自动覆盖 |
| `packages/teamlead/src/bridge/phase-actor-reentry.ts` 等探活 | 不改(边界) | 探活轴修复归 FLY-2155;本单只保证 tmux_window 写真名 |

## 3. 方案比较

### Option A: 修好 `codex resume --remote` TUI 路径

- **核心**:诊断 47 died 的精确死因,加强重试/等 rollout 落地/规避 active-writer fork。
- **Pros**:保留 founder 在窗口内打字干预的能力;改动集中在时序。
- **Cons**:rollout 落地时机与 fork 行为都是 codex binary 内部实现,Bridge 侧只能猜和等;
  FLY-1239 已经修过一轮(bounded retry)仍 47 died;每次尝试污染 CODEX_HOME;修好了
  "出生"还有"成活后死亡无人补"(@118 消失)要另修 watchdog。治标,且标也治不稳。
- **Effort**:Medium-Large,且成功概率不可控。

### Option B(推荐): 窗口内容改为只读 transcript tail(Bridge 事件落盘 + `tail -F`)

- **核心**:CodexTmuxAdapter 把 `onNotification` 事件流经一个新的 transcript sink 渲染成
  可读文本,落盘到 `codexSessionStateDir(execId)/transcript.log`;founder 窗口 = spawn 时
  立即创建、内跑 `exec tail -F <transcript.log>`。窗口创建成功即把真实窗口名写入 comm.db。
- **Pros**:窗口出生与 codex binary / rollout 时序**完全解耦**(spawn 即有窗、tail 永不死);
  comm.db 100% 写真名(要求 3);零副作用(只读,不撞 writer、不 fork 线程);渲染逻辑在
  Bridge 内 TS,纯函数可单测;终态窗口留痕无害,直接走 claude 体同款 cleanup 规则(要求 2);
  phase park/wake 天然连续(同 execId 同文件追加)。
- **Cons**:窗口只读 — founder 不能在窗口里打字干预(claude 体可以);transcript 渲染依赖
  app-server notification 格式(非我方契约,需未知事件降级渲染保底)。
- **Effort**:Medium。

### Option B2(变体,不推荐): 窗口内渲染器进程直接读 rollout jsonl

- **核心**:窗口里跑一个 node CLI,按 session.json 的 threadId glob 到 rollout 文件,增量渲染。
- **Cons**:rollout 出生 race 回到锅里(正是 TUI died 的根源之一);codex rollout 内部格式
  非契约;渲染器是长活进程,自身崩溃要自愈(比 `tail -F` 复杂一个量级);11MB 级文件的增量
  解析在窗口进程里做。
- **结论**:同一方向里的更差实现,弃。

### Option C: 混合 — resume TUI 首选,died 后降级 tail

- **Cons**:保留 A 的全部脆弱面 + B 的全部实现,状态机翻倍;违反 founder 红线
  "评审条数逐轮涨 = 你在长机制,只删不加"(feedback_growing_review_findings_mean_growing_mechanism)。
  干预能力可以走"transcript header 里打印 inspect-by-hand 的 resume 命令"这条已有的手动路径。
- **结论**:弃。

### Rejected alternative: 改 Bridge Dashboard 而不是 tmux

founder 主观察窗是 cmux(feedback_patrol_must_look_through_founder_window:她那扇窗=验收面),
issue 明确要求 tmux 窗口。Dashboard 补强不解本单。

## 4. 推荐:Option B

一句话:**把 codex 体的 founder 窗口从"寄生在 codex TUI 健康上的交互终端"换成"Bridge 自己
拥有的只读 transcript tail",窗口出生、注册、留痕全部与 codex binary 解耦。**

同时**删掉**(不是叠加)resume-TUI 专属的脆弱机制:threadReady 门、rollout-race 重试链的
大部分、teardown 主动杀窗(改走 cleanup 留痕规则)。`ensureRunnerTuiWindow` 的 tmux 层骨架
(session ensure / 同名窗 purge / settle 验活)保留复用。

## 5. 关键决策点(设计自决,依据 issue 要求与红线)

1. **窗口只读,干预走手动路径**:issue 验收原文是"能点开 implement 段看到工人正在说什么",
   没有要求窗口内干预;transcript header 打印手动 resume 命令(现 died 日志里已有同款)。
2. **探活边界(与 FLY-2155 的契约)**:tail 窗口 pane 永活 ≠ 体活。本单写真名只为
   cmux/issue-display/cleanup 服务;**探活对 codex 体永远不得走窗口轴**,必须走
   session.json 的 daemonPgid / socket 轴(FLY-2155 领域)。设计文档显式写此契约,防止
   本单把 2155 的误判变得更隐蔽。
3. **transcript 防膨胀**:只落非-delta 事件(turn 边界、item 完成、goal 状态),delta 类
   聚合或丢弃;文件设上限轮转。

## 6. 下一步

- [x] 探索完成
- [ ] research.md:app-server notification 真实 method 集采样方式、tail -F 平台行为、
  文件轮转与 tmux 窗口交互细节
- [ ] plan.md → codex-design-review → 实施
