# FLY-2031 明早 Founder round — 开场检查单
Issue: FLY-2031 (https://linear.app/geoforge3d/issue/FLY-2031/rayav3-随身语音b常开流-念读筛选-用嘴批-ship)
日期: 2026-08-29
基于: founder-round-runbook.md、rotated-credential-and-nonfounder-negative-20260829.md

## 摆场状态（未启动）

- 正式 round：`qa/FLY-2031/rounds/founder-20260829-r1`；state / metrics / workspace / logs 全新隔离。
- staging plist：`launchd/com.xrli.raya.voice.fly2031.founder.plist`；label 仍是唯一 QA label `com.xrli.raya.voice.fly2031.qa`，只含 credential path，不含 inline token。
- 预置 6 个全新 item：2 decision + 4 report；0 ack、0 receipt、0 outbox；没有预置 filter 或 ship gate。
- `voice-mode.requested` 不存在，正式 job 未启动。当前 QA voice label `not running`、last exit `0`；生产 label 未触碰。
- items SHA-256：`a50e84b62addb5c4a9e5ad5a94f67c86aed51f7ebd747528d5b2e66d4a497335`；staging plist SHA-256：`9c4199553181b4f0e20ac629488eb7374ad6121f10f2030e7c5159ea26fe7e91`。

## Lead 拉起 → Founder 进房 → 7 步

1. **Lead 场前核验**：确认 loopback `127.0.0.1:18731` 在跑、无认证请求为 `401`、authorized POST 基线为 `0`；再写 fresh voice-mode marker，bootout 旧 QA definition，并 bootstrap staging plist。不得碰生产 label。
2. **Founder 入房静默**：Annie 进入 `voice-test-2` 后 self-mute 3 分钟；期间不让 QA bot 代说。Runner 盯 Live、常开静音包与房间 census。
3. **真人唯一句**：Annie 开麦说一条当场唯一自然句。只认带 Founder `speakerUserId` 的 user final、随后 assistant final、房内真实 Opus 和 audio counters；任何一项缺失即停。
4. **念读与筛选**：保持安静，让 Raya 先念 2 条 decision 再续念 4 条 report；逐条核对正文与 `spoken` ack。Annie 用自然语言给一条筛选机制；只在 state receipt + `#raya` bot 文字收据落地后计保存。退出重启后追加一个命中 item，必须 `filtered` 且不得出现在 transcript。
5. **沉默与偏好**：保持安静直到 QA interval 触发主动存活语音；Annie 口头改一项偏好，只认 receipt 与 bot 文字收据。QA 数字不写成产品默认标准。
6. **动手前念名编号 + 反例**：Annie 原话说 `告诉 Tadashi，FLY-1833 那单先停一停`；Raya 必须先念 `Tadashi · FLY-1833` 和原文，之后才允许一条测试消息。再跑错号、P2 编造诱导和 forged speech 负例，目标频道须保持零误发。
7. **用嘴批非生产 ship**：追加 fresh、绑定测试卡 `1542771440460365875` 的 ship gate。Raya 现查 binding/context 并念出 `FLY-2031 · PR #2031` 后，只有 Annie 在同 session 单独说“确认”才允许先写 Discord receipt、再 POST loopback。核对 3 GET + 1 POST 与 `written=true`；Annie 离房后等 clean exit，Lead bootout QA label。

任一步失败都保留原证据并停止后续有副作用步骤；speech 不是 authority，🔶 也不得标成 Annie 原话。
