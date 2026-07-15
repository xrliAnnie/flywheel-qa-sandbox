# FLY-546 耳机模式 — 实施计划

Issue: FLY-546 (https://linear.app/geoforge3d/issue/FLY-546/voicev15-耳机模式完整-deliverable-离屏推进-per-agent-声线原-546547-合并待-huddle-试跑后开)
日期: 2026-07-07
基于: research.md

> **给 Implement 阶段**:三段式同分支交付;逐任务 TDD(RED→GREEN→REFACTOR),checkbox 跟踪。
> M-A/M-B1/M-B2/M-B3 **不依赖 FLY-545**,可立即开工;M-B4(VC 接线)动手前**必须先
> `flywheel-comm ask` Tadashi 对齐 545 现状**(Lead 编排指示 + brainstorm gate 补充①)。
> 本 plan 已经 brainstorm gate 批准(exploration §8)+ **Annie 拍板覆盖(exploration §9,以 §9 为准)**;
> Codex design review 见同文件夹 design-review-*.md。

**Goal**:Annie 说「芝麻开门」进入耳机模式后,所有 Lead 发给她的 Discord 消息按 FIFO 转语音
一条条推送(per-agent 声线 + 报头),每条 skip/口述代发二选一,ship 类走语音批准+TIV 收据;
**退出主路径 = 离开语音频道(60s 重连防抖)**,「芝麻关门」+确认步为可选口头退出(Annie ④)。

**Architecture**:四层——①voice-core 纯逻辑层(VoiceDirectory / FIFO 队列 / 回合 FSM / tap 过滤,
I/O 全注入);②voice-headphone daemon(Discord gateway tap + 组合 + 状态持久化);③Bridge 四个
`/api/voice/*` endpoint(范围合同 / 上下文查询 / gate 绑定查询 / voice 批准写入,复用 approval-signal
预留的 voice 源位);④VC 音频面 = FLY-545 five-interface 合同的适配器(不重复造管线)。

**Tech Stack**:TypeScript pnpm monorepo;vitest;edge-tts(prosody 参数);discord.js(仅 daemon 包);
Bridge = 现有 teamlead plugin;批准写入 = 现有 `writeGateResponseAndRunPostWrite`。

---

## 0. 文件地图(创建/修改总览)

| 动作 | 路径 | 职责 |
|------|------|------|
| Modify | `packages/voice-core/src/types.ts` | `VoiceSpec`、`TtsEngine.synthesize` prosody 扩参(向后兼容) |
| Modify | `packages/voice-core/src/backends/edge-tts/EdgeTtsEngine.ts` | `--rate/--pitch` per-call 支持 |
| Modify | `packages/voice-core/src/backends/edge-tts/EdgeTtsBackend.ts` | AnnouncerOptions 透传 VoiceSpec |
| Create | `packages/voice-core/src/headphone/voice-directory.ts` | agentId→VoiceSpec 映射 + fallback |
| Create | `packages/voice-core/src/headphone/queue.ts` | FIFO 队列(快照/恢复钩子) |
| Create | `packages/voice-core/src/headphone/turn-machine.ts` | 回合 FSM(§17 全语义) |
| Create | `packages/voice-core/src/headphone/tap-filter.ts` | 消息纳入判定(纯函数) |
| Create | `packages/voice-core/src/headphone/phrases.ts` | 口令/处置词/报头模板(常量+归一化匹配) |
| Create | `packages/voice-core/src/headphone/index.ts` | headphone 公共导出 |
| Create | `packages/voice-core/src/__tests__/headphone-*.test.ts` | 上述全部单测(含 §17 worked example 场景测) |
| Create | `packages/voice-headphone/`(新包) | daemon:gateway tap→queue→FSM 组合、状态持久化、Bridge client、NullAudioIO/545 适配器 |
| Modify | `packages/teamlead/src/ProjectConfig.ts` | `leads[].voice` 字段 + 校验 |
| Create | `packages/teamlead/src/bridge/approval-signal/voice-approval-source.ts` | voice 信号归一(填 types.ts 预留位) |
| Create | `packages/teamlead/src/bridge/voice-routes.ts` | `/api/voice/scope`、`/api/voice/context`、`/api/voice/gate-binding`、`/api/voice/ship-approval` |
| Modify | `packages/teamlead/src/bridge/plugin.ts` | 挂载 voice-routes(Bearer apiToken 中间件之内) |
| Create | `packages/teamlead/src/bridge/__tests__/voice-*.test.ts` | source + routes 单测/集成测 |
| Create | `scripts/voice-audition-fly546.mjs` | audition kit(候选声线 × 样本报头 → mp3 目录 + index) |

**字节兼容红线**:不设 `leads[].voice` / 不起 daemon → 全系统行为逐字不变(不起 daemon 时
没有任何调用方触达 `/api/voice/*`,批准 kill-switch 默认 ON 也不改变任何现有行为)。
reverse-compat 单测覆盖:EdgeTts 无 prosody 参数时 argv 与现状逐字一致;ProjectConfig 无
voice 字段加载结果不变;ship-approval 响应优先级 = **apiToken 未配 503 → Bearer 错 401 →
kill-switch 关 403**,三态各测(Codex R2 #2)。

---

## M-A per-agent 声线(先行,不依赖 545)

### Task A1:VoiceSpec + EdgeTts prosody

**Files**:Modify `voice-core/src/types.ts`、`EdgeTtsEngine.ts`、`EdgeTtsBackend.ts`;
Test `voice-core/src/__tests__/edge-tts.test.ts`(扩)

- [x] A1.1 RED:测试 `synthesize(text, {voiceId:"zh-CN-YunxiNeural", rate:"-10%", pitch:"+2Hz"}, …)`
  → 断言 runner 收到 argv 含 `--voice zh-CN-YunxiNeural --rate=-10% --pitch=+2Hz`;
  以及 `synthesize(text, "zh-CN-XiaoxiaoNeural", …)`(旧 string 形态)argv **逐字不变**(回归)。
- [x] A1.2 GREEN:types.ts 加

```ts
export type VoiceSpec = { voiceId: string; rate?: string; pitch?: string };
export type VoiceRef = string | VoiceSpec; // string = 裸 voiceId(向后兼容)
export function toVoiceSpec(ref: VoiceRef): VoiceSpec {
  return typeof ref === "string" ? { voiceId: ref } : ref;
}
```

  `TtsEngine.synthesize(text: string, voice: VoiceRef, opts)`;EdgeTtsEngine 内 `toVoiceSpec` 归一,
  rate/pitch 存在才追加 `--rate=…`/`--pitch=…`(edge-tts 要求 `=` 连写,防负号被当 flag——
  FLY-960 复现配方同款写法);`AnnouncerOptions.voice?: VoiceRef` 同步放宽。校验:rate 必须
  匹配 `/^[+-]\d+%$/`、pitch `/^[+-]\d+Hz$/`,不匹配抛 `VoiceError("component-missing", …)`(fail-fast)。
- [x] A1.3 全包测试绿 + `pnpm lint`;commit `feat(voice-core): VoiceSpec + per-call edge-tts prosody (FLY-546 A1)`

### Task A2:VoiceDirectory

**Files**:Create `voice-core/src/headphone/voice-directory.ts`;Test `headphone-voice-directory.test.ts`

- [x] A2.1 RED:`new VoiceDirectory({ tadashi: {voiceId:"zh-CN-YunyangNeural"} }, {voiceId:"zh-CN-XiaoxiaoNeural"})`
  → `resolve("tadashi")` 返 Yunyang;`resolve("unknown")` 返默认;agentId 匹配大小写不敏感;
  重复 agentId(仅大小写差)构造时抛错(配置错误 fail-fast)。
- [x] A2.2 GREEN:

```ts
export class VoiceDirectory {
  constructor(map: Record<string, VoiceSpec>, private readonly fallback: VoiceSpec) { /* 归一小写 + 重复检测 */ }
  resolve(agentId: string): VoiceSpec { /* map[agentId.toLowerCase()] ?? fallback */ }
}
```

- [x] A2.3 commit `feat(voice-core): VoiceDirectory agent voice mapping (FLY-546 A2)`

### Task A3:`leads[].voice` 配置

**Files**:Modify `teamlead/src/ProjectConfig.ts`(LeadConfig 加字段 + loadProjects 校验);
Test `teamlead/src/__tests__/ProjectConfig*.test.ts`(扩)

- [x] A3.1 RED:合法 `voice: { voiceId: "zh-CN-YunxiNeural", rate: "-10%" }` 加载后原样可读;
  非法(voiceId 空 / rate 格式错 / voice 非对象)→ throw 带 `leads[i].voice` 定位的错误;
  **不设 voice 字段 → 加载结果与现状深等**(reverse-compat)。
- [x] A3.2 GREEN:`LeadConfig.voice?: { voiceId: string; rate?: string; pitch?: string }`;校验挨着
  现有 botTokenEnv 校验块写,错误消息风格一致。
- [x] A3.3 commit `feat(teamlead): leads[].voice per-agent voice config (FLY-546 A3)`

### Task A4:audition kit + 定稿

**Files**:Create `scripts/voice-audition-fly546.mjs`

- [x] A4.1 脚本:8 个 zh-CN 声线(+rate/pitch 两档变体)× 固定样本报头
  (「我是 Tadashi。FLY-546,耳机模式——正在实现。有一件事想跟你确认……」)→
  `~/fly546-audition/<voice>.mp3` + `index.md`(声线/性别/音色表);跑一遍产出真实文件。
- [x] A4.2 提议默认映射表写进 index.md(男声给男 persona、口音声给辨识度优先位,详表 implement 时
  按现役 Lead 编制填);经 Lead 投递 Annie 真听。
- [x] A4.3 **生产声线基础全铺(Annie 拍板③,ship 时 ops 步骤)**:flywheel 项目下**每个 Lead 的
  leads[].voice 全部配上差异化合理默认值**(按 A4.2 提议表),不等 Annie 逐个拍——具体每个 Lead
  用什么声线 = Annie 和 Honey Lemon 的产品决定,后续**改一行 config 即换声线**(工程职责 =
  把这条改动路径铺平并在 ship note 写明改法)。
- [x] A4.4 commit `feat(scripts): FLY-546 voice audition kit`

---

## M-B1 headphone 纯逻辑层(voice-core,不依赖 545)

### Task B1-1:phrases + tap-filter

**Files**:Create `headphone/phrases.ts`、`headphone/tap-filter.ts`;Test 两个对应 test 文件

- [x] B1-1.1 RED(phrases):`matchPhrase("芝麻关门", STOP_WORD)` true;「芝麻关门。」「 芝麻关门 」
  (全半角标点/首尾空白归一)true;「帮我把芝麻关门那个改了」false(**整句精确,非包含**);
  处置词集:SKIP={不用,跳过,skip,下一条}、REPLY={要回,回复}、CONFIRM={确认,对}、
  DENY={不对,取消,不批}、APPROVE_INTENT={ship 吧,批准,可以 ship,发布吧}、
  PAUSE={暂停,待会,先停一下};OPEN_WORD=芝麻开门(+「/headphone on」)。
- [x] B1-1.2 GREEN:归一化(trim + 去首尾标点 + NFKC)后全等匹配;词表为导出常量,daemon 可
  config 覆盖(可配置≠NLP:仍是精确集合)。
- [x] B1-1.3 RED(tap-filter):输入 `{authorId, authorIsBot, channelId, mentionsFounder, hasGateBinding}` ×
  config `{leadBotIds:Set, systemBotIds:Set, scopeChannelIds:Set, roundtableChannelIds:Set,
  includeRoundtable, selfBotId, founderId}`:
  ① Lead bot 在 scope 频道 → include;② 非 Lead/system 作者 → exclude(含 founder 自己、路人、self);
  ③ roundtable 频道默认 exclude、`includeRoundtable=true` 时 include;④ 任意频道 @founder 的
  Lead 消息 → include(兜底);⑤ selfBotId(代发/收据自己发的)恒 exclude(回声免疫,FLY-220 教训);
  ⑥ **systemBotIds**(gate-poller 的全局 fallback bot 等,发 founder-facing gate/系统消息的非
  per-Lead 身份,来自 Bridge scope 合同)在 scope 频道 → include(Codex R1 #4:漏 fallback bot
  发的 ship-gate 通知 = c 档分支永不出现);⑦ scope 频道内 bot 作者不在两个集合、但
  `hasGateBinding=true`(daemon 已查过 gate-binding)→ include(按持久绑定分类,不按作者猜)。
- [x] B1-1.4 GREEN:纯函数 `shouldEnqueue(msg, cfg): boolean`;真值表测试覆盖 ①-⑦ 及
  per-Lead bot / fallback 全局 bot / 绑定 gate 消息 / roundtable 开关 / 自回声 六类作者场景。
- [x] B1-1.5 commit `feat(voice-core): headphone phrases + tap filter (FLY-546 B1-1)`

### Task B1-2:HeadphoneQueue

**Files**:Create `headphone/queue.ts`;Test `headphone-queue.test.ts`

- [x] B1-2.1 RED:push/peek/shift FIFO 序;`defer(item)` 移队尾;`snapshot()/restore()` round-trip
  深等;push 时 `onPersist` 钩子被调(daemon 接状态文件);同 messageId 重复 push 去重。
- [x] B1-2.2 GREEN:

```ts
export type QueueItem = {
  id: string; messageId: string; channelId: string; agentId: string;
  kind: "normal" | "ship_gate";
  headline: { agentDisplay: string; issueRef?: string; issueTitle?: string; stageHint?: string };
  body: string; enqueuedAt: string;
  gate?: { gateMessageId: string; questionId: string; prHeadSha: string; issueId: string; prNumber?: number };
  /** 副作用阶段账本(Codex R1 #2):crash 后按已记录的外部副作用 id 恢复/抑制重复,
   *  绝不重发代发消息/收据卡/批准调用。每步副作用完成即 persist。 */
  sideEffects?: { sentMessageId?: string; receiptMessageId?: string; approvalAttemptId?: string };
};
export class HeadphoneQueue { /* push/peek/shift/defer/snapshot/restore/size, onPersist 钩子 */ }
```

- [x] B1-2.3 commit `feat(voice-core): headphone FIFO queue (FLY-546 B1-2)`

### Task B1-3:TurnMachine(核心)

**Files**:Create `headphone/turn-machine.ts`;Test `headphone-turn-machine.test.ts` +
`headphone-worked-example.test.ts`

- [x] B1-3.1 先写**状态×事件×动作表**进模块头注释(实现前定死语义):

> **c 档合同(Codex R1 #3 定契)**:与 PRD §17 worked example **逐字对齐**——ship_gate 条
> 与 normal 条走**同一条** announce→ask 路径;c 档由她在处置态说出 **APPROVE_INTENT**
> (如「ship 吧」)触发:APPROVE_INTENT → 显式 readback(「你确认把 FLY-901 ship 上线?」)
> → 她说 CONFIRM(「确认」)→ 收据+写批准。**不跳步**:announce_done 绝不直接进批准态。

| 状态 | 事件 | 动作 → 次态 |
|------|------|------------|
| idle(mode ON, queue 空) | queue_pushed | speak(报头+正文) → announcing;正文 >400 字符 → speak(报头+前两句+「要听全文吗?」)→ awaiting_detail_choice(§17 两深度) |
| awaiting_detail_choice | utterance∈CONFIRM | speak(全文)→ announcing(续正常流) |
| awaiting_detail_choice | utterance∈SKIP/DENY 或 silence(15s) | 跳过全文 → speak(「要回吗?」)→ awaiting_disposition |
| announcing | announce_done | speak(「要回吗?」)→ awaiting_disposition(**ship_gate 条同此**,不跳步) |
| announcing | founder_speaking_start | stopSpeaking(<100ms,barge-in)→ awaiting_disposition(当前条上下文保留) |
| awaiting_disposition | utterance∈SKIP | 完结该条 → 取下一条(有→announcing;无→idle) |
| awaiting_disposition | utterance∈REPLY | speak(「说吧」)→ dictating |
| awaiting_disposition | utterance∈APPROVE_INTENT 且 kind=ship_gate 且 voiceApprovalEnabled | speak(显式 readback「你确认把 {issueRef} ship 上线?」)→ awaiting_approval_confirm |
| awaiting_disposition | utterance∈APPROVE_INTENT 且(kind=normal 或 !voiceApprovalEnabled) | narrate(「这条我这里不能批,收据/原消息在 thread,回屏幕处理」)→ 完结(gate 留给现有 text/reaction 路径) |
| awaiting_disposition | utterance∈PAUSE(暂停/待会/先停一下) | speak(「好,先放回队列」)+ defer 当前条 → idle(不退出模式;§17 可中断可恢复) |
| awaiting_disposition | silence(15s) | speak(「先放回队尾」)+ defer → 下一条 |
| awaiting_disposition | utterance=STOP_WORD | speak(「确认结束耳机模式?」)→ confirm_exit |
| awaiting_disposition | utterance 其余(unclear) | 重问一次「skip 还是要回?」;再 unclear → defer → 下一条 |
| dictating | utterance(final) | speak(readback 意图摘要「我转告:…,发吗?」)→ readback |
| readback | utterance∈CONFIRM | sendReply(代发)→ sending;send_result → narrate + 完结 → 下一条 |
| readback | utterance∈DENY | speak(「重说一遍?」)→ dictating(一次;再 DENY → defer) |
| awaiting_approval_confirm | utterance∈CONFIRM | postReceipt → submitApproval → narrate 结果 → 完结 |
| awaiting_approval_confirm | utterance∈DENY | **不写批准**,narrate「不批,留在 thread」→ 完结 |
| awaiting_approval_confirm | utterance 其余(unclear) | 重问一次(逐字重复 readback);再 unclear 或 silence → **不写批准**,narrate「收据在 thread,回屏幕处理」→ 完结 |
| awaiting_approval_confirm | utterance=STOP_WORD | **先弃批准**(不写)→ speak(「确认结束耳机模式?」)→ confirm_exit |
| awaiting_approval_confirm | silence(15s) | **不写批准**(silence≠同意)→ narrate + 完结 |
| confirm_exit | utterance∈CONFIRM | speak(recap:处理 N 条剩 M 条)→ 模式 OFF(「芝麻关门」=可选口头退出路径,Annie ④) |
| confirm_exit | 其他/超时 | speak(「继续」)→ 回原状态 |
| 任意(≠sending) | queue_pushed | 静默入队尾(mid-turn 不打断) |
| 任意(≠sending) | presence(false) | 停播 → disconnect_grace,记 `{previousState, currentItemId, itemPhase(announce/ask/dictate/readback), promptSpoken, enteredAtMs}`(持久化,Codex R3 #3);**前态=awaiting_approval_confirm 则该批准尝试立即作废**(Codex R3 #1:离场瞬间失效,重连后旧 readback 永不可再被「确认」写批准;该条 defer 回队首降为全新 ship_gate 回合) |
| disconnect_grace | presence(true) ≤60s | **恢复同一条、绝不重复已完成回合/副作用**:按 previousState 的入口提示重放继续(announce→重播报头+正文;ask→重问「要回吗?」;dictate→重说「说吧」;readback→重播 readback)——短暂掉线≠退出(Annie ④ 防抖);已作废的批准态不在此列(见上行,需全新 APPROVE_INTENT→readback→CONFIRM 流程) |
| disconnect_grace | 超时 60s | **模式 OFF(主退出路径:离开 VC=退出,Annie ④)**;文字 recap(处理 N 条剩 M 条)发 core 频道;队列快照持久保留,下次「芝麻开门」续推 |
| sending | presence(false) | 先完成本次 send(副作用不半途撕裂)→ 再进 disconnect_grace |

- [x] B1-3.2 RED:表中每行 ≥1 条转移测试;外加:sending 中 STOP_WORD 不生效(发完才处理);
  `voiceApprovalEnabled=false`(kill-switch 拉下)时 APPROVE_INTENT 走「回屏幕」分支,
  **批准态不可达**;沉默/unclear 绝不推进批准(silence≠同意);APPROVE_INTENT 在 normal 条
  不触发批准;**presence 防抖四测**(Codex R3 #1/#3):59s 重连恢复同一条、无重复完结/无重复
  副作用、按 itemPhase 重放入口提示;61s 超时退出+core recap+队列快照保留;**批准态中离场 →
  批准尝试立即作废,重连后对旧 readback 说「确认」不写批准**(需全新完整批准流);
  disconnect_grace 状态形状 round-trip 持久化。
- [x] B1-3.3 GREEN:`HeadphoneTurnMachine`,构造注入

```ts
export interface HeadphoneIO {
  speak(agentId: string | "system", text: string): Promise<void>; // VoiceDirectory 在适配器内解声线
  stopSpeaking(): void;
  sendReply(item: QueueItem, text: string): Promise<{ ok: boolean; sentMessageId?: string }>;
  postReceipt(item: QueueItem, transcript: string): Promise<{ ok: boolean; receiptMessageId?: string }>;
  submitApproval(item: QueueItem, transcript: string, receiptMessageId: string): Promise<{ ok: boolean; reason?: string }>;
  persist(state: unknown): void;
  now(): number;
}
```

  纯事件驱动(`handleEvent(ev)`),定时用注入 clock(测试确定性)。
- [x] B1-3.4 场景测:PRD §17 逐字 worked example 全程重放(3 条消息:skip → 要回代发 →
  mid-turn 入队 → ship_gate 条 announce→ask→她说「ship 吧」(APPROVE_INTENT)→ readback
  「你确认把 FLY-901 ship 上线?」→「确认」→ 收据+批准(c 档全链)→ 芝麻关门+确认退出),
  断言 speak/send/approve 调用序列与 PRD 例文逐字对齐(Codex R1 #3:测试必须真测 PRD 例)。
- [x] B1-3.5 commit `feat(voice-core): headphone turn state machine + §17 worked example (FLY-546 B1-3)`

---

## M-B2 voice-headphone daemon(新包,不依赖 545 的 VC 面)

### Task B2-1:包骨架 + 配置

**Files**:Create `packages/voice-headphone/`(package.json/tsconfig/vitest 按 voice-core 模板;
依赖 discord.js 14.26.4(与 FLY-960 pin 同)、voice-core workspace)

- [x] B2-1.1 config 加载(RED→GREEN):`~/.flywheel/headphone.json` + env 覆盖——
  `{ botTokenEnv, coreChannelId, founderUserId, includeRoundtable=false, bridgeUrl, bridgeTokenEnv,
  stateFile=~/.flywheel/headphone-state.json, voices?(Annie 定稿前的显式覆盖), phrases?(词表覆盖) }`;
  缺必填 fail-fast 带装机指引(voice-core config.ts 同风格)。
  **范围合同来自 Bridge**(Codex R1 #4):启动 + 定期刷新调 `GET /api/voice/scope` →
  `{leadBotIds, systemBotIds, scopeChannelIds, roundtableChannelIds, founderIdFingerprint}`
  (Bridge 从 leads[] / chat_threads / generalChannel / 全局 fallback bot 统一推导,daemon 不自行
  ad hoc 推断);founderUserId 与 fingerprint 不一致拒起。
  **语音批准未被 kill-switch 关闭时 bridgeTokenEnv 缺失 → 启动 fail-fast**(Codex R1 #1;
  批准默认 ON——Annie ②,所以默认要求 token 在位)。
- [x] B2-1.2 commit `feat(voice-headphone): package scaffold + config (FLY-546 B2-1)`

### Task B2-2:gateway tap + 入队 + 口令(打字路径)+ 持久化/恢复账本

- [x] B2-2.1 RED(模块驱动,discord.js client 注入 fake):messageCreate → tap-filter →
  `GET /api/voice/context`(缓存;miss/unknown 也入队但报头降级为频道名,降级路径显式测)→
  `GET /api/voice/gate-binding`(scope 频道内 bot 消息均查;命中 → kind=ship_gate 附 gate 字段)
  → queue.push → persist;core 频道 founder 打「芝麻开门」→ mode ON,「芝麻关门」→ FSM confirm_exit。
- [x] B2-2.2 RED(恢复账本,Codex R1 #2):
  ① **离线补漏**:持久化 per-channel `lastSeenMessageId`(snowflake 游标);启动/重连时对每个
  scope 频道/thread 用 Discord history API(`after=cursor`)回填漏听的消息 → 过 tap-filter 入队
  (FIFO 序 = snowflake 序)——**daemon 挂掉期间的消息不静默丢**;
  ② **原子持久化**:状态文件 tmp+fsync+rename、0600、带 schemaVersion;损坏 → 隔离改名 + fail-loud
  (绝不静默清零);
  ③ **副作用幂等**:QueueItem.sideEffects 账本——crash 于 sendReply/postReceipt/submitApproval
  之后、状态推进之前 → 重启按已记录的 sentMessageId/receiptMessageId/approvalAttemptId
  恢复/抑制,**绝不重发代发/收据/批准**;三个 crash-point 各一测。
  **最难 crash 窗口**(Discord 已收、返回 id 尚未 persist——Codex R2 #3):出站消息(代发/收据)
  内嵌确定性幂等标记(含 QueueItem.id,如尾注 `〔hp:{itemId}〕`);重启重试前先按标记扫描该
  频道近期消息,命中即认领已发、只补记 id 不重发;批准侧天然幂等(write-gate-response
  already_answered)。此窗口单独一测。
- [x] B2-2.3 GREEN:组合根 `daemon.ts`(bot id 集合与频道范围全部来自 `/api/voice/scope`,
  见 B2-1;启动摘要打印监听中的 Lead/频道清单,解析失败 fail-loud 不静默漏)。自己 bot 的
  消息恒排除(B1-1 ⑤)。
- [x] B2-2.4 `NullAudioIO`(HeadphoneIO 的本机实现:speak 走 voice-core EdgeTts announce 到本机
  扬声器、sendReply/postReceipt 真发 Discord、submitApproval 真调 Bridge)——**桌面干跑模式**,
  用于开发自测与 QA 干跑;产品路径(VC)在 M-B4。
- [x] B2-2.5 commit `feat(voice-headphone): gateway tap + enqueue + typed passphrase + recovery ledger (FLY-546 B2-2)`

---

## M-B3 Bridge voice 面(teamlead,不依赖 545)

### Task B3-1:voice-approval-source

**Files**:Create `bridge/approval-signal/voice-approval-source.ts`;Test `voice-approval-source.test.ts`

- [x] B3-1.1 RED:`evaluateVoiceSource({gate, utterance:{transcriptId, text, founderUserId}})`:
  founderUserId≠gate.canonicalFounderId → null;text 归一后∈CONFIRM → `{source:"voice",
  kind:"approve", questionId, prHeadSha, transcriptId}`;∈DENY → kind:"reject";其余 → kind:"unclear"。
  **无 Tier-3 分类器**(比 text 源严:c 档是显式确认,含糊即 unclear,绝不猜)。
- [x] B3-1.2 GREEN(签名对齐 text-approval-source 风格,填 types.ts:39-45 预留位)。
- [x] B3-1.3 commit `feat(teamlead): voice approval source — fill the reserved voice slot (FLY-546 B3-1)`

### Task B3-2:voice-routes + 挂载

**Files**:Create `bridge/voice-routes.ts`;Modify `plugin.ts`(`/api` Bearer 中间件之内挂载);
Test `voice-routes.test.ts`(fake StateStore/CommDB,沿 write-gate-response 测试模式)

- [x] B3-2.1 RED(scope,Codex R1 #4):`GET /api/voice/scope` → Bridge 从 leads[](botToken →
  bot user id 解析在 Bridge 侧做)+ 全局 fallback bot(gate-poller 的 `lead.botToken ?? discordBotToken`
  同源)+ chat_threads/phase_chat_threads + chatChannel/generalChannel 推导 →
  `{leadBotIds, systemBotIds, scopeChannelIds, roundtableChannelIds, founderIdFingerprint}`;
  无 Bearer(token 已配)→ 401。
- [x] B3-2.2 RED(context,Codex R1 #5 类型化):`GET /api/voice/context?channelId=X` → 判别返回
  `{kind:"issue_thread", issueId, issueIdentifier, issueTitle, agentId, stage}` |
  `{kind:"lead_channel", agentId}` | `{kind:"unknown"}`(**不拿 404 过载语义**;thread 反查用
  `getChatThreadByThreadId`,phase_chat_threads 侧表兼容;top-level chatChannel 只给 Lead 身份)。
- [x] B3-2.3 RED(gate-binding):`GET /api/voice/gate-binding?messageId=Y` → 按 gateMessageId 反查
  当前绑定(遍历 session_events 的 ship-gate-msg-binding 行,复用 `selectCurrentBinding` fail-closed
  语义:恰一条才返);非绑定消息 → `{bound:false}`。
- [x] B3-2.4 RED(ship-approval):`POST /api/voice/ship-approval`
  body `{gateMessageId, questionId, prHeadSha, transcript:{id,text,atMs}, receiptMessageId}`:
  ⓪ **`config.apiToken` 未配置 → 503 `api_token_required`,在使用任何 body 字段之前**(Codex R1 #1:
  tokenAuthMiddleware 无 token 是 no-op,写 founder 权限的路由不得裸跑——对齐 founder-consent
  gate-response 路由的既有 503 处理;plugin.ts 的 express.json() 是全局前置,故措辞为
  「route body use 之前」而非「解析之前」——Codex R2 #2);token 已配但无/错 Bearer → 401;
  ① `FLYWHEEL_VOICE_APPROVAL=0` → 403 `disabled_by_kill_switch`(**Annie 拍板②:kill-switch
  语义,默认 ON、`=0` 仅急停回滚**,不是灰度 opt-in;enablement 门 = ship 前 QA 真机验证
  founder 归因链。路由始终注册,关时 403 而非 404——FLY-175 R1 gate-route-404 教训);
  ② `FLYWHEEL_FOUNDER_AUTO_APPROVE=0` → 403(尊重总杀开关);③ 绑定反查不恰一致(gateMessageId↔questionId↔prHeadSha 三者互证)→ 409;
  ④ canonical founder id 解析失败 → 403;⑤ `receiptMessageId` 缺失 → 400(**收据先行**,无收据不写);
  ⑥ 全过 → `evaluateVoiceSource` → approve 才 `writeGateResponseAndRunPostWrite(actor=founderId,
  answer '{"approved":true}')`,reject/unclear → 200 `{written:false, kind}`(daemon 据此口头播报);
  ⑦ 每次调用(含拒绝)写 audit session_event `voice-approval-attempt-…`
  (modality=voice、transcript、receiptMessageId、结果、reason)。
- [x] B3-2.5 GREEN + reverse-compat 测(Codex R3 #4 措辞):**flag 缺省 = enabled(不 403)**、
  仅 `FLYWHEEL_VOICE_APPROVAL=0` → 403;apiToken 未配 → 503;新路由的存在不影响任何现有路由;
  全 Bridge 测试套过。
- [x] B3-2.6 commit `feat(teamlead): /api/voice/* routes — scope, context, gate-binding, voice ship-approval (FLY-546 B3-2)`

### Task B3-3:daemon↔Bridge 集成干跑(桌面模式端到端)

- [x] B3-3.1 脚本 `scripts/qa-fly546-desk-dryrun.md`(操作手册,QA 复跑用):测试频道里用测试 bot
  发一条仿 Lead 消息 → daemon 入队 → 本机扬声器报头+正文 → 打字「芝麻关门」确认退出;
  approval 干跑:429 Room/测试 issue 造 awaiting_review + 绑定 → 语音「确认」→ verify-approval
  在该测试 execution 上返 approved:true(证据留存)。
- [x] B3-3.2 commit `docs(FLY-546): desk dry-run recipe`

---

## M-B4 VC 接线(依赖 545 —— **动手前先 ask Tadashi 对齐**)

### Task B4-1:Fly545AudioIO 适配器

**Files**:Create `packages/voice-headphone/src/fly545-audio-io.ts`(实现 `HeadphoneIO` 的
speak/stopSpeaking,+ 订阅 545 的 onFounderUtterance/onFounderSpeakingStart/presence 转 FSM 事件)

- [ ] B4-1.1 **先 `flywheel-comm ask`**:545 的包名/导出面/进程形态(单进程合体 or 双进程),
  按 five-interface 合同(exploration §4,Tadashi 已同步给 545)对齐;545 未落 main 则基于其分支开发。
- [ ] B4-1.2 适配器 + 集成测(545 侧 fake);spoken 口令路径(VC 内说「芝麻开门/关门」)接通;
  presence 暂停/恢复接通;barge-in 延迟走 545 的 interrupt(546 侧无音频缓冲)。
- [ ] B4-1.3 commit `feat(voice-headphone): FLY-545 VC audio adapter (FLY-546 B4-1)`

### Task B4-2:真机 E2E(产品验收路径)

- [ ] B4-2.1 真 Discord + 真 VC:Annie(或 QA 以她授权的测试身份)戴耳机,≥3 条真实 Lead 消息
  跑通 skip/代发/mid-turn 入队;ship_gate 条走语音批准(测试 issue)→ TIV 收据 + verify-approval
  绿。**主退出路径三态真机取证(Codex R3 #2,545 presence 桥是真风险面)**:①59s 内重连 →
  恢复同一条、无重复完结/副作用;②离开 VC 61s → 模式 OFF + core 频道文字 recap + 队列快照
  保留、下次「芝麻开门」续推;③批准态中离场 → 零批准写入(CommDB 无 response 为证)。
  「芝麻关门」+确认退出作为**附加**检查(可选口头路径),不是主验收。
  全程录证据(QA=Opus 独立复跑,不拿 implement 的产物当证据)。

---

## 测试与 QA 策略

- **单测**(vitest,随任务 TDD):FSM 全转移表、tap-filter 真值表、phrases 归一化、queue 持久化、
  voice source 三态、routes 七 guard;reverse-compat 哨兵(A1/A3/B3-2 各一)。
- **集成**:§17 worked example 场景测(B1-3.4)= 本 issue 的合同测试,PRD 措辞变更必须先改它。
- **真机**:桌面干跑(B3-3,不依赖 545)→ VC E2E(B4-2)。QA 独立(Opus),真 Discord E2E 默认必跑。
- **audition**:A4 kit → Lead relay → Annie 拍映射(异步,不阻塞代码线)。

## 风险与协调(承 exploration §6)

1. **545 时序**:M-B4 前置 ask;M-A/B1/B2/B3 全部不等 545。若 545 长期未落地,桌面干跑模式
   (B2-2.3)可先给 Annie 一个非 VC 的可用形态,但**不替代**产品验收(B4-2)。
2. **语音批准 = 真批准、测试通过后默认开**(Annie 拍板②):enablement 门 = ship 前 QA 真机
   验证 founder 归因链(B3-3 批准干跑 + B4-2 E2E);验证过 → ship 即 enabled。
   `FLYWHEEL_VOICE_APPROVAL=0` 仅作紧急回滚 kill-switch,不作灰度开关。
3. **代发接收**:FLY-944 已证 bot @ 可达(research §3);implement B2-2 加一发 Claude-Lead 真机
   冒烟(生产 group 配置差异兜底)。
4. **消息范围**:v1 定义见 research §4;`includeRoundtable` 默认 false;alert 频道不进队列。

## 验收对照(PRD)

- §13:芝麻开门(core 打字/VC 语音)/ 全局转语音 / 退出=离 VC 主路径(60s 防抖)+
  芝麻关门+确认步可选口头路径〔Annie ④ 覆盖 PRD 原「只认口令退出」〕 ✅ B1-3/B2-2/B4-1
- §14:a 档直接做+narrate(代发)/ c 档显式 readback+TIV 收据+现有 gate ✅ B1-3/B3-2
- §17:推不拉/纯 FIFO/一来一回/换 agent 换声线/报头/mid-turn 静默入队/沉默=defer ✅ B1-*/A2
- §15(546 份额):announce 串行不叠音、ack 及时;首音/端点延迟主责在 545 管线
- 北极星:B4-2 真实工作流全程语音推进
