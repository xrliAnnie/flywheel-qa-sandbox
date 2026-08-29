# FLY-960 evidence — A-4 稳定轮(判据③)

日期: 2026-07-07
窗口: 16:29:46Z(ears READY) → 16:43:46Z = **14 分钟**(> 10min 要求)
路径: A(@discordjs/voice 0.19.2 耳朵 bot,强制 DAVE E2EE)

## 通过判定汇总(plan Step 2.6 四条)

| 通过定义 | 结果 |
|----------|------|
| ①每个 loop 都有 capture 文件 + 抽测 transcript 关键词 ≥80% | ✅ 24 个连续 loop 全部产 capture;首(16:29:56)尾(16:43:07)两个 loop 抽测 5 句关键词全中 |
| ②扰动后 ≤2 个 loop 内恢复捕获 | ✅ 受控 rejoin 后同一 loop 内(≤1)即续录 |
| ③`[capture-error]` = 0 或逐条可解释 | ✅ 仅 1 条 = 受控 destroy 那刻的 `Premature close`(预期,非真失败) |
| ④`[state]` 日志能对上扰动 | ✅ 三次扰动全部在日志留痕(见下) |

**判据③ = PASS。**

## Loop 时间线(sender 音源,每 loop = 5 句参考音 ~35s + 3s 静默)

| 时刻(Z) | capture 时长 | 备注 |
|----------|--------------|------|
| 16:29:56 | 35.0s | 稳定轮首个完整 loop |
| 16:30:34 → 16:33:07 | 35.0s ×5 | 连续正常 |
| 16:33:46 | 26.4s | 受控 rejoin 逼近,尾部被截 |
| **16:34:12** | — | **扰动1:SIGUSR1 → ears 受控 destroy**(`[capture-error] Premature close` 出现于此刻,在途流被 abort) |
| **16:34:18** | — | **ears READY(重连完成,gap ≈ 5.6s)** |
| 16:34:18 | 2.9s | rejoin 后即刻续录(同 loop 内恢复) |
| 16:34:24 → 16:37:37 | 35.0s ×6 | 连续正常 |
| **16:38:12/16:38:33** | — | **扰动2:嘴巴 bot 退出+重进(成员变动 → MLS epoch 轮换)**;ears 全程无 state 变化、不掉线 |
| 16:38:38 | 34.9s | 嘴巴 bot 一回来立即续录 |
| 16:39:17 → 16:43:07 | 35.0s ×7 | 连续正常 |
| 16:43:46 | 19.1s | 窗口结束、sender 停 |

**外加真实扰动(未计划,更贴产品)**:Annie 真人客户端全程在场、期间进出+说话,构成额外多次 MLS epoch churn;她的人声被连续 per-speaker 捕获(见 `../a-5-annie-realvoice/`)。

## 抽测 transcript(首尾对照,证明 13 分钟无退化)

- `sender-loop-start.txt`(16:29:56):5 句关键词全中(smoke test / PR·CI·ship / latency·800毫秒 / fallback / work tree·TDD)
- `sender-loop-end.txt`(16:43:07,13 分钟后):同样 5 句关键词全中

zh-TTS 对英文专名的发音误听(voice bridge→WestBridge、Tadashi→TaiC/tree、TDD→PDD)首尾一致,是 STT+TTS 固有上限、非收音链路损伤——与 STT 基线校准(00-env.md)吻合。

## DAVE 真在场(判据⑤,2/3 件)

- `a-dave-proof.jsonl`:`{"type":"session_description","dave_protocol_version":1,"mode":"aead_aes256_gcm_rtpsize"}` —— **protocol version = 1 > 0** ✓
- `a-debug-extract.txt`:davey MLS 会话日志全链(secret 已 redact,`*.log` 被根 .gitignore 排除故存 `.txt`)✓
  - `[DAVE] Session initialized for protocol version 1`
  - `[DAVE] Set MLS external sender`
  - `[DAVE] MLS proposals processed`
  - `[DAVE] MLS commit processed (transition id: 0)`
  - (成员进出时)op11 ClientsConnect / op13 ClientDisconnect → epoch churn
- **第 3 件 = Annie 的 Discord 客户端 E2EE 加密标识截图**(待她发 thread,收尾)

## 与 FLY-545 的实现约束(选型 A 原始数据)

1. **per-speaker 形态**:`receiver.subscribe(userId)` 天然按 SSRC→user 分轨;每个说话人一个独立 opus 流;VAD 抖动会把同一人切成多段文件(去重后每人每次连续发声一段),FLY-545 bridge 需按 user id 聚合。
2. **重连/续命行为**:受控 destroy+rejoin ≈5.6s 恢复;成员变动(MLS epoch)不影响已连接 receiver;`entersState(Ready, 15s)` 足够。FLY-545 的 session 重建可复用这套。
3. **依赖 pin**:@discordjs/voice 0.19.2 + @snazzah/davey 0.1.12;opus 解码用 prism.opus.Decoder(opusscript 纯 JS 兜底,无需原生 @discordjs/opus)。
4. **已知残余风险**:audio receive 非 Discord 官方文档化(evergreen 运维预算,非本 spike gate)。
