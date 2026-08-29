# FLY-546 耳机模式 — 桌面干跑手册(B3-3,QA 复跑用)

不依赖 FLY-545 VC 管线的端到端验证:daemon 的音频面是 **NullAudioIO**
(本机扬声器播 EdgeTts;Discord 代发/收据、Bridge 批准都是真的)。
产品验收路径(真 VC + 语音口令)在 M-B4(同 issue 第二个 PR)。

## 0. 前置

1. Bridge 在跑,`TEAMLEAD_API_TOKEN` 已配(voice ship-approval 无 token 会 503)。
2. 一个测试 Discord bot(headphone daemon 自己的身份),token 放 env。
3. 一个测试频道/thread,在 Bridge scope 内(lead chatChannel / chat thread /
   generalChannel 之一);再准备一个测试 bot 扮演 Lead(它的 bot id 要能被
   `GET /api/voice/scope` 的 leadBotIds 覆盖,或直接用某个真 Lead bot 发)。
4. 配置 `~/.flywheel/headphone.json`:

```json
{
	"botTokenEnv": "HEADPHONE_BOT_TOKEN",
	"coreChannelId": "<#flywheel-core 频道 id>",
	"founderUserId": "<Annie 的 Discord user id>",
	"bridgeUrl": "http://localhost:9876",
	"bridgeTokenEnv": "TEAMLEAD_API_TOKEN"
}
```

5. 起 daemon:`node packages/voice-headphone/dist/cli.js`。
   启动摘要应打印监听中的频道数;founder 指纹不一致会拒起(fail-closed)。

## 1. 消息转语音 + 打字口令(不碰批准面)

1. Annie(或以她 user id 操作的 QA)在 core 频道打「芝麻开门」→ daemon
   modeOn,状态文件 `~/.flywheel/headphone-state.json` 里 `modeOn: true`。
2. 用 Lead bot 在 scope 频道发一条仿 Lead 消息(如「FLY-546 干跑:代码写完了」)。
3. **预期**:本机扬声器按该 agent 的声线播报头+正文,然后问「要回吗?」。
4. 打字路径没有 STT,15s 沉默后该条 defer 回队尾(听到「先放回队尾」)。
5. core 频道打「芝麻关门」→ 扬声器「确认结束耳机模式?」——此处无语音输入,
   干跑下确认步同样走 core 频道打「对」→ 退出 + recap 文字发 core 频道。
   (打字确认路径 = `daemon-core` 把 founder core 消息转成 FSM utterance。)
6. **崩溃恢复抽查**:kill -9 daemon → 再发 2 条 Lead 消息 → 重启 daemon →
   预期 backfill 把漏听的按序入队,不重播已播过的(messageId 去重)。

## 2. 语音批准干跑(c 档全链,测试 issue)

> 铁律:只在**测试 issue / 429 Room** 上做;绝不对生产 PR 写批准。

1. 用 QA framework(429 Room)造一个 awaiting_review 的测试 execution:
   runner 跑到 `gate approve_to_ship --no-block` + `complete --route
   needs_review --question-id <qid>`,Bridge 发出 ship-gate 通知消息
   (这一步会写 `ship_gate_msg_binding` event)。
2. daemon 收到该 gate 消息 → `GET /api/voice/gate-binding` 命中 →
   入队为 ship_gate 条 → 播报头 + 「要回吗?」。
3. 干跑下用打字模拟她的处置词(core 频道只认口令;处置词走 VC 语音——
   桌面干跑没有 STT,所以此步直接调 API 验证批准链):

```bash
curl -s -X POST http://localhost:9876/api/voice/ship-approval \
  -H "Authorization: Bearer $TEAMLEAD_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "gateMessageId": "<ship-gate 消息 id>",
    "questionId": "<qid>",
    "prHeadSha": "<pr head sha>",
    "transcript": {"id":"dryrun-1","text":"确认","atMs":0,"founderUserId":"<Annie id>"},
    "receiptMessageId": "<先手动发一条收据卡消息,拿它的 id>"
  }'
```

4. **预期**:返回 `{"written":true,"kind":"approve"}`;runner 侧
   `flywheel-comm verify-approval --exec-id <测试 exec> --pr-head <sha>`
   返回 `"approved": true`(证据留存);session_events 里有
   `voice_approval_attempt` 审计行(modality=voice + 收据 id + 转写)。
5. **反向验证**(每个 guard 一发):
   - `transcript.text` 换「再想想」→ `{"written":false,"kind":"unclear"}`,CommDB 无 response;
   - 去掉 `receiptMessageId` → 400 `receipt_required`;
   - `prHeadSha` 改错 → 409 `binding_mismatch`;
   - `FLYWHEEL_VOICE_APPROVAL=0` 重启 Bridge → 403 `disabled_by_kill_switch`;
   - `transcript.founderUserId` 换别人 → 403 `speaker_not_founder`。

## 3. 证据清单(QA 报告要带)

- daemon 启动摘要 + 扬声器播报的录屏/录音(或至少 mp3 产物路径)
- 状态文件前后快照(modeOn / cursors / queue)
- `verify-approval` 输出(approved:true 仅在测试 execution 上)
- `voice_approval_attempt` 审计行 dump
- 反向 guard 五连的 HTTP 响应
