# FLY-2031 Founder R1 后的人话语音 — 设计修订
Issue: FLY-2031 (https://linear.app/geoforge3d/issue/FLY-2031/rayav3-%E9%9A%8F%E8%BA%AB%E8%AF%AD%E9%9F%B3b%E5%B8%B8%E5%BC%80%E6%B5%81-%E5%BF%B5%E8%AF%BB%E7%AD%9B%E9%80%89-%E7%94%A8%E5%98%B4%E6%89%B9-ship)
日期: 2026-08-29
基于: plan.md、founder-round-r1-partial-20260829.md

> **2026-08-30 supersession:** 本文记录 Founder R1 当时的设计推导。其 custom barge-in / 抢话打断部分已被 Founder replacement rework 明确整体删除，当前产品恢复正常逐轮对话；participant/Raya final 与 thinking 状态改由 `VoiceTextMirror` 同路落文字。spoken liveness 删除、人话 brief、重复上限与 `ship_gate` fail-closed 部分仍有效。当前实房权威见 `bot-qa-summary.md` R16；以下 barge-in 章节仅保留审计历史。

## 1. 为什么原设计必须改

Founder 在真实 `voice-test-2` 里给了两条产品级判词：

> 「能不能不要让他再不停的说报个平安了？要是他没有话要说的话就停那就行了，不要再说报个平安了，我要疯了。」

> 「整体还是比较难懂……一串数字需要批准……我不知道他这里在说啥呀……在听的过程中，我很难去判断他这个是怎么回事。」

本修订将判词变成四条硬约束：

1. liveness /「报个平安」彻底不进入语音；没新内容就安静。
2. 念读必须让她只靠听就明白：这是什么事、为什么找她、她要做什么决定。
3. 同一条未确认内容有重复上限与退避，不能连续轰炸。
4. 【已由 2026-08-30 replacement rework 覆盖】R1 当时要求她一开口 Raya 立即停口；当前不再保留自实现抢话层。

本修订覆盖旧 `plan.md` 中所有 spoken liveness、`livenessIntervalMs` 偏好和「可调频率」设计。内部 transport heartbeat 仍负责链路健康，但永不产生语音。

## 2. 采用方案与边界

采用结构化 `speechBrief`，不从旧 `text` 猜写人话：

```ts
interface VoiceSpeechBrief {
  what: string;
  why: string;
  next: string;
}
```

- `text` 与 `refs` 继续作为权威原文、筛选和审计输入，绝不直接送进普通 inbox 语音。
- `question` / `report` / `other` 只有存在结构正确且 speech-safe 的 `speechBrief` 才能出声。
- 每段最多 200 个 Unicode code points；contracts 还必须用完整代表行验证序列化后不超过既有 4,096-byte 原子行上限，字符上限不能替代 byte 上限。
- 三段由确定性 presenter 组成自然短稿：第一句先说 `what`，随后才说 `why` 与 `next`；不念字段名，不让模型猜上下文。还有后续 item 时只加一句自然提示「后面还有 N 件，我接着说」，不恢复旧的方括号标签。
- presenter 返回最终 `text` 与三段正文的精确 `confirmStart` / `confirmEnd`。确认逻辑只能核这个 span，不再在 rendered text 里查找不会出现的原始 `item.text`；转述、截断或只匹配末字符均不得写 `spoken` ack。
- 普通 inbox 的 spoken text 中禁止 issue / PR / action id、UUID、Discord snowflake 等内部标识。开头三秒听不出「是什么事」即不合格。
- `ship_gate` 不使用不受信任的 inbox `text`。它仍从已核验的 context / binding 取 issue title、identifier 与 PR；先讲 title、到 Founder 的原因和她可以说的决定，末句才自然核对一次 identifier + PR。
- relay 不念 `actionId`。先讲要转达的自然意思和为什么会真的发出去，末句才核对目标名与必要编号。

备选方案未采用：

- 单一作者稿字符串无法机械确认三要素都存在。
- 从旧 `text` 用正则或模型改写会丢语义或编造 `why`，不能作为权威动作前语音。

## 3. 不合格 brief 的 fail-closed

缺 `speechBrief`、字段为空、超长或包含内部编号时，普通 item 不得出声，也不得写 `spoken` ack。

- `needsDecision=true`：必须先在 Founder 能看到的 `#raya` 落一条文字，明确「有一件事需要你决定，但语音稿不合格所以没念」，附 bounded / escaped 原始内容，并说明已记录给生产者修正。文字发送成功后写终态 `text_fallback` ack；发送失败则不 ack，下轮只重试文字。
- report / other：至少写 `voice_inbox_brief_rejected` evidence，并以文字提醒生产者；不能用语音补救。文字成功后同样写 `text_fallback`，避免每个 poll 重复提醒。
- evidence 包含 item id、拒绝原因、是否 decision 与文字投递结果，不包含 secret。
- 生产者修正时必须发新 item id；旧坏 item 的终态和原始行保留审计。

这样既不让黑话进耳朵，也不把需要 Founder 决定的事静默吞掉。

## 4. 重复上限与退避

`InboxReader` 为每个 item 维护本 session attempt 状态：

- 硬上限为两次，不能由运行配置提高。
- 第一次 `unconfirmed` / `failed` 后，至少退避 60 秒；退避期内 poll 直接跳过并记录一次 scheduled evidence。
- 第二次仍未确认，则本 session defer，不再自动念；新 process boot 才允许重新尝试。
- 因 Founder / allowlisted QA 用户 barge-in 而中断的 item 立即 defer，本 session 不自动接着念。
- defer 不是 `spoken`，也不是 `filtered`；不伪造终态成功。状态与原因写 evidence，原 inbox item 留待新 session。
- `needsDecision=true` 因 attempt cap / barge-in defer 时，发一次 bounded `#raya` 文字提醒「这件事语音没有确认成功，先留在文字里」并附原始内容；发送成功也不写终态 ack，下个 process boot 仍可重试。文字失败写 evidence，但本 session 不轰炸重发。
- QA 可以把退避缩短以控制测试时长，但不能提高两次上限。

Reader 在一次 poll 内仍先处理 decision，再处理 report；某条失败或 defer 不阻塞后续 item。

## 5. 真正的 barge-in

现实现只把人声送到 realtime 上行，没有清掉 Discord 本地已缓冲的 Raya 音频，也没有中止 code-driven speech 队列。本修订先让授权 barge-in 原子抢占单 owner uplink：flush 前一 owner 的 frame / jitter、切换到当前 user，并返回 `ownsInput=true`；只有实际取得 owner 的人声才允许 arm interruption。这样 Founder 不会在 QA bot 占着 uplink 时只触发静音 latch、却没有 PCM 送进 realtime。

取得 owner 后同步做四件事：

1. `Downlink.interrupt()` 清空 PCM 队列、销毁旧播放 stream 并立即建立静音资源，消除已经缓冲的尾音。
2. runtime 丢弃旧 assistant audio delta，直到当前用户的 final transcript 到达；避免 server-side interruption 生效前的迟到音频重新灌入。
3. `Speaker.interrupt("user-speaking")` 轮换 queue token，中止当前及已排队的 code speech；当前 item 返回 `interrupted`，供 InboxReader 本 session defer。
4. 新 code speech 保持暂停，直到该 user final 之后的 assistant final 完成；这段时间只允许正常对话回答，不允许 inbox / relay / ship 播报抢话。

barge-in 状态不是两个无界 boolean，而是带 `userId`、单调 `deadlineAt` 与 generation 的一份状态：

- current user final 清 audio-delta drop；其后的 current assistant final 清 code-speech hold。
- `speakingEnd` 若尚无 user final，启动 1.5 秒 transcript grace；grace 到期清全部状态并 wake `Speaker`，覆盖咳嗽、假 VAD 与过短音频。
- uplink owner 改变、session generation 改变、teardown 或总时限 30 秒到期，都立即清全部状态并 wake `Speaker`；30 秒是异常兜底，正常短促假 VAD 由 1.5 秒 speaking-end grace 更快释放。
- 每条兜底释放写 `barge_in_released` reason；实现用注入的 monotonic `nowMs` / timer，不用可回拨 wall clock。

授权判据沿用 Founder ID 与 QA allowlist。未授权房客不能借 speaking 事件打断或控制系统。Founder 的 async human check 必须在正常入房 snapshot 时预热；若 speaking epoch 在检查完成前已结束，写 `barge_in_abandoned` 而不是静默跳过。每次打断写 `barge_in_started`、owner preemption、本地尾音清理和被丢弃 delta 计数证据。

## 6. liveness 删除而不是关开关

- runtime 不再构造或启动 `Liveness`；删除 spoken timer、`liveness_triggered` 与 liveness speech path。
- voice options 不再提供可生效的 `livenessIntervalMs`；QA plist 也删除该键。
- voice action 不再接受或保存 `set_pref.livenessIntervalMs`。旧 filter 文件中的遗留字段只用于兼容读取并在下一次写入时丢弃，永远不影响行为。
- 内部 app-server heartbeat、silent uplink frames 与 Discord downlink silence 保持原样；「不出声」不等于「链路停止送帧」。

不存在任何可重新打开 spoken liveness 的产品或 QA 开关。

## 7. 失败路径与安全性

- brief validation 与 rendering 全部确定性完成；不调用模型改写，不信任 inbox `text` 为 spoken copy。
- ship / relay 的 identifier 只能出现在自然稿末句一次，且来自已核验 binding / context 或已授权 Founder transcript；任何 action id、message id、question id、SHA 都不念。
- relay 自然稿仍逐字包含 Founder 要转发的 quoted utterances；confirmation 继续要求目标 lead 名与每条原话实际出现在 assistant final，删除的是 action id 和黑话包装，不是 authority proof。
- ship confirmation 按当前 chunk 的正文核验：只有承载末句的 chunk 才要求 identifier；前序 chunk 不能因为还没出现编号而永久 unconfirmed。
- barge-in 只清音频与 code speech，不撤销已落地 authority，也不把用户说话解释成批准。ship 仍只接受 prompt 后当前 session 的 Founder exact phrase。
- Downlink 中断后继续发送静音帧，常开流硬约束不变。
- evidence sink 失败不能阻止打断或 fail-closed。

## 8. TDD 与交付门

实现必须逐项 RED → GREEN：

1. contracts / presenter：缺 brief、三字段与内部 id；200-code-point + 4,096-byte 双边界；普通稿首句是 `what` 且零 id；精确 confirm span 拒绝转述和截断。
2. decision fail-closed：只有 `#raya` 文字成功才写 `text_fallback`；文字失败不吞 item。
3. repeat：两次上限、60 秒退避、第二次 session defer、barge-in 立即 defer、后续 item 不阻塞。
4. runtime integration：真 `Speaker` + `Downlink` 在取得 uplink owner 后清尾音、丢旧 delta、阻断 code speech；正常 final、speaking-end grace、owner change 和 30 秒 deadline 均能恢复，不能整场静音。
5. ship / relay：开头无编号，三件事齐，编号只在末句自然核对一次，action id 永不出现；relay 原话与多 chunk confirmation 仍 fail-closed。
6. legacy liveness config / pref 存在时仍是零 spoken liveness；heartbeat 与常开静音帧继续。

交付顺序固定：

1. 完成代码和 focused tests。
2. 把六条重写后的 fixture 念读稿以文字发 Lead 审；未批准不进语音房。
3. Lead 文字批准后，用 QA bot 在真实 `voice-test-2` 验证不重复、能插嘴、无黑话，并归档 Opus / transcript / evidence。
4. QA bot 通过后才安排 Founder 第三次进房；Founder 不再是首测。

本单继续留空 B4 挂错单兜底与未知结果自动重发。原本留空的「存活信号默认间隔」不再适用：spoken liveness 已被 Founder 直接删除，不存在需要决定的间隔。
