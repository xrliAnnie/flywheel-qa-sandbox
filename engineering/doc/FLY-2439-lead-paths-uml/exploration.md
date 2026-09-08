# FLY-2439 Lead 通路现状 UML — 探索

Issue: FLY-2439 (https://linear.app/geoforge3d/issue/FLY-2439/通路实证-lead-通路现状-umlclaude-lead-codex-lead-raya-文字-raya-语音-逐箭头-fileline)
日期: 2026-09-08
基于: 无

## 1. 这张单要回答什么

founder 2026-09-08 02:48–03:03Z 在 FLY-2379 thread 里下的直令，本质是四个**事实性**问题，不是设计问题：

1. Discord 消息进到每个 Lead 的大脑，中间到底经过哪些进程？Bridge 在不在这条路上？
2. Claude Lead 用「一个 JSON file」，Codex Lead「用一种更不一样的方法」——具体是什么？
3. Raya 文字通路和 Codex Lead 通路的区别是什么？为什么 Raya 会有特殊处理？
4. Raya 语音会议进行中，她要和别人交流 / 做别的事，走哪条路？现在能不能？

founder 明确禁止猜测：「你必须很仔细地把代码看一遍，把实际的情况告诉我，而不是告诉我一个你猜想的情况。」

## 2. 交付边界（本单不做的事）

- **零代码改动**。本单只产出文档。
- **不提方案**。最后一节只陈述「现状 vs founder 期望」的差距，不写怎么改。
- 不碰生产 raya checkout（`~/.flywheel/raya/code` 只读）；PR #26 通过 scratchpad 只读克隆读取。

## 3. 四条通路与取证锚点

| 通路 | 代表体 | 代码来源 |
|---|---|---|
| A Claude Lead | `flywheel-eng-lead` | flywheel 主仓 `packages/teamlead`, `packages/flywheel-comm`, `packages/agent-team-transport` + `~/.claude/plugins/cache/` 里实际运行的插件字节 |
| B Codex Lead | `mufasa-lead` | flywheel 主仓 `packages/teamlead/src/lead-backends/codex/` + `scripts/run-codex-lead-*.sh` |
| C Raya 文字 | raya PR #26 分支 `fly-2379-raya-text-chat` | `apps/brain/src/text-chat/*` |
| D Raya 语音 | raya main `b1b5a64` | `apps/voice/*` |

## 4. 已知的关键汇合点（探索阶段先手确认）

四条通路里，A 与 B 的**唯一共同汇合点**是 flywheel-comm 的统一信箱写入：

- `packages/flywheel-comm/src/index.ts:270` — CLI 子命令 `chat-ingest` 分发
- `packages/flywheel-comm/src/discord-chat-ingest.ts:114` — `queue.claimDiscordLane({ ... })`
- `packages/flywheel-comm/src/discord-chat-ingest.ts:127` — `carrier: "inbox"`

写完队列行之后对 Bridge 的调用是**门铃，不是数据通路**——代码注释自己写明了：

- `packages/flywheel-comm/src/lead-inbox-nudge.ts:34-36` —
  「The queue row is the authority; this request only shortens the next adaptive poll interval.」
- `packages/flywheel-comm/src/lead-inbox-nudge.ts:56` — `POST ${bridgeUrl}/api/lead-inbox/nudge`
- `packages/flywheel-comm/src/index.ts:781-789` — 只在 `result.lane === "inserted_inbox"` 时才敲门铃；
  且 `bridgeUrl` 为空时 `lead-inbox-nudge.ts:41-42` 直接 return。

⇒ 这一条已经和 founder 的心智模型（「Discord 先进 Bridge，然后 Bridge 再进 Codex」）不一致，
需要在 research 阶段逐条落实到每条通路上。

## 5. 取证纪律

- 每一个箭头必须带 `path:line`，行号用 `grep -n` / `sed -n` 复核过。
- 找不到的写「未在代码中找到 / 未验证」，不写推测。
- Raya 语音的行号引自 `b1b5a64` 的 blob（`git show b1b5a64:<path>`），不引工作树。
