# FLY-2031 Founder R1 语音体验修复 — 实施计划
Issue: FLY-2031 (https://linear.app/geoforge3d/issue/FLY-2031/rayav3-%E9%9A%8F%E8%BA%AB%E8%AF%AD%E9%9F%B3b%E5%B8%B8%E5%BC%80%E6%B5%81-%E5%BF%B5%E8%AF%BB%E7%AD%9B%E9%80%89-%E7%94%A8%E5%98%B4%E6%89%B9-ship)
日期: 2026-08-29
基于: founder-r1-design-amendment.md

> **2026-08-30 supersession:** 本文是 Founder R1 的历史执行计划。Task 6 及所有 custom barge-in、Speaker interruption、Downlink flush/latch/defer/release 步骤已被 Founder replacement rework 整体撤销；当前实现恢复正常逐轮对话，并增加 participant/Raya final 与 thinking 状态的同路文字镜像。spoken liveness 删除、人话 brief、重复上限与 `ship_gate` fail-closed 修复继续有效。当前交付与实房判定以 `plan.md` §14、`bot-qa-summary.md` R16 为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. This runner contract forbids subagent dispatch, so execution is inline with review checkpoints. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal（R1 历史）:** 删除 spoken liveness，把普通念读变成可验证的人话 brief，并为 inbox 加入重复上限/退避；当时还包括能清本地尾音的 custom barge-in，后者已被 2026-08-30 replacement rework 删除。

**Architecture:** `@raya/contracts` 承载 `speechBrief` 与 `text_fallback` 审计语义；voice 新增纯函数 presenter，`InboxReader` 只念 presenter 输出并管理 per-session attempt。Runtime 在授权用户开口时同时中断 `Speaker`、清空 `Downlink`、抑制迟到音频并暂停 code speech；relay / ship 使用各自权威数据生成「先人话、末句核编号」稿。

**Tech Stack:** TypeScript、Vitest、Node.js、Discord voice / Opus、launchd QA plist、现有 C9 emitter 与 `voice-test-2`。

---

## 文件地图

| 单元 | 文件 | 职责 |
|---|---|---|
| inbox contract | `packages/contracts/src/voice-inbox.ts`、`.test.ts` | `speechBrief`、`text_fallback` ack、兼容旧行 |
| 人话 presenter | `apps/voice/src/inbox/SpeechBrief.ts`、`.test.ts` | brief safety validation 与确定性自然稿 |
| 念读调度 | `apps/voice/src/inbox/InboxReader.ts`、`.test.ts` | fail-closed 文字兜底、两次上限、60s 退避、session defer |
| spoken liveness 删除 | `packages/contracts/src/voice-actions.ts`、`apps/voice/src/{config,filter/FilterRules,actions/OutboxWatcher,codex/CodexLeg,runtime}.ts` 及对应 tests | 删除所有可生效开关、偏好和语音 timer |
| code speech 中断 | `apps/voice/src/speech/Speaker.ts`、`.test.ts` | 可恢复 token rotation 与 `interrupted` 结果 |
| 本地尾音清理 | `apps/voice/src/pipeline/Downlink.ts`、新 `.test.ts` | flush PCM / replace stream / interrupt evidence |
| runtime barge-in | `apps/voice/src/runtime.ts`、`.test.ts` | speakingStart 组合四步、迟到 delta 丢弃、对话回合后恢复 |
| 动作人话 | `apps/voice/src/actions/ReadbackGate.ts`、`apps/voice/src/approval/ShipGateFlow.ts` 及 tests | 不念 actionId，编号只在末句一次 |
| QA | `probes/fly2031-voice-experience.mjs`、`.test.mjs`、`engineering/doc/.../evidence/` | 真房能插嘴/不重复/无黑话证据 |
| root gate | `package.json` | 新增 `.mjs` tests 必须进入 `pnpm test` 固定枚举 |

### Task 1: 扩展 inbox contract，不破坏历史行

**Files:**
- Modify: `packages/contracts/src/voice-inbox.ts`
- Modify: `packages/contracts/src/voice-inbox.test.ts`

- [ ] **Step 1: 写 RED contracts tests**

加入以下核心断言：

```ts
const brief = {
  what: "下一轮先让测试机器人把流程走完。",
  why: "你明确说过不想再当第一个听众。",
  next: "你只要决定要不要保留这道测试门。",
};
appendVoiceInboxItem(stateDir, item({ speechBrief: brief }));
expect(readVoiceInbox(stateDir).items[0]?.speechBrief).toEqual(brief);

appendVoiceInboxAck(stateDir, {
  v: 1,
  id: "bad-decision",
  at: "2026-08-29T17:00:00.000Z",
  bootId: "boot-one",
  how: "text_fallback",
});
expect(readVoiceInbox(stateDir).acks[0]?.how).toBe("text_fallback");

appendVoiceInboxItem(stateDir, item({ speechBrief: undefined }));
expect(readVoiceInbox(stateDir).items.at(-1)?.speechBrief).toBeUndefined();
```

- [ ] **Step 2: 运行 RED**

Run: `pnpm --filter @raya/contracts test -- src/voice-inbox.test.ts`

Expected: FAIL，`speechBrief` 不在 `VoiceInboxItem`，`text_fallback` 不在 ack union。

- [ ] **Step 3: 最小实现 contract**

增加：

```ts
export interface VoiceSpeechBrief {
  what: string;
  why: string;
  next: string;
}

export interface VoiceInboxItem {
  // existing fields stay unchanged
  speechBrief?: VoiceSpeechBrief;
}

export interface VoiceInboxAck {
  // existing fields stay unchanged
  how: "spoken" | "filtered" | "expired" | "text_fallback";
}
```

`parseItem` 把 `speechBrief` 加入 optional exact keys；若存在，必须 exact keys `what/why/next`、每项 non-empty、每项最多 200 Unicode code points。缺 brief 的历史 v1 行继续可读，交给 voice fail-closed；不能把它计为 corrupt 而丢失原文。

再加完整代表行 byte-budget test：三段均为 200 个 CJK code points、带正常 `text/source/refs` 时，JSONL 仍小于 `VOICE_INBOX_LINE_BYTES=4_096` 并能 round-trip。若未来 producer 可能把原文推到剩余 byte budget 外，`appendVoiceInboxItem` 仍以总行 byte 上限 fail-closed。新 consumer 必须先于 FLY-2030 producer 部署；旧 binary 不认识 inline optional key 的 rollback 限制写进部署证据，不能把回滚后的 `corruptLines` 当作 item 已处理。

- [ ] **Step 4: GREEN + contracts 全包**

Run: `pnpm --filter @raya/contracts test`

Expected: PASS，无 corrupt line 回归。

- [ ] **Step 5: 提交**

```bash
git add packages/contracts/src/voice-inbox.ts packages/contracts/src/voice-inbox.test.ts
git commit -m "feat(contracts): add human speech briefs"
```

### Task 2: 建立纯 presenter 与普通语音零 id 边界

**Files:**
- Create: `apps/voice/src/inbox/SpeechBrief.ts`
- Create: `apps/voice/src/inbox/SpeechBrief.test.ts`

- [ ] **Step 1: 写 RED presenter tests**

```ts
expect(renderInboxSpeech(item({
  needsDecision: true,
  speechBrief: {
    what: "下一轮先由测试机器人走完整套流程。",
    why: "这样可以先发现听感问题，不再让你当首测。",
    next: "你只要决定是否保留这道测试门。",
  },
}), 2)).toEqual({
  text: "下一轮先由测试机器人走完整套流程。这样可以先发现听感问题，不再让你当首测。你只要决定是否保留这道测试门。后面还有 2 件，我接着说。",
  confirmStart: 0,
  confirmEnd: Array.from("下一轮先由测试机器人走完整套流程。这样可以先发现听感问题，不再让你当首测。你只要决定是否保留这道测试门。").length,
});

for (const forbidden of ["FLY-2031", "PR #42", "relay-2031", "1542708795720081408", "402666ff-17bf-43ce-85a3-74f152677bfd"]) {
  expect(validateSpeechBrief({ what: forbidden, why: "原因。", next: "不用决定。" }))
    .toEqual({ ok: false, reason: "internal_identifier" });
}
```

再断言 renderer 输出的第一句就是 `what`，不插入 `[汇报]`、`[需要你决定]`、lead/item/action id。

- [ ] **Step 2: 运行 RED**

Run: `pnpm --filter @raya/voice test -- src/inbox/SpeechBrief.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 最小实现**

导出：

```ts
export type SpeechBriefValidation =
  | { ok: true }
  | { ok: false; reason: "missing" | "empty" | "too_long" | "internal_identifier" };

export function validateSpeechBrief(brief: VoiceSpeechBrief | undefined): SpeechBriefValidation;
export interface RenderedInboxSpeech {
  text: string;
  confirmStart: number;
  confirmEnd: number;
}

export function renderInboxSpeech(item: VoiceInboxItem, remaining: number): RenderedInboxSpeech;
```

内部 identifier patterns 至少覆盖 issue、PR、action-style token、UUID、17–20 位 snowflake；renderer 只连接三段并规范相邻空白，不改写内容、不调用模型。`confirmStart/End` 只包三段正文，不含「后面还有 N 件」尾句。

- [ ] **Step 4: GREEN**

Run: `pnpm --filter @raya/voice test -- src/inbox/SpeechBrief.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/voice/src/inbox/SpeechBrief.ts apps/voice/src/inbox/SpeechBrief.test.ts
git commit -m "feat(voice): render structured human briefs"
```

### Task 3: InboxReader fail-closed、文字兜底、重复上限与退避

**Files:**
- Modify: `apps/voice/src/inbox/InboxReader.ts`
- Modify: `apps/voice/src/inbox/InboxReader.test.ts`
- Modify: `apps/voice/src/runtime.ts`（只传新 options，行为集成留 Task 6）

- [ ] **Step 1: 写 RED fail-closed tests**

覆盖四格：decision 缺 brief → `announceText` 含原文且成功后 `text_fallback`；文字失败 → 无 ack 且下一 poll 只重试文字；report 黑话 brief → 零 `speak`、一次文字/evidence；safe brief → speak 只收到 presenter 的 `text` 而不是 `item.text`。

```ts
expect(speak).not.toHaveBeenCalled();
expect(announceText).toHaveBeenCalledWith(
  expect.stringContaining("有一件事需要你决定，但语音稿不合格所以没念"),
);
expect(readVoiceInbox(root).acks).toMatchObject([
  { id: "bad-decision", how: "text_fallback" },
]);
```

- [ ] **Step 2: 运行 fail-closed RED**

Run: `pnpm --filter @raya/voice test -- src/inbox/InboxReader.test.ts`

Expected: FAIL，旧 reader 仍把 `item.text` 送进语音。

- [ ] **Step 3: 实现 fail-closed**

`runPoll` 在 filter 后、排序前调用 `validateSpeechBrief`。拒绝时 record：

```ts
{
  kind: "voice_inbox_brief_rejected",
  itemId: item.id,
  needsDecision: item.needsDecision,
  reason: validation.reason,
}
```

`announceBestEffort` 改为返回 boolean；只有文字成功才 `ack(id, "text_fallback")`。所有文字使用现有 bounded `summary()` 与 `@` escaping。

`confirmationFor` 不再调用 `requestText.indexOf(item.text)`；改收 `RenderedInboxSpeech` 的精确 span。新增真实 confirm tests：完整三段可确认，paraphrase / truncated / generic assistant response / 只匹配最后字符均不得确认，continuation cue 不参与正文确认。

- [ ] **Step 4: 写 RED retry tests（fake clock）**

为 fixture 注入 `nowMs()` 与 `retryBackoffMs`：

```ts
await reader.poll();                    // first unconfirmed
now += 59_999;
await reader.poll();                    // no repeat
now += 1;
await reader.poll();                    // second attempt
now += 600_000;
await reader.poll();                    // hard cap: still two
expect(speak).toHaveBeenCalledTimes(2);
expect(record).toHaveBeenCalledWith(expect.objectContaining({
  kind: "inbox_speech_deferred",
  reason: "attempt_cap",
}));
```

另测 `SpeakerResult.status="interrupted"` 时同 session 后续 poll 永不重念，但 reader 继续下一个 item。`needsDecision` 因 `attempt_cap` 或 `interrupted` defer 时只发一次 bounded `#raya` 文字、无终态 ack；文字失败不在同 session 轰炸重试。

- [ ] **Step 5: 运行 retry RED**

Run: `pnpm --filter @raya/voice test -- src/inbox/InboxReader.test.ts`

Expected: FAIL，旧 reader 每 poll 立即重试且不认识 `interrupted`。

- [ ] **Step 6: 最小 retry 实现**

新增固定 `MAX_ATTEMPTS_PER_SESSION = 2`，`attempts: Map<string,{count,nextAt,deferred,deferNoticeAttempted}>`。普通失败第一次设置 `nextAt=now+retryBackoffMs`；第二次 `deferred=true`。`interrupted` 直接 defer。配置只允许 `inboxRetryBackoffMs`，不暴露 cap。

- [ ] **Step 7: GREEN + 提交**

Run: `pnpm --filter @raya/voice test -- src/inbox/InboxReader.test.ts`

Expected: PASS。

```bash
git add apps/voice/src/inbox/InboxReader.ts apps/voice/src/inbox/InboxReader.test.ts apps/voice/src/runtime.ts
git commit -m "fix(voice): bound and back off inbox speech"
```

### Task 4: 从所有运行路径删除 spoken liveness

**Files:**
- Delete: `apps/voice/src/speech/Liveness.ts`
- Delete: `apps/voice/src/speech/Liveness.test.ts`
- Modify: `packages/contracts/src/voice-actions.ts`
- Modify: `packages/contracts/src/voice-actions.test.ts`
- Modify: `apps/voice/src/config.ts`
- Modify: `apps/voice/src/config.test.ts`
- Modify: `apps/voice/src/filter/FilterRules.ts`
- Modify: `apps/voice/src/filter/FilterRules.test.ts`
- Modify: `apps/voice/src/actions/OutboxWatcher.ts`
- Modify: `apps/voice/src/actions/OutboxWatcher.test.ts`
- Modify: `apps/voice/src/codex/CodexLeg.ts`
- Modify: `apps/voice/src/codex/CodexLeg.test.ts`
- Modify: `apps/voice/src/cli.ts`
- Modify: `apps/voice/src/runtime.ts`
- Modify: `apps/voice/src/runtime.test.ts`

- [ ] **Step 1: 写 RED 删除面测试**

```ts
expect(() => parseVoiceAction(JSON.stringify({ ...base, kind: "set_pref", pref: { livenessIntervalMs: 1 }, quote: "更频繁" })))
  .toThrow(/voice action is invalid: kind/);

writeFileSync(filterFile, JSON.stringify({ v: 1, rules: [], prefs: { livenessIntervalMs: 10 } }));
expect(loadFilterState(filterFile)).toEqual({
  corrupt: false,
  state: { v: 1, rules: [], prefs: {} },
});

expect(config.behavior).not.toHaveProperty("livenessIntervalMs");
```

Runtime regression 用 legacy options `{livenessIntervalMs:1}` 启动并推进 fake timers，断言 `appendSpeech` 从未收到 `liveness:*`，evidence 没有 `liveness_triggered`，但 heartbeat 与 audio clock 仍触发。

- [ ] **Step 2: 运行 RED**

Run: `pnpm --filter @raya/contracts test -- src/voice-actions.test.ts && pnpm --filter @raya/voice test -- src/config.test.ts src/filter/FilterRules.test.ts src/actions/OutboxWatcher.test.ts src/codex/CodexLeg.test.ts src/runtime.test.ts`

Expected: FAIL，旧 `set_pref`、config、runtime timer 仍存在。

- [ ] **Step 3: 删除运行面**

删除 `VoiceAction.set_pref` union / parser；`OutboxWatcherOptions.onLivenessIntervalMs` 与 preference mutation；Codex ACTIONS prompt 的 `set_pref`；runtime `Liveness` field/import/start/wake/stop/note；config behavior 字段与 parse。Filter loader 接受 legacy pref 但返回 `prefs:{}`，writer 永不写回。

- [ ] **Step 4: 删除模块并 GREEN**

Run: 同 Step 2。

Expected: PASS，且 `rg -n "报个平安|liveness_triggered|new Liveness|set_pref" apps/voice/src packages/contracts/src` 无产品路径命中。

- [ ] **Step 5: 提交**

```bash
git add packages/contracts/src apps/voice/src
git commit -m "fix(voice): remove spoken liveness entirely"
```

### Task 5: 让 Speaker 与 Downlink 支持可恢复中断

**Files:**
- Modify: `apps/voice/src/speech/Speaker.ts`
- Modify: `apps/voice/src/speech/Speaker.test.ts`
- Modify: `apps/voice/src/pipeline/Downlink.ts`
- Create: `apps/voice/src/pipeline/Downlink.test.ts`

- [ ] **Step 1: 写 Speaker RED**

构造 active append + queued job，调用 `speaker.interrupt("user-speaking")`：两者都应立即返回 `status:"interrupted"`；迟到 append/final 不得确认；随后新 `speak` 在环境恢复后可正常 confirmed。现有 terminal `invalidate()` 仍永久 drop。

- [ ] **Step 2: 运行 Speaker RED**

Run: `pnpm --filter @raya/voice test -- src/speech/Speaker.test.ts`

Expected: FAIL，`interrupt` / `interrupted` 不存在。

- [ ] **Step 3: 实现可恢复 token rotation**

```ts
export type SpeakerStatus = "confirmed" | "unconfirmed" | "failed" | "dropped" | "interrupted";

interrupt(reason: string): void {
  const previous = this.token;
  previous.valid = false;
  previous.invalidate();
  this.confirmation?.settle({ kind: "interrupted" });
  this.token = queueToken();
  this.record({ kind: "speech_queue_interrupted", reason, pendingCount: this.pending.size });
  this.wake();
}
```

`run` / confirmation race 对旧 token 返回 `interrupted`；terminal `invalidate` 不轮换 token。`interrupt()` 首先检查 terminal invalidation，已经永久失效时保持 inert，不能用新 token 复活；新增 `invalidate()` 后再 `interrupt()` 仍 dropped 的测试。

- [ ] **Step 4: 写 Downlink RED**

Fake player 保存每次 `play(stream)`；先 push voice / tick，再 `interrupt()`：旧 stream destroyed、新 stream 已 play、queue depth 为 0、`audibleTailSnapshot` 清零、record 含 `outcome:"interrupted"`。随后 tick 仍写 silence，证明常开流未断。

- [ ] **Step 5: 实现 Downlink interrupt 并 GREEN**

`interrupt()` flush queue、reset resampler / tail snapshot、调用 `startResource()`，返回清掉的 buffered frame 数供 evidence。

Run: `pnpm --filter @raya/voice test -- src/speech/Speaker.test.ts src/pipeline/Downlink.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add apps/voice/src/speech/Speaker.ts apps/voice/src/speech/Speaker.test.ts apps/voice/src/pipeline/Downlink.ts apps/voice/src/pipeline/Downlink.test.ts
git commit -m "feat(voice): interrupt buffered system speech"
```

### Task 6: Runtime 组合真实 barge-in 四步

**Files:**
- Modify: `apps/voice/src/pipeline/Uplink.ts`
- Modify: `apps/voice/src/pipeline/pipeline.test.ts`
- Modify: `apps/voice/src/runtime.ts`
- Modify: `apps/voice/src/runtime.test.ts`

- [ ] **Step 1: 写 runtime integration RED**

用真实 `Speaker` + fake transport/player：assistant speech 正在输出时触发 allowlisted `room.speakingStart`，断言先抢到 uplink owner 再 arm barge-in：

```ts
expect(evidence).toContainEqual(expect.objectContaining({ kind: "barge_in_started", userId: QA_ID }));
expect(player.play).toHaveBeenCalledTimes(2); // local stream replaced
expect(activeSpeech).resolves.toMatchObject({ status: "interrupted" });
transport.emitOutputAudio(oldDelta);
expect(evidence).toContainEqual(expect.objectContaining({ kind: "barge_in_audio_dropped" }));
```

再发 current user final：正常 assistant reply audio 可播放，但 inbox `appendSpeech` 仍保持暂停；发 assistant final 后 reader 才能念下一条。未授权 speaker start 不得触发任何一项。

补三条无 final 的 RED：第二个 authorized user 抢占已有 QA owner 后自己的 PCM 真进入 transport；短促 speaking start/end 没有 transcript 时 1.5 秒 grace 释放；owner change / 30 秒 monotonic deadline 释放。每条都断言后续 `Speaker.speak` 可恢复，不能永久 mute。Founder trigger path 另测 presence check 已预热和 epoch 失效时的 `barge_in_abandoned` evidence，不能只覆盖 QA allowlist 同步分支。

- [ ] **Step 2: 运行 RED**

Run: `pnpm --filter @raya/voice test -- src/runtime.test.ts`

Expected: FAIL，旧 runtime 没有本地清尾音或 system-speech hold。

- [ ] **Step 3: 最小 runtime 状态机**

把 `Uplink.speakingStart` 改成返回 ownership，并允许 authorized barge-in 原子 preempt 当前 owner（flush frame/jitter、切 owner、记录 previous/current）。只有 `ownsInput=true` 才 arm 一份 generation-bound 状态 `{userId, deadlineAt, userFinalSeen}`。授权判定完成且取得 owner 后立即：

```ts
const ownership = this.uplink?.speakingStart(userId, true, { preempt: true });
if (!ownership?.ownsInput) return;
this.downlink?.interrupt();
this.speaker?.interrupt("user-speaking");
this.armBargeIn({
  userId,
  deadlineAt: this.nowMs() + BARGE_IN_MAX_MS,
  generation: connectionGeneration,
});
```

Speaker environment 的 `busy` 加上 hold；outputAudio 在 drop 期间只计 evidence 不 push；current-session user final 清 drop，随后 current-session assistant final 清 hold 并 `speaker.wake()`。没有 user final 时，`speakingEnd` 启动 1.5 秒 grace；owner change、session/teardown 或总时限 30 秒立即清全部标志并 wake。全部 deadline 用注入的 monotonic clock，timer callback 复核 generation 后才释放。

- [ ] **Step 4: GREEN + focused voice suite**

Run: `pnpm --filter @raya/voice test -- src/runtime.test.ts src/speech/Speaker.test.ts src/pipeline/Downlink.test.ts src/pipeline/pipeline.test.ts src/inbox/InboxReader.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/voice/src/pipeline/Uplink.ts apps/voice/src/pipeline/pipeline.test.ts apps/voice/src/runtime.ts apps/voice/src/runtime.test.ts
git commit -m "fix(voice): yield immediately to authorized speech"
```

### Task 7: 把 relay / ship 改成先人话、末句核编号

**Files:**
- Modify: `apps/voice/src/actions/ReadbackGate.ts`
- Modify: `apps/voice/src/actions/ReadbackGate.test.ts`
- Modify: `apps/voice/src/approval/ShipGateFlow.ts`
- Modify: `apps/voice/src/approval/ShipGateFlow.test.ts`

- [ ] **Step 1: 写 prompt RED**

Ship 期望稿：

```ts
expect(prompt).toStartWith("Tadashi 想请你决定，要不要把「Raya voice」这项改动送进发布。");
expect(prompt).toContain("现在找你，是因为它已经走到需要你最后确认的门口。");
expect(prompt).toContain("你要批准就说确认，不批准就说不批。");
expect(prompt).toEndWith("最后跟你核一下，是 FLY-2031 这一单、PR 四十二，对吧？");
expect(prompt.indexOf("FLY-2031")).toBeGreaterThan(prompt.length / 2);
```

Relay 断言开头不含 `actionId` / identifier，末句才出现 `Tadashi` 与 `FLY-1833` 一次，且稿中说明这会真的发消息与取消口令；Founder 的每条 quoted utterance 必须仍逐字出现在稿与 confirm predicate 中。

- [ ] **Step 2: 运行 RED**

Run: `pnpm --filter @raya/voice test -- src/actions/ReadbackGate.test.ts src/approval/ShipGateFlow.test.ts`

Expected: FAIL，旧稿以 action / issue / PR 开场。

- [ ] **Step 3: 最小人话 prompt 实现**

Ship 只用 verified `context.issueTitle`、`context.issueIdentifier`、binding PR；用中文数字或自然读法包装 PR，identifier 只在末句一次。confirmation 改为 chunk-aware：先核当前 chunk 的自然正文，只有 chunk 本身承载末句时才额外核 exact identifier；用缩小的 `briefingChunkChars` 覆盖多 chunk。Relay 从 Founder-attributed resolved utterances 与 action text 生成 natural meaning，但逐字保留 Founder quotes；删除 `"动作 " + actionId` spoken prefix，原 lead-name + quote confirmation 与 authority / receipt 逻辑不动。

- [ ] **Step 4: GREEN + authority regression**

Run: `pnpm --filter @raya/voice test -- src/actions/ReadbackGate.test.ts src/actions/OutboxWatcher.test.ts src/approval/ShipGateFlow.test.ts`

Expected: PASS，non-Founder / stale-session / receipt-first / zero-POST regressions仍绿。

- [ ] **Step 5: 提交**

```bash
git add apps/voice/src/actions/ReadbackGate.ts apps/voice/src/actions/ReadbackGate.test.ts apps/voice/src/approval/ShipGateFlow.ts apps/voice/src/approval/ShipGateFlow.test.ts
git commit -m "fix(voice): explain actions before identifiers"
```

### Task 8: 六条文字稿审阅门

**Files:**
- Create: `engineering/doc/FLY-2031-raya-mobile-voice/evidence/founder-r2-speech-samples.md`
- Modify: `scripts/voice-inbox-fixture.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: 生成六条全新 fixture 的 `speechBrief` 与 renderer 精确输出**

两条 decision 讲清是否保留「文字先审」和「QA bot 先验」；四条 report 分别讲常开静音、barge-in、重复上限、spoken liveness 删除。内部 item id / issue refs 只留在 JSON，不得出现在输出稿。

- [ ] **Step 2: 写样例文档**

文档逐条列：内部 fixture id（仅审计栏）、`what/why/next`、最终 spoken text、自动检查 `idMatches=0` 与首句三秒判据。文档明确「这是 Lead 文字审阅稿，未过审不得进房」。

- [ ] **Step 3: focused/full local verification**

把 `scripts/voice-inbox-fixture.test.mjs` 加入 root `test:qa` 固定枚举。

Run: `pnpm lint && pnpm -r build && pnpm typecheck && pnpm test`

Expected: 全部 PASS；无 liveness product path、普通样例零 identifier。

- [ ] **Step 4: 提交并发 Lead 文字 gate**

```bash
git add engineering/doc/FLY-2031-raya-mobile-voice/evidence/founder-r2-speech-samples.md scripts/voice-inbox-fixture.test.mjs
git commit -m "test(voice): stage human speech samples"
```

用 `flywheel-comm ask` 发 commit + 六条全文，等待明确 APPROVED；pending 期间不 bootstrap QA voice。

### Task 9: QA bot 真房自测，不让 Founder 当首测

**Files:**
- Create: `probes/fly2031-voice-experience.mjs`
- Create: `probes/fly2031-voice-experience.test.mjs`
- Create: `engineering/doc/FLY-2031-raya-mobile-voice/evidence/qa-bot-experience-round.md`
- Modify: `package.json`
- Modify outside repo: `~/.flywheel/raya/qa/FLY-2031/rounds/bot-experience-*`
- Modify outside repo: QA plist staging copy only

- [ ] **Step 1: RED probe contract tests**

纯函数 judge 必须同时要求：六条 assistant final 全部来自批准文字稿；普通稿 identifier matches=0；barge-in evidence 有 owner preempt + local clear + interrupted item + authorized user final；被打断 pendingKey 本 boot 只注入一次；安静窗口无 liveness speech；Raya Opus 解码能量在 emitter 开口后快速落到 silence、随后正常回答恢复；audio counters 仍有 silence/sent。重复三次 barge-in 后还必须无 interrupt-attributable `player-idle-recovered`、无 Discord `LegDown`。

- [ ] **Step 2: 实现 probe 并跑本地 tests**

把新 probe test 加入 root `test:qa` 固定枚举。

Run: `node --test probes/fly2031-voice-experience.test.mjs`

Expected: PASS。Probe 只在内存解码 Opus、保存时间/能量摘要，不保存原音频或 token。

- [ ] **Step 3: 摆隔离 QA 场**

使用新 state / metrics / logs / workspace；写六个新 item + 一条足够长的 barge-in item；QA plist 删除 `livenessIntervalMs`、保留 rotated credential file path 与 deny-read。Runner 写 fresh voice-mode marker，Lead 只 host bootout/bootstrap `com.xrli.raya.voice.fly2031.qa`，生产 label 不动。

- [ ] **Step 4: 在实际 `voice-test-2` 跑 probe**

QA bot self-muted 入房收听；在长 item Raya 真正出声后开麦播放唯一 TTS，验证本地停口与 user/assistant transcript，并重复三次确认真实 player 不进 idle-loop。保持在房直到退避窗口超过，确认 interrupted item 不重念、无任何 liveness；随后离房 clean exit。QA bot 实房覆盖 allowlist 同步分支；Founder trigger 的 async human-check / epoch 分支由 runtime integration test + `barge_in_abandoned` evidence 单列，不能把 bot round 冒充 Founder 身份路径已真机覆盖。

- [ ] **Step 5: 归档与 Lead READY**

证据文档列 launchd path / boot / timestamps / transcript excerpts / energy summary / pendingKey counts / audio counters / hashes；明确 QA bot 不是 Annie 原话。Lead 只有收到 QA PASS 报告后才能约 Founder 第三次进房。

### Task 10: Founder 第三轮、最终 gates 与 PR

**Files:**
- Modify: `engineering/doc/FLY-2031-raya-mobile-voice/evidence/founder-round-runbook.md`
- Create: final Founder round evidence and before/after manifests
- Create last commit only: `engineering/doc/milestones/FLY-2031.md`

- [ ] **Step 1: QA PASS 后才请求 Founder round**

第三轮使用新 state / item ids / boot；只认实际 Discord interface。重新覆盖 human voice、筛选持久化+重启 filtered、relay / P2 / forged speech、测试卡 non-production ship；保留 R1 partial 证据但不拿它补未跑格。

- [x] **Step 2: 修复/确认剩余 review findings**

已按 TDD 收口两条 NEW MEDIUM：meeting writable roots 复用含 `raya.env` 与 approval credential 的完整保护集；spoken-exit 固定句只接受 Founder-attributed user final 后紧接的 assistant final,任何系统播报注入都会清掉该资格。定向 57/57、voice 298/298、build、typecheck 与全仓 lint 通过。

- [ ] **Step 3: 全仓门**

Run: `pnpm lint && pnpm -r build && pnpm typecheck && pnpm test`

Expected: 全绿；新增 probe tests PASS。

- [ ] **Step 4: 正式 code review**

`stage set code_review` → `gate review_code --no-block` → `request-review --type code`；轮询到 `reviewVerdict=APPROVED`。CHANGES_REQUESTED 必须修后用新 questionId 重开。

- [ ] **Step 5: 最后提交 milestone、push、Raya PR**

遵循 `engineering/doc/milestones/README.md`；milestone 与文档归档只能放 PR 最后 commit。push 当前 branch，创建 target `raya/main` PR，不 merge、不请求 ship approval。

- [ ] **Step 6: handoff**

Run:

```bash
RAYA_PR_NUMBER="$(gh pr view --json number --jq .number)"
node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr "$RAYA_PR_NUMBER"
```

Expected: Bridge 收到 `session_completed status=needs_review`，本 goal 才可标 complete。

## Round 2 设计审查处理记录

- `bargein-latch-never-clears`（HIGH）：接受。Task 6 改成 authorized owner preemption；barge-in 用单一 generation-bound 状态，增加 speaking-end grace、owner/session/teardown 清理与 30 秒 monotonic deadline。
- `confirm-window-vs-brief`（HIGH）：接受。Task 2 presenter 返回精确正文 span；Task 3 confirmation 不再查找 `item.text`，并增加 paraphrase / truncated / one-character false-positive tests。
- `deferred-decision-has-no-fallback`：接受。decision defer 发一次 bounded 文字且不写终态 ack。
- `brief-cap-exceeds-line-cap`：接受。字段上限降为 200 code points，并增加完整 4,096-byte 代表行测试与 consumer-first rollback 约束。
- `readback-quotes-vs-natural-copy`：接受。自然稿仍逐字保留 Founder quotes，原 confirmation authority 不删。
- `new-mjs-tests-not-in-root-gate`：接受。两个新 `.mjs` test 都加入 root `test:qa` 固定枚举。
- `qa-bot-path-differs-from-founder-path`：接受。QA 真房证据不冒充 Founder 身份分支；runtime 单测覆盖 prewarmed human check 与 epoch-abandoned evidence。
- `downlink-interrupt-untested-against-real-player`：接受。QA bot 真房重复三次打断，明确断言无 idle-loop / Discord LegDown。
- `continuation-cue-silently-dropped`：接受。保留为人话尾句「后面还有 N 件，我接着说」，但排除在正文 confirm span 外。
- 三条 LOW：全部吸收；terminal invalidation 后 interrupt inert，Task 4 file map 加 `cli.ts`，ship confirmation 增加多 chunk test。
