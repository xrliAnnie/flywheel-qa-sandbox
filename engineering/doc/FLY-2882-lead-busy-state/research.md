# FLY-2882 Lead 忙闲只读接口 — 调研
Issue: FLY-2882 (https://linear.app/geoforge3d/issue/FLY-2882/语音耳机bridge-某个-lead-现在在忙什么只读接口在不在一轮活里在做哪张单已经多久claudecodex-两种载体)
日期: 2026-09-25
基于: exploration.md

本文件只记**实测/读源码得到的事实**,每条带出处。设计取舍在 plan.md。

## R1. Claude Code 2.1.282 的转圈行:计时是「整轮」时长(实测)

一次性测试会话(隔离 tmux socket `-L fly2882p`,Haiku,工作目录在 scratchpad,测完 `kill-server`):让它连续做 3 次各 25 秒的工具调用,中间各说一句话。每 9 秒截一次屏:

```
t+9s:  ✶ Spelunking… (8s · ↓ 298 tokens)
t+36s: ✻ Spelunking… (36s · ↓ 423 tokens)
t+64s: · Spelunking… (1m 4s · ↓ 547 tokens)
t+82s: ✢ Spelunking… (1m 22s · ↓ 547 tokens)
t+91s: ✻ Cooked for 1m 26s · done 1:11 PM
```

结论:
1. 计时**跨多次工具调用一直累加**,从 founder/消息进来那一刻算起,误差 ≈ 1 秒(t+9s 显示 8s)。⇒「开始时间 = 观测时刻 − 已用时间」满足 QA 判据 2 的 ≤30 秒。
2. 符号在 `✶ ✳ ✢ ✻ ✽ ·` 之间轮换(`·` 也是其中之一,老正则漏了它)。
3. 动词是随机的(Spelunking/Bunning/Churning…),**不能**按动词白名单识别。
4. 轮结束后变成 `✻ <过去式> for <时长> · done <时刻>`,并一直留在输入框上方,直到下一轮开始。
5. 没有 `esc to interrupt`。

附带发现:测试会话里第一次让它 `sleep 25` 被全局 hook 拦了(这是本机的 hook,不影响结论);换 `python3 -c "import time; time.sleep(25)"` 后正常。

## R2. 时长格式(读 2.1.282 二进制里的格式化函数)

`~/.local/share/claude/versions/2.1.282` 里的 `en(ms, opts)`:

| 时长 | 输出 | 精度 |
|---|---|---|
| < 60s | `8s` | 1 秒 |
| < 1h | `1m 4s` | 1 秒 |
| < 1d | `2h 3m 4s` | 1 秒 |
| ≥ 1d | `1d 2h 3m` | **1 分钟**(没有秒) |

`hideTrailingZeros` 变体会省掉末尾的 0(例如 `5m`、`2h`),另一个包装 `iK()` 会把 ≥60s 的时长**四舍五入到分钟**。观测到的转圈行是逐秒变化的(`1m 4s`、`1m 13s`),说明转圈行没走四舍五入那条路;但解析器不能假设,**没有秒位时精度按 ±30 秒标注**。

⇒ 解析器接受 `(\d+d)? (\d+h)? (\d+m)? (\d+(\.\d+)?s)?` 的任意非空组合;返回 `precision: "second" | "minute"`。

## R3. 生产 Claude Lead 的画面结构(只读过滤实查,2026-09-25 13:1x PDT)

对 14 个 `~/.flywheel/sock/fw-*.sock` 各跑一次 `capture-pane -S -30`,**在内存里**只抽「输入框边框行 / `@leadId` / 转圈或已完成行的前缀」,没有落盘,没有看正文:

- 14/14 都有输入框上边框 `──── @<leadId> ─`(与 `pane-live-region.ts:47` 的锚点正则一致)。
- 1 个在忙:`✽ Bunning… (40s · ↓ 1.5k tokens)`(flywheel-eng-lead)。
- 6 个显示已完成行(`Worked for 1m 17s · done 12:17 PM`、`Cogitated for 6s · done Thursday 12:42 AM` …)。
- 7 个两种行都没有(重启后还没干过活)——只有输入框 + 状态栏。

转圈行和边框之间可能隔着别的行:本 runner 自己的 pane 里是「转圈行 → 2 行 Tip → 空行 → 边框」;待办清单(`⎿ ☐ …`)和排队中的消息也会插在中间。`liveRegion()` 只保留边框上方 4 行,**不够**。⇒ 解析器要在边框上方扫更大的范围,取离边框最近的状态行。

**R2 后补充(同日复查,截 150 行)**:完成行之后常跟着 `⏺ everything-claude-code: hooks.json …` 警告、`⏺ Remote …` 等**第 0 列 `⏺` 条目行**;进行中的转圈行总在所有条目下方;排队消息显示为第 0 列 `› …`,位于转圈行上方。用 plan §4.1 的「状态槽位」规则复查 14 个生产 Claude Lead:12 idle、1 busy、1 无状态行。早先「7 个没有状态行」是 30/40 行窗口太小造成的误读。

输入框**下方**还有状态栏、subagent 行(`◯ Explore … 3m 41s · ↓ 135.7k tokens`)——这些也带时长,必须只看边框**上方**,否则会把 subagent 的计时当成主轮。

## R4. Codex 事件形状(仓内证据 `product/doc/FLY-1911-codex-voice-prototype/evidence/*.jsonl`)

```json
{"method":"turn/started","params":{"threadId":"…","turn":{"id":"…","status":"inProgress","startedAt":1787180262,"completedAt":null}}}
{"method":"thread/status/changed","params":{"threadId":"…","status":{"type":"active","activeFlags":[]}}}
```

- `turn.startedAt` 是**服务端给的 unix 秒**——比 sidecar 自己记的观测时间更权威,精度 1 秒。
- `TurnDemux.route()`(`TurnDemux.ts:124`)是所有事件的唯一入口;注册过的 turnId → `toExecutor`(sidecar 自己发起的轮),其余 → `toObserver`(founder 终端轮)。`dispatchPending` 期间的事件会先扣住,`claimTurn()` 后按原样回放,**params 不变**,所以回放时 `startedAt` 依然准确。
- `thread/turns/list {threadId, limit:1, sortDirection:"desc", itemsView:"notLoaded"}` 已被 `codex-lead-thread-rotation.ts:291-335` 当空闲探针使用,返回的 turn 对象带 `status` 与 `startedAt`——可复用来给 sidecar 冷启动/重连后补初值。

## R5. sidecar 通道(`CodexLeadInboxSocket.ts`)

- 每个 Codex Lead 一个 `<stateDir>/lead-inbox.sock`;Bridge 侧用 `resolveCodexLeadStateDir(project, leadId)`(`lead-inbox-runtime.ts:1258`)+ `resolveCodexLeadInboxSocketPath()` 找到它;认证是 HMAC(bot token)。
- 现有能力协商:`capabilities` 返回 `features[]`。老 sidecar 对未知方法回 `unsupported inbox method`。⇒ 新方法 `readTurnState` 配新 feature `turn_state_v1`;Bridge 先看 feature,没有就返回 unknown(`sidecar_lacks_turn_state`),不去猜。
- 现有 Bridge 客户端 `probeCodexLeadInboxCapabilities()`(`lead-delivery-adapter.ts` 使用)可作为新读方法的模板。

## R6. 「这轮由哪张单引起」的元数据链(本机实查)

CommDB `mailbox` 列(不读 `content` / `delivery_content`):`delivery_id, from_agent, to_agent, source_kind, source_ref, type, state, delivered_at, acked_at`。时间是 ISO 字符串,毫秒精度。

| source_kind | 实查样例 | 映射到 issue |
|---|---|---|
| `question` | `from_agent=244670e3-…` | CommDB `sessions(execution_id → issue_id)` ⇒ `FLY-2830` ✅ |
| `lead_event` | `source_ref=128953` | StateStore `lead_events.seq=128953` → `session_key="flywheel:FLY-2830"` ✅ |
| `discord_chat` | `from_agent=discord:1524829037825101975` | StateStore `chat_threads.thread_id` / `phase_chat_threads.thread_id` → `issue_id`;该样例是主频道,**查不到**(正确地给不出) |

Codex sidecar 轮的确定性链:sidecar journal 在飞条目 → `journal_member.delivery_id`(Bridge 投递的格式是 `<mailbox delivery_id>#r<attempt>`,要去掉后缀)→ mailbox 行 → 上表。

Claude Lead 没有「这轮由哪条消息触发」的记录。可用的近似:**轮开始时刻前后几秒内**投递给该 Lead 的 mailbox 行。Claude 空闲时收到推送,1–2 秒内就开轮;忙时收到的消息会被塞进当前轮,不会开新轮。⇒ 窗口定 `[start − 10s, start + 3s]`。窗口内的消息全部能映射、且只映射到**同一张单**才给答案,否则写「判断不了」。

注意 Tadashi 这类 Lead 的信箱非常密(实查 1 分钟内 5 条,来自 2 张单),窗口里常常多张单 ⇒ 大多数时候会诚实地给「判断不了(多张单)」。这是预期行为,不是缺陷。

## R7. 路由与 CLI 惯例

- 模板:`bridge/lead-persona-routes.ts`(`GET /activation?projectName=&leadId=`,严格只收这两个参数,400 `invalid_arguments`)+ 挂载 `plugin.ts:5518-5521`(`masterOnlyAuthMiddleware`)+ 测试 `bridge/__tests__/lead-persona-routes.test.ts`。
- Bridge 只绑 loopback(`config.ts:56-59`)。
- CLI 模板:`flywheel-comm/src/commands/ship-judgment-history.ts:48`(`parseArgs` strict、`TEAMLEAD_API_TOKEN`、`assertLoopbackCarrierUrl`、`redirect:"error"`、超时、单行 JSON 输出),在 `index.ts:493` 分派。

## R8. 已知会咬人的本机事实(来自项目记忆,实现/QA 要注意)
- 测试不要跑 `**/tmux-viewer.macos.test.ts`(会开 Terminal.app)。
- 任何调 `startBridge` 的 vitest 会用真 HOME 跑 Codex lease janitor——本单测试**不要**起整个 Bridge,路由测试只起 express。
- runner 的 TMPDIR 太长,真 tmux/unix socket 用例本地要用短 TMPDIR。
- 新增 spawn/kill 代码会撞四本清册守卫;本设计**不新增 spawn**,Claude 截屏复用 `defaultLeadPaneCapture()`。
- 529 房的 slot Bridge `distSha` 是沙箱 main 克隆;Codex slot Lead 能不能跑到本分支的 sidecar 代码,QA 开房前要先核(见 plan §9)。
