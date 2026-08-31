# FLY-2031 R2 无 Founder 念读自检 — 三绿
Issue: FLY-2031 (https://linear.app/geoforge3d/issue/FLY-2031/rayav3-随身语音b常开流-念读筛选-用嘴批-ship)
日期: 2026-08-29
基于: founder-round-failed-20260828.md

## 结论

在 `voice-test-2` 的实际 Discord 语音界面，以 allowlisted QA bot 作为 self-muted listener、房内无 Founder，Raya 对全新 item 的**完整正文、房内 Opus、权威 `spoken` ack 三项同时通过**。本轮只证明无 Founder 可完成的念读机制，不替代 Founder 真声验收。

## 最终通过轮

- Source head: `5c9cfd0`（运行时 dist 与该 source 等价；commit 在证据收齐后立即落盘）。
- QA state: `qa/FLY-2031/rounds/r2/state`；生产 state / label 未触碰。
- Item id: `r2-selfcheck-20260829-natural-7421`。
- Item 正文: `FLY-2031 的念读链路已经修复，校验词是青铜猫头鹰七四二一。`
- Room census: Founder-free；listener 全程 self-muted。
- Assistant final `2026-08-29T07:19:13.878Z` 完整包含正文。
- `spoken` ack `2026-08-29T07:19:13.881Z`，只比 assistant final 晚 3 ms。
- Listener: `274` Raya Opus packets、`25,172` bytes、`1` speaking start。
- Listener 离房后唯一 QA label exit `0`；最终 `not running`。

## 失败先例保留

1. 第一次 listener 与 host 的旧实例→R2 reload 窗口相撞；R2 只留下 `voice_exit: sigterm`，没有正文，判 instrumentation collision，不计产品结果。
2. 第二次有效轮听到 canary（285 packets），但模型省略 `FLY-2031`、`自检正文` 和 transport label；严格 ack 未落，判 partial fail。
3. 把 transport label / “还有 N 条”从权威确认中剥离，仅按每个 chunk 与 `item.text` 的实际重叠正文确认；旧 awkward selfcheck 用合法 `expired` ack 退役，未伪造 `spoken`。
4. 新自然正文随后获得三绿。泛回应、部分正文、intervening user final 都不能写 `spoken` ack。

## 脱敏文件指纹

| 文件 | 行数 | SHA-256 |
|---|---:|---|
| `voice-inbox/items.jsonl` | 2 | `59672c6dd691f93d4e7c6e619bed6b10d7a409cce83bd1409e000b344cd05900` |
| `voice-inbox/acks.jsonl` | 2 | `5cb4289a85de193de168bf9c01455133bdd9c09326ea9b8b2f58b66fa4a9d703` |
| `voice-evidence/events.jsonl` | 54 | `5e1c21c43832ecee3ad567592b34b185ffdd74c01e652b7a3a13550a4558c2fe` |

凭证内容、bot token、原始音频均未入仓。
