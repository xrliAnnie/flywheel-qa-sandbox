# FLY-2781 语音上线验证 — 调研（实测证据）

Issue: FLY-2781 (https://linear.app/geoforge3d/issue/FLY-2781/语音上线验证-fly-2655-已随-9-22-1224-pt-班车部署codex-1651-pt)
日期: 2026-09-22
基于: exploration.md;Lead 指令 e5e8e486;Lead 勘误 2026-09-23 02:59Z

所有时间用 PT（America/Los_Angeles）标注；UTC 原文保留在各条里。本次没有开任何生产语音会话，没有往任何 Discord 频道发消息，没有改任何配置。

## A. 部署字节：在跑的确实是 FLY-2655 修复后的代码 ✅

| 项 | 观测 |
|---|---|
| launchd job | `com.flywheel.voice`，state = running，PID 54933 |
| 进程启动时间 | 2026-09-22 12:02:03 PT（`ps -o lstart`） |
| 进程 cwd | `/Users/xiaorongli/Dev/flywheel`（`lsof -a -p 54933 -d cwd`） |
| 宿主 checkout HEAD | `58693d28c18807a1cf7e9fca92a21fb361a21343` = `FLY-2655: recover Discord voice receive path (#1243)`，合入 2026-09-22 09:21:34 PT |
| 宿主工作区 | `git status --porcelain` 空（干净，无本地改动） |
| dist 构建时间 | `packages/voice-codex/dist/cli.js` 与 `packages/voice-bridge/dist/bots/discordWiring.js` 均为 2026-09-22 12:01 |
| 只存在于修复后的产物 | `packages/voice-codex/dist/receive-health.js`、`packages/voice-core/dist/receive-health.js` 均存在（mtime 12:01） |

时序闭合：09:21 合入 → 12:01 构建 → 12:02 进程启动。构建晚于合入、进程晚于构建，且工作区干净。因此 PID 54933 加载的就是修复后的字节。

> 注：工单说「随 12:24 PT 班车部署」。进程实际起于 12:02 PT，比 12:24 早 22 分钟；但它加载的 HEAD 已经包含 #1243，结论不受影响。

## B. 守护进程健康 ✅

`/tmp/flywheel-voice.log` 最新心跳（2026-09-23T02:45:30Z = 19:45 PT）：

```
mode=idle  successCount=16057  failureCount=23  failureStreak=0
bootId=60396682-8c3e-4867-a0e6-fffe73d86444  generation=2
```

一直在 poll `desired` 会话 —— 也就是一旦有人要开语音，它立刻接得住。

02:41–02:43Z 有 3 次 `bridge_timeout_headers`（operation=desired），随后立刻 `event=recovered`，failureStreak 归零。是瞬时抖动，不是故障。

## C. 探针①：耳朵和嘴的后端（OpenAI Realtime）连得上、有额度 ✅

用生产 `OPENAI_API_KEY`、走代码里同一个 `createRealtimeSocket()` 打开同一个 endpoint，**只握手、不发任何音频、收到 session.created 立即关闭**。零 Discord 噪声。

```json
{
  "probe": "openai_realtime_handshake",
  "startedAt": "2026-09-23T02:48:49.912Z",
  "url": "wss://api.openai.com/v1/realtime?model=gpt-realtime-1.5",
  "socketOpenAt": "2026-09-23T02:48:51.480Z",
  "ok": true,
  "event": "session.created",
  "model": "gpt-realtime-1.5",
  "sessionId": "sess_ER7KNvvo4FJVHaCmLUlQP",
  "endedAt": "2026-09-23T02:48:51.485Z"
}
```

1.6 秒建连。key 有效、模型可用、额度没被挡。

这一条**不**证明真实音频收发正常 —— 它只证明连接、鉴权、模型这三层是通的。

## D. Discord 侧：bot 进得去、说得出 ✅

用 `RAYA_BOT_TOKEN` 做只读 GET（`/users/@me`、`/channels/{vc}`、`/guilds/{g}`、`/guilds/{g}/members/{bot}`），按 `preflightVoiceSession` 同样的角色 + 频道覆写算法算权限。

| 项 | 观测 |
|---|---|
| bot 身份 | id `1542068543645024257`，username `Raya`，与 `projects.json` 的 `botUserId` 一致 |
| 语音房 | `claude's server` / `#General`，channel id `1485787273193853170`，type=2（语音），`user_limit=0`（不限人数） |
| VIEW_CHANNEL | ✅ |
| CONNECT | ✅ |
| SPEAK | ✅ |
| USE_VAD | ✅ |
| SEND_MESSAGES / CREATE_PUBLIC_THREADS | ✅ / ✅ |
| 当前房内 | 空（founder 与 raya 的 `GET /guilds/{g}/voice-states/{user}` 均 404 Unknown Voice State） |

另外：`~/.flywheel/projects.json` 里 **raya 是唯一 `voiceModes.rg = true` 的 Lead**，其余 16 个 Lead 全是 `rg: false`（只有会议模式）。所以「随身语音」目前只有 Raya 一个人能陪。所有 project 共用同一个语音房 `#General`。

## E. 探针②：脑子（raya 的 Codex 号）— 能出回复，但周额度在红线上 ⚠️

隔离读法：只读 `~/.codex-raya` 下的文件和 `logs_2.sqlite`（`mode=ro`），没有切换任何 profile，没有往 #raya 发消息。

**身份**
- raya 的 CODEX_HOME = `~/.codex-raya`（`~/.flywheel/codex-quota/approved-homes.json` 里登记为 `raya/raya`，ownership=managed）
- `~/.codex-raya/auth.json` 是 `~/.codex/auth.json` 的**符号链接**（共享全局凭据）
- 号 = `xrliannie@gmail.com`（profile 名 `personal`），plan = **ChatGPT Pro**，`auth_mode` = Chatgpt
- 凭据文件最后写入 **2026-09-22 16:51 PT** —— 正是 founder 说的「16:51 personal 恢复」那一刻

**最近一次成功回复**
`~/.codex-raya/logs_2.sqlite` 里 raya 自己的 app-server 事件：

```
2026-09-22 19:49:12 PT   app-server event: turn/completed
2026-09-22 19:40:57 PT   app-server event: turn/completed
2026-09-22 17:03:46 PT   app-server event: turn/completed
```

16:51 PT 之后**没有任何** 429 / usage-limit / rate-limit-reached。最新一条 `auth_header_attached=true auth_mode="Chatgpt"` 在 19:49:57 PT。

**额度：满的，没有矛盾**

`~/.flywheel/codex-quota/codex-accounts.json`：personal 的 weekly `resetAt` =
`2026-09-22T23:50:42Z` = **16:50:42 PT** —— 与凭据文件 16:51 PT 的写入时间吻合。
也就是说 Codex personal 的周额度在 16:50 PT 刚刚重置，现在是满的。所以 19:49 PT
还能出 turn 完全正常。

> **勘误（Lead 2026-09-23 02:59Z 纠正）**：我起初把 `~/.flywheel/logs/quota-monitor.log`
> 里 19:20 PT「personal 周用量 100% → 切到 school」当成 raya 的 Codex 号快挂了，
> 并作为「矛盾观测」并列记下。那条线是 **Claude** 账号的配额监控，不是 Codex，
> 跟 raya 的 Codex 号无关。报告和本文件都已改正。
> 教训：`quota-monitor` 与 `codex-quota/` 是两套不同的账，profile 名（personal/school）
> 撞名，很容易串线；下次看到 personal 的两个相反读数，先确认是哪条线的账本。

**「想」一次要多久（实测，但不是语音口径）**

`~/.codex-raya/logs_2.sqlite` 里 16:51 PT 恢复之后的 `turn/started` → `turn/completed` 配对：

| 开始 | 结束 | 耗时 |
|---|---|---|
| 16:58:31 | 16:58:41 | 10 秒 |
| 17:03:09 | 17:03:46 | 37 秒 |
| 19:40:46 | 19:40:57 | 11 秒 |
| 19:47:46 | 19:49:12 | 86 秒 |

**这四条是她做工程任务的长 turn（带工具调用），不是对话轮次。**语音对话的 prompt
短得多，理应快不少，但我**没有任何语音口径的实测数，不做外推**。报告里也是这么写的。

## F. 工单前提修正

工单写「语音的『脑子』走 Codex」。源码不是这样：

| 环节 | 实际走哪 | 源码 |
|---|---|---|
| 耳朵 + 嘴（听、断句、出声） | `OPENAI_API_KEY` 直连 `gpt-realtime-1.5` 平台 API | `voice-codex/src/config.ts:119`、`realtime-transport.ts:3` |
| 脑子（答什么内容） | raya 作为 Codex Lead，走 ChatGPT 订阅 | `~/.codex-raya` |

所以 **Codex 打满只影响她说什么，不影响她能不能听见你、能不能出声**。表现会是「她在房里、但沉默或答得敷衍」，而不是「电话打不通」。

## G. 没做的事（明确记下来，不假装做了）

- 没有开任何生产语音会话 —— 原因见 exploration.md（结构性封锁 + 会打扰 founder），Lead 裁决为不做。
- 因此 **`voice_sessions` 表里仍然只有 9-16 那一行**（session `5142f2ab-16ed-48f6-bef5-c08d3740dd23`，failed，reason `discord_audio:Failed to decrypt: DecryptionFailed(UnencryptedWhenPassthroughDisabled)`）。部署后没有任何真实会话记录，这一点没有改变。
- 因此 **FLY-2655 修的那个解密失败，本次没有得到真实音频的验证**。只验证了修复代码在跑。
- **更重要的一条（Lead 指令 e5e8e486）**：FLY-2655 的 QA（9-22 03:24–04:00Z）只打通了
  「嗓子 + 耳朵」——入房、听到、出声。「脑子」那一段当时因 Codex 打满没能跑，
  QA 是**手打句子代替**的。所以「听 → Codex 想 → 说」这条完整链路
  **至今没有在生产上端到端跑通过一次**，本次同样没有（原因同上，必须 founder 在房）。
  这才是本次上线真正悬空的那一半：不是「能不能出声」，而是「答的内容跟说的话对不对得上」。
  报告已按此重写：verdict 改成 amber、新增「从没验过」红卡、第 5 步改成一句
  必须听懂才能答对的三词复述测试，并明确「出声但内容对不上 = 算失败，要记下来」。
- 没有跑隔离槽端到端（Lead 裁决 C 不做）。
- 没有改 `voice-host.json`、没有切 Codex profile、没有重启任何服务、没有往任何 Discord 频道发消息。
