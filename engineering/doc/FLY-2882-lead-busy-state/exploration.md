# FLY-2882 Lead 忙闲只读接口 — 探索
Issue: FLY-2882 (https://linear.app/geoforge3d/issue/FLY-2882/语音耳机bridge-某个-lead-现在在忙什么只读接口在不在一轮活里在做哪张单已经多久claudecodex-两种载体)
日期: 2026-09-25
基于: 无(上游设计出处: FLY-2881 第三版 §2 S4 第 18 步 + 琥珀卡「读忙闲」)

## 1. 要解决的问题

耳机模式里 Raya 替 founder 去问别的 Lead;对方 1 分钟没回,Raya 要能查到「他现在是不是在一轮活里、这轮是哪张单引起的、已经多久」,再问 founder 是等还是打断。今天 Bridge 只知道 Lead 进程活不活,不知道忙闲。

本单只做**只读接口**(Bridge 路由 + `flywheel-comm` CLI)。打断是 FLY-2883;语音侧接线等核心单。

## 2. 现状审计(origin/main a084f3a99)

### 2.1 Lead 名册与载体
- 名册: `packages/teamlead/src/ProjectConfig.ts:367` `loadProjects()`(`~/.flywheel/projects.json`)。
- 载体字段是 `backend`(`lead-backends/lead-backend.ts:13`,`"claude-code" | "codex-app-server"`,缺省 = claude-code),解析用 `effectiveLeadBackend()`(`flywheel-comm/src/canonical-lead.ts:132`)。`carrier: "v2"` 只是 Claude 的子形态。
- 本机生产名册实查(2026-09-25):**17 个 Lead**。14 个 Claude(v2 tmux 私有 socket)+ 3 个 Codex(`mufasa-lead`、`codex-infra-bot-lead`、`raya`,都是 TUI 形态)。

### 2.2 Claude 载体:终端画面
- 定位: `bridge/fleet-lead-locator.ts:21` `locateConfiguredLeadWindow()` → 确定性地址 `<stateDir>/sock/fw-<prefix>-<sha16>.sock`,会话 `=main`,pane `%0`(`LeadWindowLocator.ts:31-38,112`)。
- 身份核验: `probeV2LeadPane()`(`LeadWindowLocator.ts:48`)核 pane 起始命令是 `lead-body.sh`、ps 核 pid;`"send"` 强度额外要求当前命令是 `claude`。
- 截屏: `bridge/lead-alert-helpers.ts:232` `defaultLeadPaneCapture()` = `tmux -S <sock> capture-pane -t %0 -p -S -<n>`,5 秒超时,先重跑身份核验,失败就抛「identity is indeterminate」。**这是现成的只读截屏通道**(告警/rescue 都在用)。
- 已有识别规则: `pane-blocked-classifier.ts:54-60` `IDLE_READY_MARKERS`(私有)、`:102` `INTERRUPT_HINT = /esc to interrupt/i`;`account-heal/model-cap.ts:20` `ACTIVE_INFLIGHT`。**没有任何代码解析转圈行里的已用时间。**

### 2.3 ⚠️ 实测推翻了一个前提:「esc to interrupt」已经不显示
FLY-2881 设计里写「Claude Lead 看终端底部有没有 esc to interrupt」。本机 Claude Code **2.1.282** 实测:

| 场景 | 终端底部实际那一行 |
|---|---|
| 一轮活进行中 | `✽ Bunning… (40s · ↓ 1.5k tokens)` —— **没有** esc to interrupt |
| 一轮刚结束 | `✻ Worked for 1m 17s · done 12:17 PM` |
| 重启后从没干过活 | 没有这一行,只有输入框 + 状态栏 |

(实测方式:① 截自己的 pane;② 一次性的 Haiku 测试会话,见 research.md;③ 对 14 个生产 Claude Lead 的 pane 只取「边框行 + 状态行」做了一次只读过滤——未落盘、未看正文。)

所以:
1. 「esc to interrupt」不能再当忙的判据,要改用**转圈行本身**(`<符号> <动词>… (<时长> …)`)。
2. 「✻ Worked for …· done …」这种**已完成行长得很像转圈行**,老正则 `ACTIVE_INFLIGHT` 的 `^\s*[✻✶✳✢✽]\s` 会把它误判成忙——必须是显式的阴性规则。

### 2.4 Codex 载体:sidecar 内存 + 部分落盘
- 每个 Codex Lead 是**独立的 sidecar 进程**(`codex-lead-tui-runtime.ts`,launchd 托管),不在 Bridge 进程里。
- 它通过 `TurnDemux`(`lead-backends/codex/TurnDemux.ts`)看到**同一对话里所有轮次**的事件:自己发起的轮(Discord/信箱消息)进 executor,founder 在终端里自己敲的轮进 observer(`codex-lead-tui-runtime.ts:420-430,1235-1247`)。
- 内存状态: `founderTurnActive`(初值 `"unknown"`)、`founderTurnId`、`lastActivityAt`;`LeadInputRouter.processing/queue`。**没有记本轮开始时间。**
- 已有落盘: `resident-codex-lead-lifecycle.ts` 写 `brain/heartbeat.json`(`activeTurn {turnId, startedAt}`)——但**只有 residency-patrol 名单里的 Lead 才写**,且**只记 sidecar 自己发起的轮**,founder 终端轮不记。Bridge 已有读者(`resident-codex-lead-patrol.ts:776-822`),但它硬编码路径,和 `resolveCodexLeadStateDir()` 可能不一致。
- Bridge ↔ sidecar 有现成通道:`<stateDir>/lead-inbox.sock`(`CodexLeadInboxSocket.ts`),HMAC 认证,方法有 `submitBatch / capabilities / readRuntimeConfig / probeVoiceSelfFilter …`,**没有读忙闲的方法**;未知方法回 `unsupported inbox method`。
- Codex 协议事件(仓里抓过的证据 `product/doc/FLY-1911-…/evidence/*.jsonl`):`turn/started` 带 `turn.startedAt`(unix 秒)、`turn/completed`、`thread/status/changed {status:{type:"active"|"idle"}}`。我们的代码只按 turnId 用前两个。
- 冷启动种子: `codex-lead-thread-rotation.ts:291-335` 已经用 `thread/turns/list {limit:1, sortDirection:"desc"}` 当空闲探针——可复用给 sidecar 启动时补初值。

### 2.5 「在做哪张单」的现成数据(不碰正文)
- CommDB `mailbox`(每项目 `~/.flywheel/comm/<project>/comm.db`)对每个 Lead 都有投递行,**带时间戳、来源类型、发件方**,正文在 `content`(不读)。
- 三类来源都能只靠元数据映射到 issue(本机实查):

| source_kind | 映射链 |
|---|---|
| `question`(runner 提问/汇报) | `from_agent` = 执行 id → CommDB `sessions.issue_id` |
| `lead_event`(Bridge 事件) | `source_ref` = StateStore `lead_events.seq` → `session_key = "<project>:<ISSUE>"` |
| `discord_chat` | `from_agent = "discord:<channelId>"` → StateStore `chat_threads` / `phase_chat_threads` 的 `thread_id → issue_id`(主频道消息映射不到) |

- Codex 的 sidecar 轮还有确定性链:`journal`(在飞条目)→ `journal_member.delivery_id` → `mailbox` 行。
- Claude 没有「这轮由哪条消息引起」的结构化记录,只能按「轮开始前后几秒内投递的消息」推断。

## 3. 选项

### 3.1 Claude 载体读法
| 方案 | 说明 | 判断 |
|---|---|---|
| **A. 截屏读转圈行(选中)** | 复用 `locate + probe + capture`,解析输入框上方最底下那条「转圈行 / 已完成行」 | 零新依赖、现成只读通道;计时整轮累加,误差 ~1 秒 |
| B. 加 Claude hook(UserPromptSubmit/Stop)写状态文件 | 精确 | 要改 Lead 启动脚本并重启全部 Lead 才生效;Esc 打断不触发 Stop,会卡成「忙」;channel 推送的消息是否触发 UserPromptSubmit 未证实 |
| C. 读 `~/.claude/projects/*.jsonl` 转录 | 精确 | 转录里全是正文,违反「不读正文」;Lead 转录路径还受 `CLAUDE_CODE_CHILD_SESSION` 影响 |

### 3.2 Codex 载体读法
| 方案 | 说明 | 判断 |
|---|---|---|
| **A. sidecar 新增只读 socket 方法 `readTurnState`(选中)** | sidecar 在 TurnDemux 入口统一记轮次(含 founder 终端轮、`turn.startedAt`),Bridge 用现成 HMAC 通道问 | 活的答案,socket 能答 = 进程在;覆盖 founder 轮 |
| B. 扩 `heartbeat.json` | 落盘 | 只覆盖 patrol 名单;文件会陈旧,要额外判 pid/新鲜度 |
| C. 截 Codex TUI 窗口 | 对称 | Codex Lead 的 TUI 是 founder 可见窗口,识别规则又一套;sidecar 已有结构化事件,没必要 |

### 3.3 「哪张单」
- 选中:**只说「这轮是由哪张单的消息引起的」**,不说「正在做」;有唯一答案才给,否则写「判断不了 + 原因」。
- 否掉:读 Lead 最近的工具调用标题当摘要(那就是正文的一部分,且可能含敏感内容);用 Lead 名下在跑的 runner 猜(Lead 忙和 runner 忙是两件事)。

## 4. 开放问题(已按默认处理,不阻塞)
1. Claude 的 subagent/后台任务在跑、主轮已结束 → 判 idle(主轮能接新消息)。在 plan 里写成已知边界。
2. Claude 出现菜单/权限弹窗 → unknown(`pane_unrecognized`),不猜。
3. Codex 已收到消息但还没开轮(几秒窗口)→ idle;不另设状态。
