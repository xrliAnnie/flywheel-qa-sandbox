# FLY-2031 Founder 真机 R1 — 部分验收证据
Issue: FLY-2031 (https://linear.app/geoforge3d/issue/FLY-2031/rayav3-%E9%9A%8F%E8%BA%AB%E8%AF%AD%E9%9F%B3b%E5%B8%B8%E5%BC%80%E6%B5%81-%E5%BF%B5%E8%AF%BB%E7%AD%9B%E9%80%89-%E7%94%A8%E5%98%B4%E6%89%B9-ship)
日期: 2026-08-29
基于: founder-round-runbook.md

## 结论

本轮在真实 Discord `voice-test-2` 里完成了真人声、念读顺序、主动打破沉默与常开流计数验证。Founder 于 `2026-08-29T16:12:29Z` 离房，进程按 `last-human-left` exit `0`；筛选、偏好、relay / readback / P2 / forged-speech 与非生产 ship 均未运行，不能计为通过。

## 场次边界

- 被错误 kickstart 的旧 `rounds/independent` definition 不计入本轮。它已先被 host bootout，误写的 independent `voice-mode.requested` 随后用 contracts API 清除。
- 正式 launchd definition：`com.xrli.raya.voice.fly2031.founder.plist`；`RAYA_STATE_DIR=rounds/founder-20260829-r1/state`。
- 正式 boot：`402666ff-17bf-43ce-85a3-74f152677bfd`；started `2026-08-29T16:10:17.077Z`。
- 正式进程 PID：`77255`；场后 launchd `not running`，last exit `0`。
- 原始证据根：`~/.flywheel/raya/qa/FLY-2031/rounds/founder-20260829-r1`。

## 已通过

1. **实际界面与真人归属**：`2026-08-29T16:12:11.064Z` 收到 user final，`speakerUserId=1138241636057481306`，Annie 原话为「那你阿姨就在那说什么报个平安呀。」；`2026-08-29T16:12:13.435Z` 收到同 connection / session / generation 的 assistant final。此前系统念读不标成 Annie 原话。
2. **念读优先级与正文**：依次出现 decision `A4201`、decision `B4202`，再出现 report `C4203`、`D4204`、`E4205`、`F4206`；六条均有对应 assistant final 和同 boot `spoken` ack。
3. **主动打破沉默**：首个 `liveness_triggered` 为 `2026-08-29T16:11:32.445Z`，随后有 assistant final；本轮使用的 `10s` 只属于 QA 配置，不是产品默认标准。
4. **常开流**：最终 `audio_counters` 为 `silence=2734`、`voice=3890`、`sent=3986`、`dropped:closed=2`、`player-idle-recovered=1`。无语音时仍持续发送静音包，`sent` 覆盖 voice 与 silence 两类帧。
5. **干净退出**：`voice_exit{code:0,reason:"last-human-left"}`，随后写出最终 audio counters；`voice-session.json` 的 active run 已清空。

## 未运行

- `remember_filter` 的 state receipt、`#raya` bot 文字收据、重启后命中 item 的 `filtered` ack 与正文不进入 transcript。
- 口头偏好修改及权威 receipt。
- `Tadashi · FLY-1833` 动手前念读、relay 阳性、错号、P2、forged-speech 阴性。
- 测试卡 `1542771440460365875` 的非生产 ship gate、Founder 单独确认、3 GET + 1 POST 与 `written=true`。

## 原始证据指纹

| 文件 | 行数 | SHA-256 |
|---|---:|---|
| `state/voice-evidence/events.jsonl` | 34 | `38d884b60598d19721ee4808c579a053c933c5b00c83886b935229c08dcb4d94` |
| `state/voice-inbox/acks.jsonl` | 6 | `97c0862759dc66228f5dc9449b65250b4b899b846c65880adb7069236a764261` |
| `state/voice-session.json` | n/a | `4b346dfe05b78d75cd784f0eb7b9daa5f573a18d19518188d00f08c17e513b01` |

这些哈希冻结在 Founder 离房后的首次场后采集点；后续续场必须使用新的 evidence 文件或在 before / after manifest 中记录追加边界，不得覆盖本轮原件。
