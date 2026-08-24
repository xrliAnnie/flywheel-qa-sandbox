# ⛔ 这个目录里所有 `rate-v2-*` 文件全部作废 —— 一个都不能当数据

**写这份说明的原因,一句话:那 8 份 manifest 每一份都写着 `outcome: alive`,
看起来像「v2 那条臂八战全胜」。那是假的。**

今天已经有一个字段(`ok`)用完全一样的方式骗过我们一次了。

## 作废范围

**`rate-v2-01` 到 `rate-v2-08` 的全部文件**,包括
`-bridge-manifest.json` / `-bridge.jsonl` / `-bridge-raw.jsonl` / `-bridge.out` /
`-asker-*` / `-asker-room.wav`。

> 这一批是 `rate.sh` 在 2026-08-20T20:44Z 之后跑的那一轮。
> 批次还没跑完时写的这份说明,所以序号会一直排到 08 —— **后出现的同样作废,不需要再确认。**

## 为什么作废(可查,不是判断)

`rate.sh` 给两条臂都传了 `RT_VOICE=cove`,而 **`cove` 是 v1 的音色,不在 v2 的音色表里**。

原件 `evidence/T5-listVoices.json`:
```
v1: juniper maple spruce ember vale breeze arbor sol cove
v2: alloy ash ballad coral echo sage shimmer verse marin cedar   (默认 marin)
```
⇒ v2 的 realtime 会话**从来没有建立起来**。逐字证据(以 `rate-v2-01` 为例):

```
realtimeStartedAt = null
realtimeClosedAt  = null
日志里 "realtime started" 事件出现 0 次
从 READY 那一刻起就在刷 "conversation is not running"(几十条)
userTranscripts / assistantTranscripts / answers 全空,ok = false
```

**今天唯一真正跑通过的那场 v2(`evidence/Y3-v2-alive*`)用的正是 `marin`。**

## 🔴 那个 `outcome: alive` 为什么是假的

`outcome` 的写法是「**没有 `closed` 事件 ⇒ alive**」,**但它没有要求「必须先 `started` 过」**。
⇒ 于是「**从来没起来过**」被报成了「**一直活着**」。

**这是今天第三个同族假绿**(前两个是 `ok` 和 `gotAnswer`)。不变式已经立了:

> **凡是用「某个负向信号没出现」来断定「处于正向状态」的字段,
> 必须同时要求那个【开始事件】出现过。**
> 否则「从来没发生」和「一直很好」在字段里长得一模一样。

## 怎么正确地读这批文件

**不要读 `outcome`。** 用仓库里的事后重算读取器:

```
node <repo>/product/doc/FLY-1911-codex-voice-prototype/evidence/Z4-recompute.mjs ~/.fly1911
```

它按「alive 必须 `realtimeStartedAt` 非空」重算,会把这些场次判成 **`never_started`**,
并在「写的 outcome 与重算不一致」那一节把它们逐个点名。

## 后续

v2 要单独一批重跑,**用 `marin`**。在那批出来之前,
**关于 v2 可靠性的任何结论都没有数据支撑** —— 手上只有 `Y3` 那一场成功,n=1。
