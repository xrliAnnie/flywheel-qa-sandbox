# FLY-2866 Lead 声线写进配置 — 探索
Issue: FLY-2866 (https://linear.app/geoforge3d/issue/FLY-2866/语音声线-按-prd-把每个-lead-的声线写进配置projectsjson-realtimevoice现在-17-个全是-marin)
日期: 2026-09-24
基于: 无

## 问题

`~/.flywheel/projects.json` 里 17 个 Lead 的 `leads[].realtimeVoice` 全是 `marin`（sha256 `311dd85f…fbc0`，2026-09-24 17:1x PDT 读取）。
语音 PRD（FLY-1850）的声线分配从来没有写进配置。founder 2026-09-24 17:09 PDT 要求：先用 GPT Live 实测，再写。

## PRD 分配表（出处逐条）

founder 2026-08-21 听完 FLY-1911 的 10 段样本后给的表，逐字记录在
`product/doc/FLY-1850-headphone-voice-relay/prd.md:2441-2458`（样本页原件在
`product/doc/FLY-1911-codex-voice-prototype/voices/README.md`「她听完十段之后的判断」）。

| 声线 | founder 原话 | 分给 | 出处 |
|---|---|---|---|
| alloy | 低沉冷静的女声 | Honey Lemon（flywheel-product-lead） | prd.md:2443，另见 :2073 |
| marin | 听起来靠谱的中年女声 | 主管 Lead（founder 9-24 确认 = Raya） | prd.md:2449，另见 :2075 |
| verse | 有活力的中年男声 | Tadashi（flywheel-eng-lead） | prd.md:2452，另见 :2074 |
| ash / ballad / cedar / coral / echo / sage / shimmer | 见 prd.md:2444-2451 | **未选** | prd.md:2444-2451 |

另有一条规则：**男性 Lead 用男声**（founder 2026-08-24，prd.md:2063-2076）。它不指定具体声线，但和「PRD 没写就保持 marin」冲突：
原型为男性角色的 Simba（cos-lead）、Hiro（joycon-lead）、Mufasa、Rafiki、Triton（tidal-echo-cos-lead）现在都是 marin（女声）。
本单按工单要求先保持 marin，并把这一冲突交给 founder 决定。

## 17 位 Lead 对照

| agentId | 人设 | PRD 声线 | 打算写成 |
|---|---|---|---|
| flywheel-eng-lead | Tadashi | verse | marin → **verse** |
| flywheel-product-lead | Honey Lemon | alloy | marin → **alloy** |
| raya | Raya | marin | marin（不变） |
| 其余 14 位 | 见 founder 报告页 | PRD 没写 | marin（不变），男性人设 5 位标注待定 |

人设来源：`~/.claude/agents/<agentId>.md`；codex-infra-bot-lead 和 reflection-lead 没有人设名。

## 需要弄清的问题

1. 10 个声线在引擎 A（`gpt-live-1`）和引擎 B（Codex 0.156.1 V2 + `gpt-realtime-2.1`）上能不能用、听起来是否和 founder 8 月听的一样。
2. projects.json 有没有摘要或回执绑定。
3. `realtimeVoice` 什么时候被读取，改完怎样生效。

见 research.md。
