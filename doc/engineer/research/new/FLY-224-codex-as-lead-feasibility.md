# Research: Codex 当 Lead —— 可行性 + vendor 可插拔 Lead 抽象 — FLY-224

**Issue**: FLY-224(Codex 做 Lead —— 用 Codex 当部门负责人,不只是 Runner)
**Date**: 2026-06-06
**Source**: 与 Annie 的 5 轮互动 brainstorm(经 team-lead relay)+ 本机真机 spike
**Related**: FLY-123(vendor-neutral Runner runtime,已 ship #219)—— 本 issue = FLY-123 plan 里预留的 **Phase 3(vendor-neutral Lead)**
**Status**: Complete

---

## 0. 一句话结论

**常驻 Codex Lead 今天就能做**,用 `codex app-server`(stdio,我们现装的 npm `codex-cli 0.137.0`,**无需另装**),延迟与 Claude Lead 同量级,能做真 gate 判断;真正驱动是 **vendor 不锁死 / 可灵活替换 AI**(Annie 原话),**不是**容灾、**不是**某个 Codex 专属能力(她明确说 c 不重要)。本文记录把方向定到这里的过程 + 全部真机数据。

> **诚实声明(两处自我纠错)**:
> 1. 我第一版 spike 误判"常驻做不到" —— 因为测错了对象(`codex exec-server` 是空壳而非 `app-server`)、用错了传输(`ws://` 是唯一实验性传输,正路是 stdio)、量错了路径(`codex exec` 单发冷启 7s ≠ 常驻热轮)。改正后真机重验推翻了悲观结论。
> 2. "那座桥大半是现成 Discord MCP" 这句一半对:出站 + "Lead 问-等-回" 现成;但**入站唤醒一个空闲 Lead 不是 MCP 能办的**(MCP 拉取式,唤不醒没在跑的 agent)→ 一个小型 gateway 监听器是不可消除的净新。

---

## 1. 驱动力(Annie 拍板)

| 候选驱动 | 是否主因 |
|---|---|
| **vendor 不锁死 / 能随时换 Codex、以后换 Gemini 或别的 CLI** | ✅ **唯一主因** |
| 容灾 / failover(Claude 挂了顶上) | ❌ 一度以为是,Annie 澄清否 |
| Codex 某个专属能力 | ❌ Annie 明说"根本不重要" |
| 省 Claude 额度 | ❌ Annie 明说不是 |

Annie 原话精神:"希望把 Agent 这边写得灵活,不完全绑定在 Claude 上;我可以换 Codex,以后也能换 Gemini 或其他 CLI。" → **重心 = 干净的可换 Lead 抽象(那道缝),Codex = 第一个非 Claude 实现来验证它。Gemini 等留扩展口,本期不实现。**

---

## 2. 审计:今天 Lead 怎么跑 + 哪些已 vendor 中立

Lead **不是**批处理,是一个**常驻交互式 Claude Code 会话**(`packages/teamlead/scripts/claude-lead.sh`,launchd 拉起,崩溃自动重启循环),靠四样 Claude Code 独有机制活着:

| Lead 做的事 | 现在靠什么 | 已 vendor 中立? | 换后端要做什么 |
|---|---|---|---|
| **管 Runner**(发指令/答 gate/收尾/verify-approval) | `flywheel-comm` + CommDB(命令行) | ✅ **是** | Codex 调同一套 CLI,**零改** |
| **读 memory** | MEMORY.md 文件 + mem0 | ✅ **是** | Codex 读同样文件,**零改** |
| **founder 授权硬门** | Bridge 侧 `FounderConsentEvaluator`(HTTP 中间件 + `flywheel-comm respond` 包装) | ✅ **是**(已 vendor 中立) | 复用;Lead 侧规则文本需搬 |
| **Runner→Lead 收件**(提问/汇报) | mailbox(transport 层已中立,`agent-team-transport`)+ Claude 内建 `useInboxPoller` 注入 | ⚠️ 通道中立,**注入是 Claude 内建** | Codex 用外部 watcher/bridge push 进 turn |
| **给 Annie 发消息** | 会话内插件回复 + Bridge 也能发(告警/gate/report) | ⚠️ Bridge 出口已有 | Codex turn 产出 → 发 Discord(复用出口 / Discord MCP) |
| **大脑/推理** | 常驻 `claude` 交互会话 | ❌ Claude 绑(**要换的就是这块**) | `codex app-server` 持久 thread |
| **收 Annie 的 Discord 消息** | Claude 的 Discord 插件(`--channels plugin:discord@claude-plugins-official`)注入会话 | ❌ Claude 绑 | **净新:gateway 监听器 push 进 app-server** |
| **身份 + 规则**(~10 个 `--append-system-prompt-file`) | claude `--append-system-prompt-file` | ⚠️ 内容可搬,机制 Claude 专属 | Codex 走 `AGENTS.md` / `developerInstructions` / `baseInstructions` |
| **健康/看门狗** | `LeadWatchdog`(capture-pane → classify pane 文本 → `pane_hash_stuck`/usage_limit 等) | ❌ **强绑常驻 TUI pane** | **必须重建**(Codex 是 daemon,无 pane) |
| **启动器 / 守护** | `claude-lead.sh` + launchd plist + 崩溃恢复(GEO-285) | ❌ Claude 绑形态 | `agent-lead.sh`(后端由 `FLYWHEEL_LEAD_BACKEND` 选) |

**关键:FLY-123 已铺好大半轨。** `packages/teamlead/src/bridge/role-adapter-resolver.ts` 已有 `lead` 角色 + `FLYWHEEL_LEAD_BACKEND` 解析位;`agent-team-transport` 已有 Codex 适配器(mailbox/watcher);**只差 `CodexAdapter.buildLeadSpawnConfig()` 一个直接抛 "Lead=codex is Phase 3 — not supported yet" 的桩没填。** FLY-123 plan §Phase 3(3.1 抽象 `claude-lead.sh`→`agent-lead.sh`、3.2 `codex-lead.sh`)就是本 issue。

---

## 3. Spike:全部真机数据(npm codex-cli 0.137.0,本机)

### 3.1 常驻引擎 = `codex app-server`(stdio),不是 exec-server,不是 ws

- `codex exec-server`(我第一版误测的)在本机能起、绑端口,但连上即报 **`exec-server stub does not implement thread/start yet`** —— **官方未实现的空壳**。
- `codex app-server` 才是真引擎:驱动 Codex 桌面 App / VSCode / web;**本机 codex-companion 插件现在就在用它**(`spawn("codex",["app-server"])` over stdio,参考实现 `~/.claude/plugins/cache/openai-codex/codex/1.0.0/scripts/lib/app-server.mjs`)。
- `app-server daemon`(管理版)才需要另装 standalone;**裸 `codex app-server` over stdio 用 npm CLI 直接跑**。
- 官方 README:**仅 `ws://` 传输实验性/不支持** → 用 **stdio / unix socket**。CLI help 上的 `[experimental]` 标签是给子命令工具的;协议本身是生产引擎。
- 协议 = newline-delimited JSON-RPC:`initialize`+`initialized` → `thread/start`(返回 `result.thread.id`,落盘 `~/.codex/sessions/.../rollout-*.jsonl` 可 resume)→ `turn/start`(流式 `*Delta` 通知)→ `turn/completed`;`thread/resume`、`turn/steer`、`thread/inject_items` 等。

### 3.2 延迟(持久连接,热进程,无冷启税)

| 回合类型 | 样本1 | 样本2 |
|---|---|---|
| 简单问答 | 首字 6.4s/总 6.8s、首字 7.9s/总 8.0s、首字 1.7s/总 1.8s | — |
| **真·Lead 回合**(shell 工具读 MEMORY.md+runner 状态 + gate 判断) | 首字 8.4s/**总 14.9s** | 首字 4.1s/**总 10.5s** |
| 热跟进回合 | 首字 1.4s/**总 1.6s** | 首字 2.5s/**总 2.9s** |

→ 实质工具回合 **~10–15s**,热跟进 **~2–3s**,**与 Claude Lead 带工具回合同量级**。工具真发生(回复逐字引了 MEMORY.md 内容)。

### 3.3 Codex 做真 Lead 判断 ✅(比延迟更有说服力)

fixture:`runner-status.txt` 含 `founder_approved=NO`;规则在 MEMORY.md。Codex Lead 读完直接答 **"HOLD —— founder approval is not recorded"**;下一轮"founder 批了"答"先 re-read runner-status 核实批准已记录再合"。**证明能在 memory+runner 状态上做 Lead 级 gate 判断,不是只会聊天。**

### 3.4 单账号无竞态 ✅(MVP 决策依据)

两个常驻 app-server **共用一个账号 + 同一个 CODEX_HOME**,并发打 turn:全过(算对)、**零 auth/lock 错误**、`auth.json` md5+mtime **一字节没变**。
→ FLY-123 那个竞态是"换号时改写 auth.json"引起;**不换号→不改写→无竞态**。**MVP 全 Codex Lead 共用一个 ChatGPT 账号**(与 5 个 Claude Lead 共用一个 Claude 账号等价);per-Lead 隔离账号 = 以后嫌限速再加的可选优化,**不进 MVP**。
诚实边界:本窗口 token 未触发刷新(auth.json 未被写),"刷新时并发改写"极端路径未实测覆盖 —— 但那正是 FLY-123 换号路径,MVP 不换号即不踩。

### 3.5 Chrome 对等(claude-in-chrome）✅

`chrome-devtools-mcp` 本机已为 codex 配好(`~/.codex` 里 `[mcp_servers.chrome-devtools] --auto-connect`)。它能 **attach 到正在跑的 Chrome**(`--browser-url=http://127.0.0.1:9222` / `--auto-connect`(Chrome 144+,chrome://inspect 授权一次)/ `--wsEndpoint`),**用 Annie 登录态 cookie**,非起空白浏览器 → 给 Codex Lead 挂这个 MCP = claude-in-chrome 对等。
caveat:Chrome 需带 `--remote-debugging-port` 起(一次性,claude-in-chrome 也有类似前置)+ 调试端口本地开放的安全注意。

### 3.6 唤醒机制 ④(Lead 核心交互循环,全验)

| 流向 | 机制 | 现成 / 净新 | 实测 |
|---|---|---|---|
| **Annie→空闲 Lead 唤醒**(最核心) | gateway 监听器(Discord websocket,推送)收消息 → app-server `turn/start` | **净新(不可消除)** | turn/start 打空闲 thread 每次都通;唤醒延迟 = gateway(亚秒)+首字 1.4–8.4s,**不轮询** |
| **忙时 Annie 再发** | `turn/steer`(需 `expectedTurnId`) | app-server 原生 | **实测 ✅,~4.5s 生效**(长 turn 中途 steer,模型立刻转向) |
| **Lead 问 Annie 等回** | `mcp-discord-agent-comm` `discord_message(expect_reply=true)` 阻塞 ≤300s | **现成** | agent 主动拉,契合 |
| **Lead 出站发/读/reaction** | Discord MCP(Composio / 同上) | **现成** | — |

**为什么入站唤醒必须净新**:MCP 工具是 agent 主动调的;一个空闲 Lead(没在跑 turn)什么都没在调,没人替它"听" Discord → MCP **唤不醒空闲 agent**。所以必须有一个常驻监听器持 Discord gateway、消息到达即 push 进 app-server。好消息:它**小**(一个 Discord bot gateway + 几个 app-server JSON-RPC 调用),且 Flywheel 的 Bridge 本就持有 Discord 关系 → **很可能挂进现有 Bridge**,不必起独立进程。

---

## 4. 净新 vs 现成(诚实清单)

**现成 / 复用(大头):**
- 管 Runner / 读 memory / founder 硬门 —— flywheel-comm + CommDB + Bridge(已 vendor 中立)。
- 常驻引擎 —— `codex app-server`(官方,本机 companion 已在用);参考实现现成。
- 持久 thread / 流式 / inject / steer —— app-server 原生。
- 社区 `ai-sdk-provider-codex-app-server`(持久 thread + 边跑边注入)、Discord MCP(`mcp-discord-agent-comm` / Composio)。
- crash 恢复 / resume —— GEO-285 思路 + thread 落盘。
- `role-adapter-resolver` lead 角色 + `FLYWHEEL_LEAD_BACKEND` 开关 —— FLY-123 已留。

**净新(自己做):**
1. **可插拔 Lead-backend 接口("那道缝")** —— 抽象 + Codex 实现。
2. **Discord gateway 入站监听器** —— push 进 app-server(不可消除;很可能并进 Bridge)。
3. **app-server ⟷ Lead 循环的桥** —— turn/start / steer / inject / 流式回 Discord / 进程守护重连。
4. **健康/看门狗为 Codex 重建** —— 见 §5(最该小心)。
5. **规则从 `--append-system-prompt-file` 搬到 `AGENTS.md`/`developerInstructions`** + 在 Codex 上重验行为(GPT 听指令方式不同)。
6. `agent-lead.sh`(`claude-lead.sh` 不动,并排新路径)+ launchd 集成。

---

## 5. 最该小心:健康/看门狗(FLY-176/193/218/220 伤疤区)

`LeadWatchdog`(`packages/teamlead/src/LeadWatchdog.ts`)整套是 **capture-pane → classify(pane 文本)→ `pane_hash_stuck`/usage_limit** —— **强绑常驻 Claude TUI pane**。Codex app-server Lead 是 **daemon 进程 + bridge,无 TUI pane** → 这套**不能复用**,必须为 Codex 路径**另建健康模型**:监 app-server 进程存活 + gateway 监听器健康 + thread 响应性(turn round-trip),**不是** pane 文本分类。

- **反向好处**:Codex Lead 没有 pane 可误读 → **结构性免疫 FLY-193/218/220 那一整类 pane 误报刷屏**。
- **硬约束**:新健康路径**绝不触碰**现有 Claude Lead 的 pane 监控(生产 3 个 GeoForge3D Lead 在用)。两套并存,按后端分流。

---

## 6. 范围 / rollout / 安全(Annie 拍板)

- 验证场 = **joycon / sub**(FLY-123 Runner 同练兵场,不碰 GeoForge3D 生产)。
- **`claude-lead.sh` 一字节不改**;新路径并排(`agent-lead.sh` + `FLYWHEEL_LEAD_BACKEND`)。
- 目标 **完全等同** Claude Lead(claude-in-chrome 小边经 CDP MCP 已对等,无真天花板)。
- **Codex 先行,Gemini 留扩展口,本期不实现。**
- 流程:research → plan → Codex design review → implement → code review → QA。中途不回 Annie(QA 过才汇报),只有全新产品决策才上报。

---

## 7. Sources

- 真机 spike 数据:`/tmp/fly224-realload*.out`(延迟)、`/tmp/fly224-concurrent.out`(单账号)、`/tmp/fly224-steer.out`(steer)、`/tmp/codex-as-schema/`(app-server v2 协议 JSON schema)。
- 本机参考实现:`~/.claude/plugins/cache/openai-codex/codex/1.0.0/scripts/lib/app-server.mjs`(`spawn codex app-server` over stdio)。
- 官方:`developers.openai.com/codex/app-server`、`github.com/openai/codex/blob/main/codex-rs/app-server/README.md`(stdio/unix-socket 生产、ws 实验)。
- 社区:`ai-sdk.dev/providers/community-providers/codex-app-server`(持久 thread + mid-execution injection)、`github.com/EugenEistrach/mcp-discord-agent-comm`(`discord_message` 阻塞等回复 ≤300s)、`composio.dev/toolkits/discord/framework/codex`、`github.com/ChromeDevTools/chrome-devtools-mcp`(attach `--browser-url`/`--auto-connect`)。
- 内部:`packages/teamlead/scripts/claude-lead.sh`、`packages/teamlead/src/bridge/role-adapter-resolver.ts`、`packages/agent-team-transport/src/codex/CodexAdapter.ts`、`packages/teamlead/src/LeadWatchdog.ts`、FLY-123 plan archive `doc/engineer/plan/archive/v2.0-FLY-123-vendor-neutral-agent-runtime.md`(§Phase 3)。
