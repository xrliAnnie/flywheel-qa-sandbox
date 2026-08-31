# FLY-2031 QA emitter — 实施计划
Issue: FLY-2031 (https://linear.app/geoforge3d/issue/FLY-2031/rayav3-随身语音b常开流-念读筛选-用嘴批-ship)
日期: 2026-08-27
基于: plan.md、c9-evidence.md、Lead gate `6637f9fb-0900-4a1e-9ae5-b5f1a63af31b`

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Lead 明确授权的 Tadashi bot (`1516207680836866219`) 在真实 `voice-test-2` 完成可重复 QA 轮：self-mute 180 秒后播放固定 TTS，并以 Raya transcript、audio counters 与 emitter 收到的 Raya Opus 包证明链路。

**Architecture:** 新增一个 repo-local probe；纯函数层负责参数校验、顺序编排与脱敏 evidence，Discord adapter 层负责登录、voice connect/rejoin、播放与接收 Opus。bot token 只从 owner-private `.env` 读入内存，不复制到 QA env、plist、日志或仓库。产品 runtime 不改；plist 只新增一个 QA allow ID。

**Tech Stack:** Node.js ESM、`discord.js`、`@discordjs/voice`、macOS `say`、系统 `ffmpeg`、Node test runner。

---

### Task 1: 可测的 emitter 编排合同

**Files:**
- Create: `probes/c9-voice-emitter-lib.mjs`
- Create: `probes/c9-voice-emitter.test.mjs`

- [ ] **Step 1: 写 RED test**

测试 fake adapter 的严格调用顺序：`connect(selfMute=true)` → 等待 `180000` → `setSelfMute(false)` → `play(audioFile)` → `waitForRayaAudio(rayaBotId, timeout)` → `destroy()`；结果只有 `packets > 0` 才通过。另测 Discord ID、绝对路径、正整数和 `.env` 中唯一 `DISCORD_BOT_TOKEN` 的 fail-closed 解析。

```js
const result = await runEmitter(config, {
	connect: async ({ selfMute }) => {
		calls.push(["connect", selfMute]);
		return fakeConnection;
	},
	delay: async (ms) => calls.push(["delay", ms]),
});
assert.equal(result.rayaOpusPackets, 3);
assert.deepEqual(calls.slice(0, 4), [
	["connect", true],
	["delay", 180_000],
	["setSelfMute", false],
	["play", audioFile],
]);
```

- [ ] **Step 2: 运行 RED**

Run: `node --test probes/c9-voice-emitter.test.mjs`

Expected: FAIL，因为 `c9-voice-emitter-lib.mjs` 尚不存在。

- [ ] **Step 3: 写最小实现**

导出：

```js
export function parseEmitterArgs(args) {}
export function loadBotToken(path) {}
export async function runEmitter(config, dependencies) {}
export function appendEmitterEvidence(path, event) {}
```

`runEmitter` 用 `try/finally` 保证 destroy；evidence 只记 bot/user/channel id、时间、self-mute 边界、audio 文件 sha256、packet/byte 计数与失败 code，禁止接收或记录 token 参数。

- [ ] **Step 4: 运行 GREEN + lint**

Run: `node --test probes/c9-voice-emitter.test.mjs`

Expected: 所有 emitter tests PASS。

Run: `pnpm exec biome check probes/c9-voice-emitter-lib.mjs probes/c9-voice-emitter.test.mjs`

Expected: no errors。

### Task 2: 真实 Discord adapter 与 CLI

**Files:**
- Create: `probes/c9-voice-emitter.mjs`
- Modify: `probes/c9-voice-emitter.test.mjs`

- [ ] **Step 1: 补 RED test**

对 CLI 参数与安全输出加测试：stdout 只能包含 `ready/result` 摘要；错误信息和 JSONL 都不得包含 `.env` 中 token。

- [ ] **Step 2: 实现 adapter**

`Client` intents 仅 `Guilds` + `GuildVoiceStates`；`joinVoiceChannel({selfMute:true,selfDeaf:false,group:"fly2031-c9-emitter"})`；180 秒后 `rejoin({selfMute:false,selfDeaf:false})`；`createAudioPlayer` 播放 `createAudioResource(audioFile)`；播放结束后继续留房 5 秒，让 Realtime STT final 落盘，再验 receiver 结果并退出。receiver 只订阅 Raya bot id，且 arming 时立即 subscribe（常开流的 speaking edge 可能早已发生），记录 Opus packet/byte，不保存音频内容。任何 login/connect/play/zero-packet/timeout 都退出非零并归档失败 evidence。

- [ ] **Step 3: 运行 probe tests**

Run: `node --test probes/c9-voice-emitter.test.mjs`

Expected: PASS。

Run: `pnpm lint`

Expected: whole-repo PASS。

- [ ] **Step 4: commit probe**

```sh
git add probes/c9-voice-emitter-lib.mjs probes/c9-voice-emitter.mjs probes/c9-voice-emitter.test.mjs engineering/doc/FLY-2031-raya-mobile-voice/c9-emitter-plan.md
git commit -m "test(voice): add real C9 QA emitter probe"
```

### Task 3: QA-only 配置与真实运行

**Files:**
- Modify outside repo: `~/.flywheel/raya/qa/FLY-2031/launchd/com.xrli.raya.voice.plist`
- Create outside repo: `~/.flywheel/raya/qa/FLY-2031/emitter.aiff`
- Create outside repo: `~/.flywheel/raya/qa/FLY-2031/emitter-evidence.jsonl`
- Modify outside repo: `~/.flywheel/raya/qa/FLY-2031/state/voice-mode.requested`

- [ ] **Step 1: 生成固定 TTS 并自检**

```sh
/usr/bin/say -o ~/.flywheel/raya/qa/FLY-2031/emitter.aiff --data-format=LEI16@48000 \
  "Raya，FLY-2031 QA 常开流三分钟静默已经结束。请回复：收到 FLY-2031。"
/usr/local/bin/ffmpeg -v error -i ~/.flywheel/raya/qa/FLY-2031/emitter.aiff -f null -
```

- [ ] **Step 2: 只配置 QA label**

写入 `RAYA_VOICE_QA_ALLOW_USER_IDS_JSON=["1516207680836866219"]`；生产 plist/env 不改。用 contracts `requestVoiceMode` 在 QA state 写 marker。向 Lead 报告 ready，请他只对 `com.xrli.raya.voice.fly2031.qa` 做 host bootout/bootstrap。

- [ ] **Step 3: 确认 QA runtime running 后启动 emitter**

```sh
node probes/c9-voice-emitter.mjs \
  --bot-env /Users/xiaorongli/.flywheel/qa-fly684-cfg/channels/discord-flywheel-eng-lead/.env \
  --bot-id 1516207680836866219 \
  --guild-id 1485787271192907816 \
  --channel-id 1542708795720081408 \
  --raya-bot-id 1542068543645024257 \
  --audio-file /Users/xiaorongli/.flywheel/raya/qa/FLY-2031/emitter.aiff \
  --evidence-file /Users/xiaorongli/.flywheel/raya/qa/FLY-2031/emitter-evidence.jsonl \
  --mute-ms 180000 \
  --response-timeout-ms 90000
```

Expected: emitter evidence 有 self-mute 180 秒边界、TTS 播放完成、5 秒 STT settle、Raya Opus packets > 0；Raya evidence 同时有本轮 QA user transcript、assistant transcript 与 `audio_counters.sent` 同量级计数。

- [ ] **Step 4: 归档脱敏 evidence**

只提交摘要/manifest，不提交 bot token、原始 env、approval token 或音频内容。C9 状态写成“QA 轮通过 / founder 轮待安排”，不得 complete。
